#!/usr/bin/env node
// ============================================================================
// scripts/mic-flake-escalate.mjs — "same flake 3 weeks running" escalation for
// the weekly mic-regression batch.
//
// The batch's flake budget forgives a transient infra failure (e.g. a
// session-launch 503) up to MIC_REGRESSION_FLAKE_BUDGET per week so it cannot
// open a false-positive issue. But a flake that keeps returning, week after
// week, within budget every time, is a persistent infra problem being
// silently forgiven forever. This script closes that blind spot: when the
// SAME flake signature appears in the current week AND in each of the two
// most recent prior weeks, it opens a `mic-regression-escalation` issue
// (deduped against an open one) even though every individual week stayed
// within budget.
//
// Signature: the FIRST `✗ FAIL:` root of a flaked run, normalized to a stable
// key — HTTP route failures collapse to `name → status` (`launch → 503`), and
// anything else collapses whitespace with a bounded length. The signature
// deliberately excludes the JSON body (session ids, timestamps) so the same
// flake matches across weeks.
//
// The verdict is pure and unit-tested; main() is the thin `gh` shell that
// reads the current flaked runs' logs from disk (--out/--flake-indices) and
// the prior weeks' signatures from the UPLOADED phase-c-runs artifacts —
// downloaded and classified from each run's structured phase-c-summary.json +
// driver.log, NOT by grepping the workflow log. Exits 0 whether or not it
// escalates; exits 1 only on a real gather/issue failure (a blind escalation
// check must be loud, never a silent pass).
// ============================================================================

import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  DRILL_MARKER,
  extractRootFailure,
  FLAKE_DRILL_MARKER,
  HARD_PHASE_C_OUTCOMES,
  HARD_SIGNATURES,
} from './refresh-mic-trend.mjs';

const execFileAsync = promisify(execFile);

// GITHUB_REPOSITORY is set in Actions; fall back for local runs. Deliberately
// NOT derived via `gh repo view` at import time so importing the module in a
// test never shells out.
const REPO = process.env.GITHUB_REPOSITORY || 'LCHEROURI/cook-with-freebuff';

