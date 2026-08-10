import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-teeth-proofs.test.ts — lock the teeth-proof runner.
//
// The README teeth section documents three one-liners for re-proving the
// deployed-hash gate's FAIL / STALE-HEAD BLOCK / hook BLOCK paths; the npm
// scripts (verify:gate-fail-proof / verify:stale-guard-proof /
// verify:hook-block-proof) run them without copy-paste. This test reads the
// REAL script + package.json and asserts the load-bearing pieces survive
// future edits: the three modes and their exact commands, the expected
// verdict strings (a proof that stops asserting its verdict is a runner, not
// a proof), the throwaway-worktree mechanics with guaranteed cleanup, and
// the copies (.env.local for the token, the current hook for hook-block).
// ============================================================================

const SRC = readFileSync('scripts/verify-teeth-proofs.mjs', 'utf8');
const PKG = readFileSync('package.json', 'utf8');

describe('scripts/verify-teeth-proofs.mjs · mode table', () => {
  it('defines the three modes with their exact commands', () => {
    expect(SRC).toContain("'gate-fail': {");
    // The plain gate invocation (not `npm run verify:deployed-hash` — that
    // script's target differs between repos, so the runner must not depend
    // on it for the gate-fail proof to stay identical across repos).
    expect(SRC).toContain("command: ['node', 'scripts/verify-deployed-hash-gate.mjs']");
    expect(SRC).toContain("'stale-guard': {");
    expect(SRC).toContain("command: ['node', 'scripts/verify-deployed-hash-gate.mjs', '--stale-guard']");
    expect(SRC).toContain("'hook-block': {");
    expect(SRC).toContain("command: ['bash', '.githooks/pre-push']");
  });

  it('feeds the hook-block proof the same main-push stdin the README one-liner pipes', () => {
    // The hook only reads the remote-ref / remote-sha fields; the stdin must
    // mirror the README's verbatim so the script and the doc agree.
    expect(SRC).toContain("stdin: 'refs/heads/main a refs/heads/main b\\n'");
  });

  it('asserts the expected verdict per mode — a runner without a verdict is not a proof', () => {
    expect(SRC).toContain("expected: 'RESULT: FAIL'");
    expect(SRC).toContain("expected: '✗ STALE-HEAD BLOCK'");
    expect(SRC).toContain("expected: 'pre-push: ✗ BLOCKED'");
  });

  it('defines the gate-stale composite mode running BOTH gate proofs back-to-back', () => {
    // verify:gate-stale-proof is the gate side of the teeth in ONE command:
    // the composite must chain the two gate modes (each with its own worktree
    // and cleanup) and fail if EITHER verdict is absent.
    expect(SRC).toContain("'gate-stale': {");
    expect(SRC).toContain("subModes: ['gate-fail', 'stale-guard']");
    expect(SRC).toContain('const subModes = COMBINED[requestedMode]?.subModes ?? [requestedMode];');
    expect(SRC).toContain('const results = subModes.map(runProof);');
    expect(SRC).toContain('process.exit(ok ? 0 : 1);');
  });

  it('defines the teeth-proofs composite running ALL three teeth in one command', () => {
    // verify:teeth-proofs is the whole teeth section in one command: the
    // gate pair PLUS the hook BLOCK path, each with its own worktree and
    // cleanup, failing if ANY verdict is absent.
    expect(SRC).toContain("'teeth-proofs': {");
    expect(SRC).toContain("subModes: ['gate-fail', 'stale-guard', 'hook-block']");
    expect(SRC).toContain("summary: 'all teeth (gate FAIL + stale-guard + hook BLOCK)'");
  });
});

