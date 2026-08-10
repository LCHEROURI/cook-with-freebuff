#!/usr/bin/env node
// ============================================================================
// scripts/verify-teeth-proofs.mjs — run the README teeth proofs as one
// command each, no copy-paste from the README.
//
//   node scripts/verify-teeth-proofs.mjs gate-fail      # Gate FAIL path
//   node scripts/verify-teeth-proofs.mjs stale-guard    # CI stale-guard mode
//   node scripts/verify-teeth-proofs.mjs hook-block     # Hook BLOCK path
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
// A proof that did not reproduce — live has caught up to HEAD~1, the token is
// revoked (exit 2), or the driver could not determine live — exits 1 with the
// reason instead of silently "passing". Exit 0 means the expected verdict
// appeared and the worktree was cleaned up.
//
// Requirements (same as the one-liners): the worktree commit must carry the
// gate driver (any commit at or after 067b313 — HEAD~1 normally is), and the
// gate needs VERCEL_TOKEN (from the environment, the repo's .env.local, or
// the Vercel CLI auth store — the script copies .env.local into the worktree
// when present so a token stored there resolves exactly like a real push).
//
// Read-only against git and Vercel — only a temporary worktree is created
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

const mode = process.argv[2];
const def = MODES[mode];
if (!def) {
  console.error(`✗ unknown proof mode '${mode}' — use one of: ${Object.keys(MODES).join(', ')}`);
  process.exit(2);
}

// ── The throwaway worktree (HEAD~1; cleanup guaranteed) ────────────────────
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
  // The worktree must carry the gate driver — the check (and the hook, for
  // hook-block) runs it. Mirrors the README's requirement that the worktree
  // commit be at or after 067b313.
  if (!existsSync(resolve(wtPath, 'scripts', 'verify-deployed-hash-gate.mjs'))) {
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

process.exit(reproduced ? 0 : 1);