const gh = async (args) => {
  const { stdout } = await execFileAsync('gh', [...args, '--repo', REPO], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Normalize a flaked run's root failure into a stable signature.
 *
 * @param {string} log a flaked run's log
 * @returns {string|null} `name → status` for HTTP route failures, a bounded
 *   collapsed message otherwise, or null when the log carries no failure.
 */
export function extractFlakeSignature(log) {
  const root = extractRootFailure(log);
  if (!root) return null;
  const line = root.replace(/^✗ FAIL:\s*/, '').trim();
  // `launch → 503 {"error":...}` collapses to `launch → 503` — the body holds
  // session ids/timestamps that must not fragment the week-to-week match.
  const http = line.match(/^(.+?)\s*→\s*(\d{3})\b/);
  if (http) return `${http[1].trim()} → ${http[2]}`;
  return line.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Classify ONE per-run artifact into its flake signature — or null when the
 * run was a pass or a hard (never-budgeted) failure. `log` is the per-run
 * driver.log text; `summary` is the phase-c-summary.json TEXT (null when the
 * run crashed before the shared-exit summary write — exactly the pre-mic /
 * infra flake case, e.g. a session-launch 503).
 *
 * Mirrors the batch step's classification order, but reads the structured
 * artifact instead of grepping the workflow log:
 *   1. RESULT: PASS (exit 0) → pass, not a flake
 *   2. structured hard outcome → hard, not a flake
 *   3. hard-signature grep → hard (a crash before the summary write still
 *      printed its monitored-contract failure line)
 *   4. else → flake (extract the root ✗ FAIL: signature)
 *
 * @param {{ log: string, summary: string|null }} run one artifact run dir
 * @returns {string|null} the flake signature, or null when not a flake
 */
export function classifyRunFlake({ log, summary }) {
  if (/RESULT: PASS/.test(log)) return null;
  let outcome = null;
  if (summary != null) {
    try {
      outcome = JSON.parse(summary)?.outcome ?? null;
    } catch {
      outcome = null; // corrupt summary — fall through to the log signals
    }
  }
  if (outcome && HARD_PHASE_C_OUTCOMES.includes(outcome)) return null;
  if (HARD_SIGNATURES.some((s) => log.includes(s))) return null;
  return extractFlakeSignature(log);
}

/**
 * Split a downloaded phase-c-runs artifact dir into its six per-run dirs and
 * collect the flake signatures of every non-pass, non-hard run. A drill batch
 * (force_stuck_blob / force_flake_streak) is a rehearsal, not a measurement —
 * its injected signatures must never count — so any per-run log carrying a
 * drill marker excludes the WHOLE batch.
 *
 * @param {string} baseDir the dir `gh run download` extracted the artifact to
 * @returns {{ drill: boolean, signatures: string[] }} unique flake signatures
 *   (empty when the batch had none), or { drill: true } for a drill batch
 */
export function extractArtifactBatchFlakeSignatures(baseDir) {
  const sigs = new Set();
  for (let i = 1; i <= 6; i++) {
    const dir = join(baseDir, `run-${i}`);
    let log;
    try {
      log = readFileSync(join(dir, 'driver.log'), 'utf8');
    } catch {
      continue; // a run whose log never landed (e.g. tee open failed) — skip
    }
    if (log.includes(DRILL_MARKER) || log.includes(FLAKE_DRILL_MARKER)) {
      return { drill: true, signatures: [] };
    }
    let summary = null;
    try {
      summary = readFileSync(join(dir, 'phase-c-summary.json'), 'utf8');
    } catch {
      // no summary = the run crashed before the shared-exit write (a flake).
    }
    const sig = classifyRunFlake({ log, summary });
    if (sig) sigs.add(sig);
  }
  return { drill: false, signatures: [...sigs] };
}

/**
 * Download a prior run's uploaded phase-c-runs artifact into destDir via
 * `gh run download`. Returns true when the artifact downloaded; false when it
 * is unavailable (expired past retention, or a self-cleaned drill run whose
 * cleanup already deleted it) — the run is then skipped because it cannot be
 * classified from the structured record.
 *
 * @param {string} runId the Actions run databaseId
 * @param {string} destDir an empty destination dir
 * @returns {Promise<boolean>}
 */
async function downloadBatchArtifact(runId, destDir) {
  try {
    await execFileAsync('gh', [
      'run',
      'download',
      String(runId),
      '--name',
      'phase-c-runs',
      '--dir',
      destDir,
      '--repo',
      REPO,
    ]);
    return true;
  } catch (err) {
    console.log(
      `!! run ${runId}: phase-c-runs artifact unavailable (${err.message}) — skipping (cannot classify from the structured record)`,
    );
    return false;
  }
}

/**
 * Pure escalation verdict: escalate when a signature appears in the current
 * week AND in each of the two most recent prior weeks (a 3-week streak).
 *
 * @param {{
 *   current: { date: string, signatures: string[] },
 *   previous: { date: string, signatures: string[] }[],
 * }} opts previous weeks ordered oldest → newest (excluding the current week)
 * @returns {{ escalate: boolean, signature: string|null, dates: string[] }}
 */
export function flakeEscalationVerdict({ current, previous }) {
  const recent = previous.slice(-2);
  if (recent.length < 2) return { escalate: false, signature: null, dates: [] };
  for (const sig of current.signatures) {
    if (recent.every((w) => w.signatures.includes(sig))) {
      return {
        escalate: true,
        signature: sig,
        dates: [...recent.map((w) => w.date), current.date],
      };
    }
  }
  return { escalate: false, signature: null, dates: [] };
}

/** Monday-of-week key for a UTC ISO timestamp (Mon anchors the streak week). */
export function weekKeyOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * The prior-week gather window: the Monday two weeks before the current
 * Monday. flakeEscalationVerdict reads only previous.slice(-2) (the two most
 * recent prior weeks), so a contiguous 3-week streak can never span anything
 * older — and main() must not download/classify artifacts for runs outside
 * this window (a `gh run download` per ancient run is wasted shell-out).
 *
 * @param {string} monday a Monday-of-week ISO date (as weekKeyOf returns)
 * @returns {string} the Monday two weeks earlier
 */
export function streakWindowStart(monday) {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}

/**
 * Drill seam: synthesize the two prior weeks carrying the SAME flake
 * signature so the real verdict + issue path can be proven in a single
 * dispatch. Real prior-week history cannot be injected retroactively, so a
 * force_flake_streak drill seeds the streak deterministically from the
 * current week's Monday and the injected signature; `flakeEscalationVerdict`
 * and the `gh` issue path then run exactly as they do for a real streak.
 *
 * @param {string} currentMonday Monday-of-week ISO date of the current week
 * @param {string} signature the injected flake signature
 * @returns {{ date: string, signatures: string[] }[]} two prior weeks, oldest first
 */
export function seedDrillPriorWeeks(currentMonday, signature) {
  const weeksAgo = (n) => {
    const d = new Date(`${currentMonday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * n);
    return d.toISOString().slice(0, 10);
  };
  return [
    { date: weeksAgo(2), signatures: [signature] },
    { date: weeksAgo(1), signatures: [signature] },
  ];
}

/**
 * Parse the flake signature out of an escalation issue title. The title is
 * `Mic regression: same flake “<signature>” 3 weeks running` (created by main
 * below) — a title edited away from that shape returns null and is left open
 * rather than mis-closed.
 *
 * @param {string} title the issue title
 * @returns {string|null} the flake signature, or null when the title is
 *   unrecognized
 */
export function signatureFromTitle(title) {
  const m = /same flake “(.+?)” 3 weeks running/.exec(title ?? '');
  return m ? m[1] : null;
}

/**
 * Auto-close verdict: an escalation issue for `signature` self-heals when a
 * subsequent week's batch no longer carries that signature (the flake is
 * gone). Absent-from-current is sufficient — the issue was opened for a
 * 3-week streak, so one clean week breaks it.
 *
 * @param {{ signature: string, current: { signatures: string[] } }} opts
 * @returns {boolean} true when the flake is gone this week
 */
export function flakeHealedVerdict({ signature, current }) {
  return !current.signatures.includes(signature);
}

/**
 * Parse the streak weeks out of an escalation issue body. The body carries
 * `- **Weeks:** 2026-08-03 → 2026-08-10 → 2026-08-17` (written by
 * escalateStreak below) — a body edited away from that shape yields an empty
 * list, which the /status page renders as an unknown-length streak rather than
 * a fabricated one.
 *
 * @param {string} body the issue body
 * @returns {string[]} the streak weeks (Monday dates), oldest first
 */
export function parseStreakWeeks(body) {
  const line = String(body ?? '').split('\n').find((l) => l.includes('**Weeks:**'));
  if (!line) return [];
  const rest = line.slice(line.indexOf('**Weeks:**') + '**Weeks:**'.length).trim();
  return rest.split('→').map((s) => s.trim()).filter(Boolean);
}

const flakeStreakSchema = z.object({
  active: z.boolean(),
  recurringCount: z.number().int().nonnegative(),
  signature: z.string().nullable(),
  weeks: z.array(z.string()),
  ranAt: z.string().min(1),
  runUrl: z.string(),
});

/**
 * Build the `deploy_status/flake_streak` doc the /status page reads: the
 * CURRENT active streak, derived from the open escalation issues (title for
 * the signature, body for the weeks). Schema-validated before persisting —
 * same discipline as record-verify-status.mjs.
 *
 * @param {{ openIssues: { title: string, body?: string }[], ranAt: string, runUrl: string }} opts
 */
export function buildFlakeStreakDoc({ openIssues, ranAt, runUrl }) {
  const first = openIssues[0] ?? null;
  return flakeStreakSchema.parse({
    active: openIssues.length > 0,
    recurringCount: openIssues.length,
    signature: first ? signatureFromTitle(first.title) : null,
    weeks: first ? parseStreakWeeks(first.body ?? '') : [],
    ranAt,
    runUrl,
  });
}

/**
 * Auto-close healed escalation issues: an open `mic-regression-escalation`
 * issue self-heals once a subsequent week's batch no longer carries its flake
 * signature (the streak broke). Titles that no longer match the created shape
 * are left open — a mis-close is worse than a lingering alert.
 *
 * @param {{ date: string, signatures: string[] }} current this week's flake set
 */
async function autoCloseHealedIssues(current) {
  const open = JSON.parse(
    await gh(['issue', 'list', '--label', 'mic-regression-escalation', '--state', 'open', '--json', 'number,title']),
  );
  for (const issue of open) {
    const signature = signatureFromTitle(issue.title);
    if (!signature) continue;
    if (!flakeHealedVerdict({ signature, current })) continue;
    await execFileAsync('gh', [
      'issue',
      'comment',
      String(issue.number),
      '--repo',
      REPO,
      '--body',
      `Closing automatically: the flake “${signature}” was absent from this week's batch — the streak has healed.`,
    ]);
    await execFileAsync('gh', ['issue', 'close', String(issue.number), '--repo', REPO]);
    console.log(`auto-closed healed escalation issue #${issue.number} (flake “${signature}” gone this week)`);
  }
}

/**
 * Record the CURRENT active flake streak to `deploy_status/flake_streak` for
 * the /status page. Reads the open escalation issues (title + body) so the doc
 * reflects reality — a just-opened issue OR a pre-existing one. Writes with the
 * admin SDK: the escalation step runs in the same job as the driver, so
 * FIREBASE_SERVICE_ACCOUNT is already present. A missing credential skips
 * loudly rather than crashing the escalation itself.
 */
async function recordFlakeStreakToFirestore() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log('FIREBASE_SERVICE_ACCOUNT missing — skipping the flake-streak status write');
    return;
  }
  const open = JSON.parse(
    await gh(['issue', 'list', '--label', 'mic-regression-escalation', '--state', 'open', '--json', 'number,title,body']),
  );
  const base = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = `${base}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const doc = buildFlakeStreakDoc({ openIssues: open, ranAt: new Date().toISOString(), runUrl });

  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = getApps()[0] ?? initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'),
    }),
  });
  await getFirestore(app).collection('deploy_status').doc('flake_streak').set(doc);
  console.log(`recorded flake-streak state (active=${doc.active}, recurring=${doc.recurringCount}) → deploy_status/flake_streak`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const outDir = flag('--out', '');
  const indices = (flag('--flake-indices', '') || '').trim().split(/\s+/).filter(Boolean);
  const drillStreak = args.includes('--drill-streak');

  // The current week's flake signatures, read from THIS run's logs on disk.
  const currentSigs = new Set();
  for (const i of indices) {
    const log = readFileSync(join(outDir, `run-${i}`, 'driver.log'), 'utf8');
    const sig = extractFlakeSignature(log);
    if (sig) currentSigs.add(sig);
  }
  const current = {
    date: weekKeyOf(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10),
    signatures: [...currentSigs],
  };

  // Auto-close healed escalations FIRST (real monitor only, never a drill):
  // an open escalation issue self-heals once a subsequent week no longer
  // shows its flake, so the alert does not linger open after the outage ends.
  if (!drillStreak) {
    await autoCloseHealedIssues(current);
  }

  if (current.signatures.length === 0) {
    console.log('no flake signature this week — nothing to escalate');
  } else {
    // Prior weeks, grouped by Monday-of-week (so several manual dispatches in
    // one week collapse to a single week instead of faking a streak). Drills
    // and the current run are excluded; weeks are ordered oldest → newest.
    let previous;
    if (drillStreak) {
      // A single dispatch can only write THIS week's log; the two prior weeks'
      // history cannot be retroactively injected. Seed them with the SAME flake
      // signature so the REAL verdict + issue path fire end-to-end.
      previous = seedDrillPriorWeeks(current.date, current.signatures[0]);
      console.log(`drill: seeding two prior weeks with the same flake signature “${current.signatures[0]}”`);
    } else {
      const currentRunId = process.env.GITHUB_RUN_ID ?? '';
      // The verdict reads only the two most recent prior weeks
      // (previous.slice(-2)), so filter the run list to the streak window
      // BEFORE downloading: the escalation step never shells out `gh run
      // download` for artifacts of ancient or irrelevant runs (a run older
      // than the window cannot be part of a contiguous 3-week streak).
      const streakStart = streakWindowStart(current.date);
      const runs = JSON.parse(
        await gh(['run', 'list', '--workflow', 'mic-regression.yml', '--limit', '200', '--json', 'databaseId,conclusion,createdAt']),
      ).filter((r) => {
        const key = weekKeyOf(r.createdAt);
        return key && key >= streakStart && key < current.date;
      });
      // Prior weeks are classified from the UPLOADED structured record (each
      // run's phase-c-summary.json + driver.log), not by grepping the workflow
      // log — so a historical flake uses the same structured classification
      // the live batch step applies. Each run downloads into its own dir under
      // a scratch base so runs can't collide.
      const scratch = mkdtempSync(join(tmpdir(), 'mic-flake-artifacts-'));
      const byWeek = new Map();
      for (const r of runs) {
        if (String(r.databaseId) === currentRunId) continue;
        if (r.conclusion !== 'success' && r.conclusion !== 'failure') continue;
        const key = weekKeyOf(r.createdAt);
        const dest = join(scratch, String(r.databaseId));
        if (!(await downloadBatchArtifact(r.databaseId, dest))) continue;
        const { drill, signatures } = extractArtifactBatchFlakeSignatures(dest);
        if (drill) continue;
        if (!byWeek.has(key)) byWeek.set(key, new Set());
        for (const s of signatures) byWeek.get(key).add(s);
      }
      previous = [...byWeek.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, sigs]) => ({ date, signatures: [...sigs] }));
    }
    await escalateStreak(current, previous);
  }

  // Record the CURRENT active-streak state for the /status page (real monitor
  // only — a drill's synthetic streak must never pollute the at-a-glance view).
  if (!drillStreak) {
    await recordFlakeStreakToFirestore();
  }
}

