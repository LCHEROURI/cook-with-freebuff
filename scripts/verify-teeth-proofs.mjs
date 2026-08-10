#!/usr/bin/env node
// ============================================================================
// scripts/verify-teeth-proofs.mjs — run the README teeth proofs as one
// command each, no copy-paste from the README.
//
//   node scripts/verify-teeth-proofs.mjs gate-fail      # Gate FAIL path
//   node scripts/verify-teeth-proofs.mjs stale-guard    # CI stale-guard mode
//   node scripts/verify-teeth-proofs.mjs hook-block     # Hook BLOCK path
//   node scripts/verify-teeth-proofs.mjs gate-stale     # BOTH gate teeth in one
//   node scripts/verify-teeth-proofs.mjs teeth-proofs   # ALL three teeth in one
//
// Each mode reproduces one of the README "Re-proving the gate's teeth"
// one-liners programmatically: it creates a throwaway DETACHED worktree at
// HEAD~1 (the live site is always at or ahead of recent commits, so the
// comparison necessarily mismatches), runs the check inside it, forwards the
// full transcript, and ALWAYS removes the worktree — including on failure.
//
// The expected verdict string per mode is ASSERTED, so the script is a real
// proof, not just a runner:
//
//   gate-fail    → expects `RESULT: FAIL`          (npm run verify:deployed-hash)
//   stale-guard  → expects `✗ STALE-HEAD BLOCK`    (gate --stale-guard)
//   hook-block   → expects `pre-push: ✗ BLOCKED`   (hook, main-push stdin)
//
// `gate-stale` runs gate-fail and stale-guard back-to-back (one command for
// the whole gate side of the teeth); `teeth-proofs` runs ALL three (the gate
// pair plus the hook BLOCK path) — the whole teeth section in one command.
// Each sub-proof gets its own worktree and cleanup, and the composite fails
// if ANY expected verdict does not reproduce.
//
// A proof that did not reproduce — live has caught up to HEAD~1, the token is
// revoked (exit 2), or the driver could not determine live — exits 1 with the
// reason instead of silently "passing". Exit 0 means every expected verdict
// appeared and every worktree was cleaned up.
//
// Requirements (same as the one-liners): the gate proofs run the worktree's
// OWN driver, so their worktree commit must carry it (any commit at or after
// 067b313 — HEAD~1 normally is); hook-block copies the current driver in, so
// it is age-independent. The gate needs VERCEL_TOKEN (from the environment,
// the repo's .env.local, or the Vercel CLI auth store — the script copies
// .env.local into the worktree when present so a token stored there resolves
// exactly like a real push).
//
// Read-only against git and Vercel — only temporary worktrees are created
// and removed; nothing is pushed or deployed by the proof itself.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// ── Mode table: the command to run in the worktree, the stdin to feed it,
//    and the expected verdict substring that proves the path reproduced. ──
const MODES = {
  'gate-fail': {
    command: ['npm', 'run', 'verify:deployed-hash'],
    stdin: null,
    expected: 'RESULT: FAIL',
    summary: 'Gate FAIL path',
  },
  'stale-guard': {
    command: ['node', 'scripts/verify-deployed-hash-gate.mjs', '--stale-guard'],
    stdin: null,
    expected: '✗ STALE-HEAD BLOCK',
    summary: 'CI stale-guard mode',
  },
  'hook-block': {
    command: ['bash', '.githooks/pre-push'],
    // The hook only reads the remote-ref / remote-sha stdin fields; the
    // placeholders mirror the README one-liner's stdin verbatim.
    stdin: 'refs/heads/main a refs/heads/main b\n',
    expected: 'pre-push: ✗ BLOCKED',
    summary: 'Hook BLOCK path',
  },
};

// ── Composite modes: run several MODES back-to-back, one worktree each. ──
const COMBINED = {
  'gate-stale': {
    subModes: ['gate-fail', 'stale-guard'],
    summary: 'gate teeth (FAIL + stale-guard)',
  },
  'teeth-proofs': {
    subModes: ['gate-fail', 'stale-guard', 'hook-block'],
    summary: 'all teeth (gate FAIL + stale-guard + hook BLOCK)',
  },
};

const requestedMode = process.argv[2];
if (!MODES[requestedMode] && !COMBINED[requestedMode]) {
  console.error(`✗ unknown proof mode '${requestedMode}' — use one of: ${Object.keys({ ...MODES, ...COMBINED }).join(', ')}`);
  process.exit(2);
}

