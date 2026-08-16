#!/usr/bin/env node
// ============================================================================
// scripts/verify-live-compare.mjs — diff the local dev stack against the
// DEPLOYED stack on the full verify:live lifecycle.
//
// Both stacks run the SAME check (scripts/verify-live.mjs): seed owner recipe
// → owner token → guided /api/cook flow (launch → prep → safety gate →
// timer) → pantry add → confirm → query → remove → follow-up query →
// Gemini turn → cleanup. Local runs it against a freshly booted `next dev`
// (via verify-live-local.mjs); deployed runs it against the canonical
// https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app.
//
// The comparison is on the STATUS LINES only (✓ / ✗ FAIL / RESULT:), which
// are emitted exclusively by verify-live — the driver's own boot/warm/
// teardown noise is filtered out. Ephemeral content is normalized before
// diffing: seeded recipe ids (verify-live-<ts>), per-request timings
// (in <n>ms), the variable Gemini reply text, and the target URL — so a
// divergence that matters (a check that passed on one stack and failed on
// the other, or a missing/extra line) fails the comparison.
//
// Usage:
//   npm run verify:live:compare
//
// Exit 0 = both stacks agree on the full lifecycle; 1 = a status line
// diverged or a run failed. Requires .env.local (see verify-live.mjs).
// ============================================================================

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ FAIL: ${m}`); process.exitCode = 1; };

/** Run a command, capturing stdout+stderr. Resolves { code, transcript }. */
function run(label, cmd, args) {
  console.log(`\n=== ${label} ===`);
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let transcript = '';
    const collect = (buf) => { transcript += buf.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => resolveRun({ code: code ?? 1, transcript }));
  });
}

/**
 * Extract the verify-live status lines from a transcript. Only ✓ / ✗ FAIL /
 * RESULT: lines qualify (they come exclusively from verify-live.mjs — the
 * driver's own ✓ notes about boot/warm/teardown match DRIVER_NOISE and are
 * dropped), then ephemeral content is normalized so both stacks compare
 * fairly.
 */
const STATUS_RE = /^\s*(✓|✗|RESULT:)/;
// Lines that look like status lines but are NOT verify-live output: the local
// driver's own ✓ notes (dev server boot, warm-up, teardown) AND the dev
// server's own compiler chatter ("✓ Compiled / in Nms (587 modules)",
// "✓ Ready in ..."), which leaks in because verify-live-local inherits its
// stdio. Both must be dropped so only verify-live status lines compare.
const DRIVER_NOISE = /dev server|[Cc]ompiled|verify:live:local|teardown|===|Ready in|Starting|modules\)/;
const NORMALIZE = [
  // The deployed leg seeds `verify-live-<ts>` and the local leg seeds
  // `verify-local-<ts>` (its own namespace, see verify-live-local.mjs) — both
  // normalize to the same token so the diff compares structure, not the
  // run-specific probe namespace. The `-starter-` variants are the renamed
  // create_recipe probes.
  [/verify-(?:live|local)-\d+/g, 'verify-live-N'],
  [/verify-(?:live|local)-starter-\d+/g, 'verify-live-starter-N'],
  [/in \d+ms/g, 'in Nms'],
  [/Gemini answered: “.+?…”/g, 'Gemini answered: “…”'],
  [/\S+\.hosted\.app|localhost:\d+/g, '<host>'],
  [/\(owner [A-Za-z0-9]+\)/g, '(owner <uid>)'],
];

function extractStatusLines(transcript) {
  return transcript
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => STATUS_RE.test(l) && !DRIVER_NOISE.test(l))
    .map((l) => NORMALIZE.reduce((s, [re, to]) => s.replace(re, to), l));
}

const DEPLOYED = await run('deployed  — npm run verify:live (production URL)', 'npm', ['run', 'verify:live']);
const LOCAL = await run(
  'local     — npm run verify:live:local (boots next dev on :3100, runs, tears down)',
  'npm',
  ['run', 'verify:live:local'],
);

const deployedLines = extractStatusLines(DEPLOYED.transcript);
const localLines = extractStatusLines(LOCAL.transcript);

console.log(`\n=== transcript comparison ===`);
console.log(`  deployed: ${deployedLines.length} status lines`);
console.log(`  local:    ${localLines.length} status lines`);

if (DEPLOYED.code !== 0) fail(`deployed run exited ${DEPLOYED.code}`);
if (LOCAL.code !== 0) fail(`local run exited ${LOCAL.code}`);

let diverged = false;
const max = Math.max(deployedLines.length, localLines.length);
for (let i = 0; i < max; i++) {
  const d = deployedLines[i];
  const l = localLines[i];
  if (d === l) continue;
  diverged = true;
  fail(`line ${i + 1} diverged:`);
  console.log(`    deployed: ${d ?? '(missing)'}`);
  console.log(`    local:    ${l ?? '(missing)'}`);
}

if (!diverged && process.exitCode === undefined) {
  console.log(`\n  ✓ both stacks agree on the full lifecycle (${deployedLines.length} lines identical)`);
  console.log('\nRESULT: PASS');
  process.exit(0);
} else if (diverged) {
  console.log('\nRESULT: FAIL — local and deployed disagree on the lifecycle');
  process.exit(1);
}
