import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/tidy-branches.test.ts — pin the safe-delete semantics of the
// branch-tidy script.
//
// The whole point of the script is that tidying is safe by construction: it
// prunes tracking refs for branches already deleted server-side, deletes
// branches merged into the base with `git branch -d` (which git refuses for
// anything not fully merged), and force-deletes a squash-merged branch ONLY
// after GitHub confirms its PR is merged. It never runs a branch name through
// a shell. The load-bearing lines are pinned here so an edit that swaps in an
// unverified `-D`, drops the prune pass, interpolates a name into a shell
// string, or stops verifying deletions turns these assertions red.
// ============================================================================

const TIDY = readFileSync('scripts/tidy-branches.mjs', 'utf8');

describe('scripts/tidy-branches.mjs · safe branch tidy', () => {
  it('calls git and gh through execFileSync with ARGUMENT ARRAYS — never a shell string', () => {
    // A branch name like `evil;touch$IFS/tmp/pwn` interpolated into a shell
    // command would execute; execFileSync with an args array passes it
    // literally (Codex P1, PR #139 review).
    expect(TIDY).toContain("execFileSync(cmd, cmdArgs, { encoding: 'utf8' })");
    expect(TIDY).toContain("import { execFileSync } from 'node:child_process'");
    // No execSync anywhere: a bare execSync would run through /bin/sh.
    expect(TIDY).not.toContain('execSync(');
    // Branch names must be arguments, never interpolated into a command line.
    expect(TIDY).toContain("['branch', '-d', name]");
    expect(TIDY).toContain("['branch', '-D', name]");
  });

  it('prunes stale remote-tracking refs from origin', () => {
    expect(TIDY).toContain("['remote', 'prune', 'origin']");
    // The dry-run mode must exercise the same prune surface, not a no-op.
    expect(TIDY).toContain("['remote', 'prune', '--dry-run', 'origin']");
  });

  it('deletes only branches fully merged into the base with -d, and NEVER a blind -D', () => {
    expect(TIDY).toContain("['branch', '--merged', base]");
    expect(TIDY).toContain("['branch', '-d', name]");
    // The force delete exists ONLY in pass 3, gated on the GitHub merged-PR
    // map — a -D anywhere else (or before confirmation) is exactly the
    // destructive move this script exists to avoid.
    expect(TIDY).toContain("run('git', ['branch', '-D', name]);");
  });

  it('never deletes the base or the currently checked-out branch (in every pass)', () => {
    // The -d pass skips via `name !== base && name !== current`; the squash
    // pass bails via `name === base || name === current`. Both must exist.
    expect(TIDY).toContain('name !== base && name !== current');
    expect(TIDY).toContain('name !== base && name !== current && prHeads.has(name)');
  });

  it('verifies a branch is PROVABLY GONE before reporting it deleted', () => {
    // `git branch -d` checks its OWN base (upstream, or HEAD) which can differ
    // from `--merged main` when running from a feature branch, so a refused or
    // still-present branch must be reported as kept — never PASS (Codex P2,
    // PR #139 review).
    expect(TIDY).toContain("['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]");
    expect(TIDY).toContain('refused || branchExists(name)');
    expect(TIDY).toContain('kept ${name} (git sees it merged into ${base}');
    expect(TIDY).toContain('process.exit(0)');
  });

  it('confirms squash merges against GitHub with ONE gh pr list call before any force delete', () => {
    // The squash-merge blind spot: git ancestry cannot see a squash merge, so
    // the branch never appears in --merged. The script asks GitHub which PR
    // head branches were merged and force-deletes only those.
    expect(TIDY).toContain("run('gh', ['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid,number', '--limit', '1000'])");
    expect(TIDY).toContain('prHeads.has(name)');
    expect(TIDY).toContain('squash-merged — PR #${pr} merged on GitHub, tip matches');
  });

  it('requires the local tip to EQUAL the merged PR headRefOid — a name match alone never force-deletes', () => {
    // A reused branch name (or a fork's merged PR with the same name) must not
    // delete NEW unmerged commits on that name: the merged PR's headRefOid is
    // compared against the local tip and only an exact match authorizes -D
    // (Codex P1, PR #140 review).
    expect(TIDY).toContain('localTip(name) === prHeads.get(name).headRefOid');
    expect(TIDY).toContain("['rev-parse', 'refs/heads/' + name]");
    // The mismatched-tip case is visible, never a silent skip.
    expect(TIDY).toContain('tip differs — possible reused/fork name with new work; left alone');
  });

  it('keeps squash candidates when gh is unavailable — never a blind force delete', () => {
    // gh missing / unauthenticated / failed → mergedPrHeads() returns null and
    // the pass reports kept instead of deleting anything.
    expect(TIDY).toContain('return null;');
    expect(TIDY).toContain('gh unavailable');
    expect(TIDY).toContain('squash-merged branches kept');
  });

  it('supports --dry-run so the tidy can be previewed before anything changes', () => {
    expect(TIDY).toContain("args.includes('--dry-run')");
    expect(TIDY).toContain('would delete');
  });

  it('report mode is READ-ONLY and writes the findings to the given path', () => {
    // The weekly workflow runs --report so it can open a PR instead of mutating
    // the repo. Report mode must never prune or delete anything, and must end
    // with the FINDINGS line the workflow branches on.
    expect(TIDY).toContain("args.indexOf('--report')");
    expect(TIDY).toContain('REPORT_MODE = REPORT_PATH !== null');
    expect(TIDY).toContain('writeFileSync(REPORT_PATH, report)');
    expect(TIDY).toContain('FINDINGS: ${findings}');
    expect(TIDY).toContain('process.exit(0)');
    // In report mode the prune pass and both delete passes report 'would'
    // instead of acting — no mutation path can run.
    expect(TIDY).toContain('if (REPORT_MODE || DRY_RUN)');
  });

  it('scans REMOTE branches against merged PR head OIDs (the origin accumulation)', () => {
    // delete_branch_on_merge is OFF in this repo, so merged PR head branches
    // stay on origin — the accumulation a weekly schedule must surface. The
    // remote tip must equal the merged PR headRefOid (same proof as pass 3).
    expect(TIDY).toContain("['ls-remote', '--heads', 'origin']");
    expect(TIDY).toContain('remoteBranches()');
    expect(TIDY).toContain('remotes.get(name) === prHeads.get(name).headRefOid');
    expect(TIDY).toContain('git push origin --delete ${name}');
  });
});
