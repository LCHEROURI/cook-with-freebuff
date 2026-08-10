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
    expect(SRC).toContain("command: ['npm', 'run', 'verify:deployed-hash']");
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

  it('guards the gate proofs (worktree carries the driver, ≥ 067b313) but EXEMPTS hook-block', () => {
    // The README requires the worktree commit to be at or after 067b313 for
    // the gate proofs, which run the worktree's OWN driver. hook-block is
    // exempt — it copies the current driver in, so it is independent of the
    // worktree commit's age (the same split the README documents).
    expect(SRC).toContain("'scripts', 'verify-deployed-hash-gate.mjs'");
    expect(SRC).toContain('predates the gate driver');
    expect(SRC).toContain('067b313');
    expect(SRC).toContain("mode !== 'hook-block' && !existsSync");
  });

  it('copies .env.local (token resolution) and, for hook-block, the CURRENT hook + both drivers', () => {
    // A fresh worktree does not check out gitignored files; the one-liners'
    // hook proof copies the hook, and the token must resolve exactly like a
    // real push (env → copied .env.local → CLI auth store). The unified hook
    // delegates to the gate driver, so the current driver (and the base
    // driver it composes) must be copied in too — otherwise the proof would
    // silently run the worktree commit's stale driver.
    expect(SRC).toContain("resolve(ROOT, '.env.local')");
    expect(SRC).toContain("resolve(wtPath, '.env.local')");
    expect(SRC).toContain("mode === 'hook-block'");
    expect(SRC).toContain("resolve(ROOT, '.githooks', 'pre-push')");
    expect(SRC).toContain("resolve(wtPath, '.githooks', 'pre-push')");
    expect(SRC).toContain("resolve(ROOT, 'scripts', 'verify-deployed-hash-gate.mjs')");
    expect(SRC).toContain("resolve(wtPath, 'scripts', 'verify-deployed-hash-gate.mjs')");
    expect(SRC).toContain("resolve(ROOT, 'scripts', 'verify-deployed-hash.mjs')");
    expect(SRC).toContain("resolve(wtPath, 'scripts', 'verify-deployed-hash.mjs')");
  });
});

describe('package.json · npm script wiring', () => {
  it('exposes the three proofs as npm scripts calling the runner with their mode', () => {
    expect(PKG).toContain('"verify:gate-fail-proof": "node scripts/verify-teeth-proofs.mjs gate-fail"');
    expect(PKG).toContain('"verify:stale-guard-proof": "node scripts/verify-teeth-proofs.mjs stale-guard"');
    expect(PKG).toContain('"verify:hook-block-proof": "node scripts/verify-teeth-proofs.mjs hook-block"');
  });
});
