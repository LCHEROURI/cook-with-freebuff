import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/readme-teeth.test.ts — lock the README "Re-proving the gate's
// teeth in seconds" section.
//
// Same discipline as ci-workflows.test.ts / pre-push.test.ts: read the REAL
// README from disk (never a fixture) and assert the three teeth-proof
// one-liners — and the verdict strings they document — survive future edits.
// The section is the maintenance manual for re-verifying the deployed-hash
// gate's FAIL / STALE-HEAD BLOCK / hook BLOCK paths; if an edit drops a
// one-liner, removes the --stale-guard flag from it, or softens an expected
// verdict, a maintainer can no longer re-prove the gate in seconds — and a
// future "fix" that weakens the documented contract would go unnoticed.
//
// Scope discipline (from the portfolio's vacuous-pass traps): all assertions
// are scoped to the teeth section (header → next `### ` heading), so prose
// elsewhere in the README (e.g. the hook section's "exit 1 → blocked"
// wording) can never satisfy a verdict assertion by accident.
// ============================================================================

const README = readFileSync('README.md', 'utf8');

const teethStart = README.indexOf("### Re-proving the gate's teeth in seconds");
// The next `### ` heading after the teeth section is the PR preview gate
// section; everything between them is the teeth content.
const teethEnd = README.indexOf('\n### ', teethStart + 1);
const TEETH = README.slice(teethStart, teethEnd === -1 ? undefined : teethEnd);

describe("README · 'Re-proving the gate's teeth in seconds'", () => {
  it('points each proof at its one-command npm script (no copy-paste)', () => {
    // The README is the discoverable entry point for the proofs; if the
    // section stops mentioning the npm scripts (or a script name drifts),
    // the doc and package.json have diverged and this fails.
    expect(TEETH).toContain('npm run verify:teeth-proofs');
    expect(TEETH).toContain('ALL three teeth in one command');
    expect(TEETH).toContain('npm run verify:gate-stale-proof');
    expect(TEETH).toContain('npm run verify:hook-block-proof');
    expect(TEETH).toContain('npm run verify:gate-fail-proof');
    expect(TEETH).toContain('npm run verify:stale-guard-proof');
    expect(TEETH).toContain('BOTH gate teeth in one command');
    expect(TEETH).toContain('expects RESULT: FAIL');
    expect(TEETH).toContain('expects ✗ STALE-HEAD BLOCK');
    expect(TEETH).toContain('expects ✗ BLOCKED');
  });

  it('keeps the section with its read-only framing and the worktree-commit requirement', () => {
    expect(TEETH.length).toBeGreaterThan(0);
    // The framing line: the proofs are read-only against git and the host —
    // dropping it would let a future edit turn the proofs into something
    // that deploys or mutates.
    expect(TEETH).toContain('All three are read-only against git and the host');
    // The one requirement the one-liners rely on: the worktree commit must
    // carry the gate driver with --stale-guard support (≥ 067b313). Without
    // it, the copied hook one-liner runs an old driver and the proof silently
    // stops proving the current contract.
    expect(TEETH).toContain('--stale-guard` support');
    expect(TEETH).toContain('067b313');
  });

  it('keeps the Gate FAIL one-liner (worktree at HEAD~1 + cleanup) with its expected verdict', () => {
    // The one-liner's load-bearing pieces: the throwaway worktree, the plain
    // verify:deployed-hash run, the exit echo, and the guaranteed cleanup.
    expect(TEETH).toContain('git worktree add --detach /tmp/cook-hash-proof HEAD~1');
    expect(TEETH).toContain('(cd /tmp/cook-hash-proof && npm run verify:deployed-hash');
    expect(TEETH).toContain('echo "gate exit=$?"');
    expect(TEETH).toContain('git worktree remove /tmp/cook-hash-proof --force');
    // The documented expected verdict (both halves — the result AND the exit
    // code; a softened expectation is a weakened contract).
    expect(TEETH).toContain('`RESULT: FAIL` and `gate exit=1`');
  });

  it('keeps the CI stale-guard one-liner WITH the --stale-guard flag and its STALE-HEAD BLOCK verdict', () => {
    // The CI-mode proof must keep the direction-aware flag — a version of the
    // one-liner without --stale-guard would just report the plain mismatch
    // (exit 1) and never demonstrate the STALE-HEAD BLOCK the CI step runs.
    expect(TEETH).toContain('git worktree add --detach /tmp/cook-stale-guard HEAD~1');
    expect(TEETH).toContain('(cd /tmp/cook-stale-guard && node scripts/verify-deployed-hash-gate.mjs --stale-guard');
    expect(TEETH).toContain('git worktree remove /tmp/cook-stale-guard --force');
    expect(TEETH).toContain('`✗ STALE-HEAD BLOCK` and `gate exit=1`');
  });

  it('keeps the Hook BLOCK one-liner (current hook AND driver copied in, main-push stdin) with its BLOCKED verdict', () => {
    // The hook proof needs four load-bearing pieces: the hook copied into
    // the worktree (a fresh worktree has no .githooks), the CURRENT
    // --stale-guard driver copied in too (the unified hook delegates to it —
    // the copy is what makes the proof independent of the worktree commit's
    // age), a main-push stdin line piped through it, and the exit echo.
    expect(TEETH).toContain('git worktree add --detach /tmp/cook-hook-block HEAD~1');
    expect(TEETH).toContain("mkdir -p /tmp/cook-hook-block/.githooks && cp .githooks/pre-push /tmp/cook-hook-block/.githooks/");
    expect(TEETH).toContain("cp scripts/verify-deployed-hash-gate.mjs scripts/verify-deployed-hash.mjs /tmp/cook-hook-block/scripts/");
    expect(TEETH).toContain("printf 'refs/heads/main a refs/heads/main b\\n' | bash .githooks/pre-push");
    expect(TEETH).toContain('echo "hook exit=$?"');
    expect(TEETH).toContain('git worktree remove /tmp/cook-hook-block --force');
    expect(TEETH).toContain('`✗ BLOCKED` and `hook exit=1`');
    // The requirement note must reflect the split: the hook proof copies its
    // artifacts (age-independent); the gate proofs run the worktree's own
    // driver and still need >= 067b313.
    expect(TEETH).toContain('independent of the worktree commit');
  });
});
