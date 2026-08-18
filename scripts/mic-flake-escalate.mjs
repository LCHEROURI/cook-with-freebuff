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
// the prior weeks' signatures from Actions history. Exits 0 whether or not it
// escalates; exits 1 only on a real gather/issue failure (a blind escalation
// check must be loud, never a silent pass).
// ============================================================================

import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DRILL_MARKER,
  extractRootFailure,
  FLAKE_DRILL_MARKER,
  HARD_SIGNATURES,
  RUN_MARKER,
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
 * Split one full batch log into its six per-run segments and collect the flake
 * signatures of every non-pass, non-hard segment (a hard two-burst failure is
 * never a flake and never escalates).
 *
 * @param {string} log a full mic-regression batch log
 * @returns {string[]} unique flake signatures (empty when the week had none)
 */
export function extractBatchFlakeSignatures(log) {
  const segments = log.split(RUN_MARKER).slice(1);
  const sigs = new Set();
  for (const seg of segments) {
    if (/RESULT: PASS/.test(seg)) continue;
    if (HARD_SIGNATURES.some((s) => seg.includes(s))) continue;
    const sig = extractFlakeSignature(seg);
    if (sig) sigs.add(sig);
  }
  return [...sigs];
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
    return;
  }

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
    const runs = JSON.parse(
      await gh(['run', 'list', '--workflow', 'mic-regression.yml', '--limit', '200', '--json', 'databaseId,conclusion,createdAt']),
    );
    const byWeek = new Map();
    for (const r of runs) {
      if (String(r.databaseId) === currentRunId) continue;
      if (r.conclusion !== 'success' && r.conclusion !== 'failure') continue;
      const key = weekKeyOf(r.createdAt);
      if (!key || key >= current.date) continue;
      const log = await gh(['run', 'view', String(r.databaseId), '--log']);
      if (log.includes(DRILL_MARKER) || log.includes(FLAKE_DRILL_MARKER)) continue;
      const sigs = extractBatchFlakeSignatures(log);
      if (!byWeek.has(key)) byWeek.set(key, new Set());
      for (const s of sigs) byWeek.get(key).add(s);
    }
    previous = [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, sigs]) => ({ date, signatures: [...sigs] }));
  }

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