// runProof(<mode>) — the FULL worktree lifecycle for ONE proof: throwaway
// detached worktree at HEAD~1, the check, the transcript, the expected-verdict
// assertion, and guaranteed cleanup. Returns true when the expected verdict
// reproduced; hard failures (git unusable, a driver-less worktree for the
// gate proofs) exit 1 directly.
function runProof(mode) {
  const def = MODES[mode];

  // ── The throwaway worktree (HEAD~1; cleanup guaranteed) ─────────────────
  const wtPath = resolve(tmpdir(), `cook-teeth-${mode}`);
  const headPrev = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: ROOT, encoding: 'utf8' });
  if (headPrev.status !== 0 || !headPrev.stdout.trim()) {
    console.error('✗ FAIL: could not resolve HEAD~1 (git rev-parse HEAD~1 failed).');
    process.exit(1);
  }
  const WORKTREE_SHA = headPrev.stdout.trim();

  // Pre-clean any stale worktree (a previous crashed run) so `git worktree add`
  // never collides; the path lives under the OS temp dir and is safe to remove.
  const stale = spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: ROOT, encoding: 'utf8' });
  if (stale.status !== 0 && existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
  mkdirSync(wtPath, { recursive: true });
  // A leftover worktree REGISTRATION (dir already gone) also blocks `add`.
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });

  const add = spawnSync('git', ['worktree', 'add', '--detach', wtPath, WORKTREE_SHA], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (add.status !== 0) {
    console.error(`✗ FAIL: could not create the throwaway worktree at HEAD~1 (${WORKTREE_SHA}):`);
    console.error(add.stderr?.trim());
    rmSync(wtPath, { recursive: true, force: true });
    process.exit(1);
  }

  let reproduced = false;
  let childExit = -1;
  try {
    // The gate proofs run the worktree's OWN driver, so their worktree commit
    // must carry it (the README's >= 067b313 requirement, checked by file
    // presence). hook-block is exempt: it copies the CURRENT driver in below,
    // so it is independent of the worktree commit's age — like the README
    // one-liner it documents.
    if (mode !== 'hook-block' && !existsSync(resolve(wtPath, 'scripts', 'verify-deployed-hash-gate.mjs'))) {
      console.error(`✗ FAIL: worktree commit ${WORKTREE_SHA} predates the gate driver — the proof needs a commit at or after 067b313 (HEAD~1 normally is).`);
      process.exit(1);
    }

    // Copy the repo's .env.local so a token stored there resolves inside the
    // worktree (a fresh worktree does not check out gitignored files), and copy
    // the CURRENT hook for hook-block (the worktree commit may predate it).
    if (existsSync(resolve(ROOT, '.env.local'))) {
      spawnSync('cp', [resolve(ROOT, '.env.local'), resolve(wtPath, '.env.local')]);
    }
    if (mode === 'hook-block') {
      mkdirSync(resolve(wtPath, '.githooks'), { recursive: true });
      spawnSync('cp', [resolve(ROOT, '.githooks', 'pre-push'), resolve(wtPath, '.githooks', 'pre-push')]);
      // The unified hook delegates to the gate driver — copy the CURRENT
      // driver (and the base driver it composes) so the proof exercises the
      // exact current artifacts, independent of the worktree commit's age.
      spawnSync('cp', [resolve(ROOT, 'scripts', 'verify-deployed-hash-gate.mjs'), resolve(wtPath, 'scripts', 'verify-deployed-hash-gate.mjs')]);
      spawnSync('cp', [resolve(ROOT, 'scripts', 'verify-deployed-hash.mjs'), resolve(wtPath, 'scripts', 'verify-deployed-hash.mjs')]);
    }

    console.log(`\n=== verify-teeth-proofs: ${def.summary} — worktree at ${WORKTREE_SHA.slice(0, 12)} ===`);
    const child = spawnSync(def.command[0], def.command.slice(1), {
      cwd: wtPath,
      input: def.stdin,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childExit = child.status ?? 1;
    const transcript = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);

    reproduced = transcript.includes(def.expected);
    if (reproduced) {
      console.log(`\n✓ ${def.summary} reproduced (child exit=${childExit}) — expected verdict '${def.expected}' present`);
    } else {
      console.error(`\n✗ ${def.summary} NOT reproduced (child exit=${childExit}) — expected verdict '${def.expected}' was absent.`);
      console.error('  Possible causes: live has caught up to HEAD~1 (so the comparison matches), the token is revoked/invalid (exit 2), or the live commit could not be determined.');
    }
  } finally {
    // ALWAYS remove the worktree — the one hard guarantee of the one-liners.
    const rm = spawnSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: ROOT, encoding: 'utf8' });
    if (rm.status !== 0 && existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  }

  return reproduced;
}

// ── Dispatch: a composite mode runs each sub-proof in sequence; a single ───
//    mode runs just itself. Exit 0 only when every expected verdict appeared.
const subModes = COMBINED[requestedMode]?.subModes ?? [requestedMode];
const results = subModes.map(runProof);

if (COMBINED[requestedMode]) {
  const ok = results.every(Boolean);
  const label = COMBINED[requestedMode].summary;
  if (ok) {
    console.log(`\n✓ ${label} — ${results.length}/${results.length} proofs reproduced`);
  } else {
    console.error(`\n✗ ${label} — only ${results.filter(Boolean).length}/${results.length} proofs reproduced`);
  }
  process.exit(ok ? 0 : 1);
}

process.exit(results[0] ? 0 : 1);
