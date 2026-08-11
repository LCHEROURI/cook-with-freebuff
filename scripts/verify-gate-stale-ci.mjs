#!/usr/bin/env node
// ============================================================================
// scripts/verify-gate-stale-ci.mjs — the CI wrapper that machine-reproves the
// stale-guard gate teeth after each deploy.
//
// After a successful production deploy, live == the pushed commit. The teeth
// proofs (verify-teeth-proofs.mjs gate-stale — `npm run verify:gate-stale-proof`)
// create a throwaway worktree at the pushed commit's PARENT (HEAD~1), then run
// the gate against live from there:
//
//   gate-fail    → live (deployed) ≠ parent → `RESULT: FAIL`        reproduces
//   stale-guard  → live not ancestor of parent → `✗ STALE-HEAD BLOCK` reproduces
//
// So right after a deploy both verdicts reproduce BY CONSTRUCTION — the teeth
// are proven on the real runner, not just via the npm one-liners.
//
// Skip-not-fail on the transient edge: right after a deploy the canonical
// alias can still serve the previous commit (alias promotion lag), or the
// Vercel API can hiccup — in those states the verdicts CANNOT reproduce, so
// the wrapper prints a loud SKIP instead of failing the run. Only a proof
// that can reproduce is allowed to fail.
//
// The skip decision reuses the gate's OWN direction logic — there is no
// duplicated verdict code in this file. The precondition probe runs
// `verify-deployed-hash-gate.mjs --stale-guard --head <parent>` and reads the
// tri-state:
//
//   exit 1 + `✗ STALE-HEAD BLOCK` → live is strictly AHEAD of the parent —
//       the one state where both teeth reproduce → run the proof.
//   exit 0 → live is at or behind the parent (deploy-lag transient) → SKIP.
//   exit 2 → live could not be resolved (token/API transient) → SKIP.
//   exit 1 without the BLOCK line → the gate's own fail-loud "could not
//       determine the live commit" path → SKIP.
//
// Shallow-checkout edge: CI checkouts default to fetch-depth 1, so the parent
// object is usually absent — the wrapper deepens one level from origin before
// resolving HEAD~1, and SKIPs loudly if even that fails (cannot create the
// proof worktree).
//
// The proof is spawned as `node scripts/verify-teeth-proofs.mjs gate-stale` —
// the exact definition behind `npm run verify:gate-stale-proof` — so this
// wrapper stays identical across repos and never needs a package manager
// (the teeth runner and both drivers are stdlib-only, so it runs in jobs
// that skip npm ci entirely).
//// Exit codes: 0 = teeth machine-reproven (or loud SKIP on a transient);
// exit 1 = a teeth regression on the real runner (a verdict did not
// reproduce in a state where it must). Nothing is pushed or deployed by
// this script.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

// ── 1. Resolve the parent commit (HEAD~1) — the worktree the proof runs at. ─
// An env override (VERIFY_GATE_STALE_HEAD) pins the compared-against commit
// so the SKIP path is testable live (point it at the live sha itself).
//
// IMPORTANT: check the exit STATUS, not just the stdout. On a shallow
// checkout `git rev-parse HEAD~1` FAILS (exit 128) but still echoes its input
// revision ('HEAD~1') to stdout — a stdout-only check would treat that echo
// as a resolved parent, skip the deepen below, and run the probe with the
// literal 'HEAD~1' (which can never reproduce a verdict).
const revParent = () => {
  const r = run('git', ['rev-parse', 'HEAD~1'], { cwd: ROOT });
  return r.status === 0 ? r.stdout.trim() : '';
};
let parent = process.env.VERIFY_GATE_STALE_HEAD?.trim() || revParent();
if (!parent) {
  // Shallow checkout (fetch-depth 1): deepen one level so HEAD~1 resolves.
  const deepen = run('git', ['fetch', '--deepen=1', 'origin'], { cwd: ROOT });
  if (deepen.status !== 0) {
    console.log("\nSKIP: gate-stale proof could not resolve the pushed commit's parent (shallow checkout; git fetch --deepen=1 failed).");
    console.log('  The teeth will be machine-re-proven on the next deploy — this skip is not a failure.');
    process.exit(0);
  }
  parent = revParent();
  if (!parent) {
    console.log("\nSKIP: gate-stale proof could not resolve the pushed commit's parent even after deepening.");
    console.log('  The teeth will be machine-re-proven on the next deploy — this skip is not a failure.');
    process.exit(0);
  }
}

// ── 2. Precondition probe: can the verdicts reproduce at all? ──────────────
// The gate's OWN direction-aware logic decides (see header). The probe's
// transcript is echoed on BOTH paths: the proof's own transcript carries the
// detail on the proceed path, and the skip path forwards it so the CI log
// explains WHY it skipped.
const probe = run(process.execPath, ['scripts/verify-deployed-hash-gate.mjs', '--stale-guard', '--head', parent], { cwd: ROOT });
const blocked = probe.status === 1 && out(probe).includes('✗ STALE-HEAD BLOCK');

if (!blocked) {
  // Forward the probe's own transcript so the CI log shows WHY it skipped
  // (deploy-lag verdicts, an API error, a missing sha) instead of a bare
  // SKIP line — the skip must be explainable, never a mystery.
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  const reason =
    probe.status === 0
      ? "live is not yet strictly ahead of the pushed commit's parent (alias promotion lag — the deploy may still be settling)"
      : 'the live commit could not be determined (Vercel API / credential transient)';
  console.log(`\nSKIP: gate-stale proof could not reproduce right after this deploy — ${reason}.`);
  console.log('  The teeth will be machine-re-proven on the next deploy — this skip is not a failure.');
  process.exit(0);
}

// ── 3. The verdicts CAN reproduce — run the full gate-stale proof and ──────
//    propagate its verdict: exit 0 = both teeth reproduced, exit 1 = a teeth
//    regression (a verdict was absent in a state where it must appear).
console.log(`\n=== verify-gate-stale-ci: live is strictly ahead of ${parent.slice(0, 12)} — running the gate-stale proof ===`);
const proof = run(process.execPath, ['scripts/verify-teeth-proofs.mjs', 'gate-stale'], { cwd: ROOT });
if (proof.stdout) process.stdout.write(proof.stdout);
if (proof.stderr) process.stderr.write(proof.stderr);
process.exit(proof.status ?? 1);
