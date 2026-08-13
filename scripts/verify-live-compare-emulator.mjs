#!/usr/bin/env node
// ============================================================================
// scripts/verify-live-compare-emulator.mjs — prove the LOCAL emulator stack
// reproduces the DEPLOYED stack's deterministic guided flow, offline on the
// local side.
//
// Two legs run the SAME deterministic guided flow (seed recipe → owner token
// → launch → prep steps → safety gate → timer), which is stages [1]–[3] of
// scripts/verify-live.mjs and the only part the emulator mode runs:
//
//   DEPLOYED  — npm run verify:live             (production Firestore + Auth)
//   EMULATOR  — npm run verify:live:emulator    (local Firestore + Auth, no
//                production traffic)
//
// The comparison is on the SEVEN shared guided-flow status lines only (the
// deterministic steps both legs emit identically). The deployed leg's extra
// Gemini/Chrome/App-Hosting stages and the emulator leg's create-user/SKIP
// lines are all ignored — they are leg-specific, not part of the shared
// contract. Ephemeral content (seeded recipe ids, owner uids) is normalized
// before diffing, so a divergence that matters — a guided-flow step that
// passed on one stack and failed (or ordered differently) on the other —
// fails the comparison.
//
// Usage:
//   npm run verify:live:compare:emulator
//
// Exit 0 = both stacks agree on the guided flow; 1 = a leg failed or the
// shared lines diverged. The deployed leg requires .env.local (real creds);
// the emulator leg is self-contained (Java 21+ for the Firestore emulator).
// ============================================================================

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ FAIL: ${m}`); process.exitCode = 1; };
const note = (m) => console.log(`  - ${m}`);

// The seven deterministic guided-flow steps ([1]–[3] in verify-live.mjs) that
// both legs emit verbatim. Each marker appears exactly once per transcript, so
// matching in order yields the two comparable sequences; every other status
// line (the deployed leg's starter/Gemini/Chrome/App-Hosting stages, the
// emulator leg's create-user + SKIP lines) is excluded by design.
const SHARED_MARKERS = [
  'seeded (owner ',                              // ✓ recipe verify-live-N seeded (owner <uid>)
  'owner ID token minted',                       // ✓ owner ID token minted
  'launch → PREP_GUIDANCE',                      // ✓ launch → PREP_GUIDANCE (“Dice the onion”)
  'starts at prep step 1',                       // ✓ starts at prep step 1
  'done → prep step 2',                          // ✓ done → prep step 2
  'safety gate surfaced',                        // ✓ safety gate surfaced: “…” (step preserved at 2)
  'gate acknowledged → timer auto-started',      // ✓ gate acknowledged → timer auto-started (“…”)
];

const STATUS_RE = /^\s*(✓|✗)/;
const NORMALIZE = [
  [/verify-live-\d+/g, 'verify-live-N'],
  [/\(owner [^)]+\)/g, '(owner <uid>)'],
  [/in \d+ms/g, 'in Nms'],
];

/** Run a command, streaming its output to the terminal AND capturing it. */
function run(label, cmd, args) {
  console.log(`\n=== ${label} ===`);
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let transcript = '';
    const collect = (buf) => {
      const text = buf.toString();
      transcript += text;
      process.stdout.write(text); // live progress (the deployed leg is slow)
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => resolveRun({ code: code ?? 1, transcript }));
  });
}

/** Extract the shared guided-flow status lines, normalized, in order. */
function extractSharedLines(transcript) {
  const out = [];
  for (const line of transcript.split('\n')) {
    const trimmed = line.trimEnd();
    if (!STATUS_RE.test(trimmed)) continue;
    if (!SHARED_MARKERS.some((m) => trimmed.includes(m))) continue;
    out.push(NORMALIZE.reduce((s, [re, to]) => s.replace(re, to), trimmed));
  }
  return out;
}

const DEPLOYED = await run(
  'deployed — npm run verify:live -- --guided-only (production Firestore + Auth, deterministic flow only)',
  'npm',
  ['run', 'verify:live', '--', '--guided-only'],
);
const EMULATOR = await run(
  'emulator — npm run verify:live:emulator (local Firestore + Auth, offline)',
  'npm',
  ['run', 'verify:live:emulator'],
);

const deployedLines = extractSharedLines(DEPLOYED.transcript);
const emulatorLines = extractSharedLines(EMULATOR.transcript);

console.log(`\n=== guided-flow comparison ===`);
console.log(`  deployed: ${deployedLines.length} shared steps`);
console.log(`  emulator: ${emulatorLines.length} shared steps`);

if (!/RESULT: PASS/.test(DEPLOYED.transcript) || DEPLOYED.code !== 0) {
  fail(`deployed run did not PASS (exit ${DEPLOYED.code})`);
}
if (!/RESULT: PASS/.test(EMULATOR.transcript) || EMULATOR.code !== 0) {
  fail(`emulator run did not PASS (exit ${EMULATOR.code})`);
}

if (deployedLines.length !== SHARED_MARKERS.length) {
  fail(`deployed run emitted ${deployedLines.length} of ${SHARED_MARKERS.length} shared guided-flow steps`);
}
if (emulatorLines.length !== SHARED_MARKERS.length) {
  fail(`emulator run emitted ${emulatorLines.length} of ${SHARED_MARKERS.length} shared guided-flow steps`);
}

let diverged = false;
const max = Math.max(deployedLines.length, emulatorLines.length);
for (let i = 0; i < max; i++) {
  const d = deployedLines[i];
  const l = emulatorLines[i];
  if (d === l) continue;
  diverged = true;
  fail(`guided-flow step ${i + 1} diverged:`);
  console.log(`    deployed: ${d ?? '(missing)'}`);
  console.log(`    emulator: ${l ?? '(missing)'}`);
}

if (!diverged && process.exitCode === undefined && max === SHARED_MARKERS.length) {
  ok(`both stacks agree on all ${SHARED_MARKERS.length} guided-flow steps`);
  console.log('\nRESULT: PASS — the emulator stack reproduces the deployed guided flow');
  process.exit(0);
}
console.log('\nRESULT: FAIL — the emulator and deployed stacks disagree on the guided flow');
process.exit(1);