describe('scripts/verify-teeth-proofs.mjs · throwaway-worktree mechanics', () => {
  it('creates a detached worktree at HEAD~1 (the commit whose comparison necessarily mismatches live)', () => {
    // spawnSync takes the binary as its own first arg — the inner arrays are
    // the load-bearing parts to lock.
    expect(SRC).toContain("['rev-parse', 'HEAD~1']");
    expect(SRC).toContain("['worktree', 'add', '--detach', wtPath, WORKTREE_SHA]");
  });

  it('ALWAYS removes the worktree — the cleanup lives in a finally block', () => {
    // The one hard guarantee of the README one-liners is the cleanup; a
    // future edit that moves the removal out of finally (or drops it) leaves
    // a dangling worktree on every proof and fails here.
    expect(SRC).toContain('} finally {');
    expect(SRC).toContain("['worktree', 'remove', '--force', wtPath]");
    const finallyIdx = SRC.indexOf('} finally {');
    // lastIndexOf: the removal also appears in the pre-clean step BEFORE the
    // worktree add — the load-bearing one is the finally-block removal.
    const removeIdx = SRC.lastIndexOf("['worktree', 'remove', '--force', wtPath]");
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(finallyIdx);
  });

  it('pre-cleans a stale worktree and prunes leftover registrations', () => {
    expect(SRC).toContain("['worktree', 'remove', '--force', wtPath]");
    expect(SRC).toContain("['worktree', 'prune']");
  });

  it('copies the CURRENT driver into the worktree for EVERY proof (age-independent — no minimum-commit guard)', () => {
    // The proofs always exercise the exact current artifacts: the gate
    // driver (and the base driver it composes) are copied into the worktree
    // unconditionally, so no commit-age guard is needed — and the old
    // repo-specific 067b313 minimum is gone (the portfolio's gate only
    // appeared at a different commit, so the guard could never have been
    // shared identically). Negative locks: the guard and its commit reference
    // must not reappear.
    expect(SRC).toContain("resolve(ROOT, 'scripts', 'verify-deployed-hash-gate.mjs')");
    expect(SRC).toContain("resolve(wtPath, 'scripts', 'verify-deployed-hash-gate.mjs')");
    expect(SRC).toContain("resolve(ROOT, 'scripts', 'verify-deployed-hash.mjs')");
    expect(SRC).toContain("resolve(wtPath, 'scripts', 'verify-deployed-hash.mjs')");
    expect(SRC).not.toContain('predates the gate driver');
    expect(SRC).not.toContain('067b313');
    expect(SRC).not.toContain("mode !== 'hook-block' && !existsSync");
  });

  it('copies .env.local (token resolution) and, for hook-block, the CURRENT hook', () => {
    // A fresh worktree does not check out gitignored files, and it has no
    // .githooks — the token must resolve exactly like a real push (env →
    // copied .env.local → CLI auth store), and the hook proof must exercise
    // the current unified hook, not whatever the worktree commit carried.
    expect(SRC).toContain("resolve(ROOT, '.env.local')");
    expect(SRC).toContain("resolve(wtPath, '.env.local')");
    expect(SRC).toContain("mode === 'hook-block'");
    expect(SRC).toContain("resolve(ROOT, '.githooks', 'pre-push')");
    expect(SRC).toContain("resolve(wtPath, '.githooks', 'pre-push')");
  });
});

describe('package.json · npm script wiring', () => {
  it('exposes the proofs as npm scripts calling the runner with their mode', () => {
    expect(PKG).toContain('"verify:gate-fail-proof": "node scripts/verify-teeth-proofs.mjs gate-fail"');
    expect(PKG).toContain('"verify:stale-guard-proof": "node scripts/verify-teeth-proofs.mjs stale-guard"');
    expect(PKG).toContain('"verify:gate-stale-proof": "node scripts/verify-teeth-proofs.mjs gate-stale"');
    expect(PKG).toContain('"verify:teeth-proofs": "node scripts/verify-teeth-proofs.mjs teeth-proofs"');
    expect(PKG).toContain('"verify:hook-block-proof": "node scripts/verify-teeth-proofs.mjs hook-block"');
  });
});