/**
 * Open (or dedupe) the escalation issue for a verified 3-week flake streak.
 */
async function escalateStreak(current, previous) {
  const verdict = flakeEscalationVerdict({ current, previous });
  if (!verdict.escalate) {
    console.log(
      `no 3-week flake streak (${current.signatures.length} signature(s) this week; ${previous.length} prior week(s) with a recorded batch)`,
    );
    return;
  }

  console.log(`escalating: same flake “${verdict.signature}” 3 weeks running (${verdict.dates.join(' → ')})`);
  const base = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = `${base}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const artifactUrl = `${runUrl}/artifacts`;

  await execFileAsync('gh', ['label', 'create', 'mic-regression-escalation', '--force', '--repo', REPO]);
  const existing = JSON.parse(
    await gh(['issue', 'list', '--label', 'mic-regression-escalation', '--state', 'open', '--json', 'number']),
  );
  if (existing.length > 0) {
    console.log('an open mic-regression-escalation issue already exists — skipping (dedupe)');
    return;
  }

  const body = [
    'The same infra flake stayed within the weekly flake budget for 3 weeks running, so it was being silently forgiven — escalated to an alert.',
    '',
    `- **Flake:** \`${verdict.signature}\``,
    `- **Weeks:** ${verdict.dates.join(' → ')}`,
    `- **Run:** ${runUrl}`,
    `- **Artifacts:** ${artifactUrl}`,
    '',
    'Each individual week was within budget, but a persistent flake must not be forgiven forever. Investigate the recurring infra failure (this is NOT a two-burst mic regression) before dismissing.',
  ].join('\n');
  const { stdout: issueUrl } = await execFileAsync('gh', [
    'issue',
    'create',
    '--repo',
    REPO,
    '--title',
    `Mic regression: same flake “${verdict.signature}” 3 weeks running`,
    '--label',
    'mic-regression-escalation',
    '--body',
    body,
  ]);
  const issueNumber = issueUrl.trim().split('/').pop();
  console.log(`opened mic-regression-escalation issue #${issueNumber}`);
  // Surface the created issue number so the workflow's drill cleanup can close
  // EXACTLY this issue — never a real one that happens to be open.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `created_issue=${issueNumber}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`✗ mic-flake-escalate failed: ${err.message}`);
    process.exit(1);
  });
}
