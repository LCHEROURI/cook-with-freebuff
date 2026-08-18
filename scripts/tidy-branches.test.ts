import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/tidy-branches.test.ts — pin the safe-delete semantics of the
// branch-tidy script.
//
// The whole point of the script is that tidying is safe by construction: it
// prunes tracking refs for branches already deleted server-side, deletes
// local branches with `git branch -d` (which git refuses for anything not
// fully merged), and never runs a branch name through a shell. The
// load-bearing lines are pinned here so an edit that swaps in `-D` (force
// delete), drops the prune pass, interpolates a name into a shell string, or
// stops verifying deletions turns these assertions red.
// ============================================================================

const TIDY = readFileSync('scripts/tidy-branches.mjs', 'utf8');

describe('scripts/tidy-branches.mjs · safe branch tidy', () => {
  it('calls git through execFileSync with ARGUMENT ARRAYS — never a shell string', () => {
    // A branch name like `evil;touch$IFS/tmp/pwn` interpolated into a shell
    // command would execute; execFileSync with an args array passes it
    // literally (Codex P1, PR #139 review).
    expect(TIDY).toContain("execFileSync(cmd, cmdArgs, { encoding: 'utf8' })");
    expect(TIDY).toContain("import { execFileSync } from 'node:child_process'");
    // No execSync anywhere: a bare execSync would run through /bin/sh.
    expect(TIDY).not.toContain('execSync(');
    // Branch names must be arguments, never interpolated into a command line.
    expect(TIDY).toContain("['branch', '-d', name]");
  });

  it('prunes stale remote-tracking refs from origin', () => {
    expect(TIDY).toContain("['remote', 'prune', 'origin']");
    // The dry-run mode must exercise the same prune surface, not a no-op.
    expect(TIDY).toContain("['remote', 'prune', '--dry-run', 'origin']");
  });

  it('deletes only branches fully merged into the base, with -d never -D', () => {
    expect(TIDY).toContain("['branch', '--merged', base]");
    expect(TIDY).toContain("['branch', '-d', name]");
    // Force delete is exactly what this script exists to avoid: a squash merge
    // hides ancestry, so only a human platform check may precede -D.
    expect(TIDY).not.toContain("'-D'");
  });

  it('never deletes the base or the currently checked-out branch', () => {
    expect(TIDY).toContain('name !== base && name !== current');
  });

  it('verifies a branch is PROVABLY GONE before reporting it deleted', () => {
    // `git branch -d` checks its OWN base (upstream, or HEAD) which can differ
    // from `--merged main` when running from a feature branch, so a refused or
    // still-present branch must be reported as kept — never PASS (Codex P2,
    // PR #139 review).
    expect(TIDY).toContain("['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]");
    expect(TIDY).toContain('refused || branchExists(name)');
    expect(TIDY).toContain('kept ${name} (not fully merged against -d');
    expect(TIDY).toContain('process.exit(0)');
  });

  it('supports --dry-run so the tidy can be previewed before anything changes', () => {
    expect(TIDY).toContain("args.includes('--dry-run')");
    expect(TIDY).toContain('would delete');
  });
});
