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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DRILL_MARKER,
  extractRootFailure,
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

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const outDir = flag('--out', '');
  const indices = (flag('--flake-indices', '') || '').trim().split(/\s+/).filter(Boolean);

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
  if (current.signatures.length === 0) {
    console.log('no flake signature this week — nothing to escalate');
    return;
  }

  // Prior weeks, grouped by Monday-of-week (so several manual dispatches in
  // one week collapse to a single week instead of faking a streak). Drills
  // and the current run are excluded; weeks are ordered oldest → newest.
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
    if (log.includes(DRILL_MARKER)) continue;
    const sigs = extractBatchFlakeSignatures(log);
    if (!byWeek.has(key)) byWeek.set(key, new Set());
    for (const s of sigs) byWeek.get(key).add(s);
  }
  const previous = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, sigs]) => ({ date, signatures: [...sigs] }));

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
  await execFileAsync('gh', [
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
  console.log('opened mic-regression-escalation issue');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`✗ mic-flake-escalate failed: ${err.message}`);
    process.exit(1);
  });
}
