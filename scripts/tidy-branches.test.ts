import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/tidy-branches.test.ts — pin the safe-delete semantics of the
// branch-tidy script.
//
// The whole point of the script is that tidying is safe by construction: it
// prunes tracking refs for branches already deleted server-side, and deletes
// local branches with `git branch -d`, which git itself refuses for anything
// not fully merged. The load-bearing lines are pinned here so an edit that
// swaps in `-D` (force delete), drops the prune pass, or stops skipping the
// current/base branch turns these assertions red.
// ============================================================================

const TIDY = readFileSync('scripts/tidy-branches.mjs', 'utf8');

describe('scripts/tidy-branches.mjs · safe branch tidy', () => {
  it('prunes stale remote-tracking refs from origin', () => {
    expect(TIDY).toContain('git remote prune origin');
    // The dry-run mode must exercise the same prune surface, not a no-op.
    expect(TIDY).toContain('git remote prune origin --dry-run');
  });

  it('deletes only branches fully merged into the base, with -d never -D', () => {
    expect(TIDY).toContain('git branch --merged');
    expect(TIDY).toContain('git branch -d');
    // Force delete is exactly what this script exists to avoid: a squash merge
    // hides ancestry, so only a human platform check may precede -D.
    expect(TIDY).not.toContain('git branch -D');
  });

  it('never deletes the base or the currently checked-out branch', () => {
    expect(TIDY).toContain("name !== base && name !== current");
  });

  it('leaves refused branches in place with a visible note instead of failing the run', () => {
    // `git branch -d` exits nonzero on a not-fully-merged branch; the catch
    // must record it and continue, never crash or force-delete.
    expect(TIDY).toContain('kept ${name} (not fully merged');
    expect(TIDY).toContain('process.exit(0)');
  });

  it('supports --dry-run so the tidy can be previewed before anything changes', () => {
    expect(TIDY).toContain('args.includes(\'--dry-run\')');
    expect(TIDY).toContain('would delete');
  });
});
