import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/land-pr.test.ts — lock scripts/land-pr.mjs, the one-command landing
// path under the PR-only flow.
//
// Branch protection on `main` rejects direct pushes, so every change lands
// via branch → PR → checks → merge. This helper automates that path; its
// load-bearing contracts: it refuses to run when there is nothing to commit
// or off the base branch, it commits (staged-only when anything is staged),
// it pushes ONLY a feature branch (never a main ref — it must not be able to
// bypass the protection it exists to satisfy), it opens the PR against the
// base, and it arms auto-merge with squash unless --no-merge.
// ============================================================================

const LAND = readFileSync('scripts/land-pr.mjs', 'utf8');

describe('scripts/land-pr.mjs · guards (nothing lands by accident)', () => {
  it('requires a --message before doing anything', () => {
    expect(LAND).toContain('--message');
    expect(LAND).toContain('a commit/PR message is required');
    expect(LAND).toContain('fail(1,');
  });

  it('refuses to run on a clean working tree', () => {
    expect(LAND).toContain('git status --porcelain');
    expect(LAND).toContain('nothing to commit');
    expect(LAND).toContain('fail(1,');
  });

  it('refuses to run off the base branch', () => {
    expect(LAND).toContain('git rev-parse --abbrev-ref HEAD');
    expect(LAND).toContain('must be on');
    expect(LAND).toContain('fail(2,');
  });
});

describe('scripts/land-pr.mjs · creates the feature branch first', () => {
  it('checks out a new branch before committing (the commit must never land on main)', () => {
    expect(LAND).toContain('git checkout -b "${branch}"');
    // The branch creation must come BEFORE the commit in the file.
    expect(LAND.indexOf('git checkout -b')).toBeGreaterThan(-1);
    expect(LAND.indexOf('git checkout -b')).toBeLessThan(LAND.indexOf('git commit'));
  });

  it('derives the branch name from the commit message type + subject', () => {
    // "fix: expose the stuck-queue duration" -> fix/expose-the-stuck-queue-duration
    expect(LAND).toContain('fix/expose-the-stuck-queue-duration');
    expect(LAND).toContain('toLowerCase()');
    expect(LAND).toContain('.slice(0, 48)');
  });

  it('fails loudly if the branch already exists (nothing committed)', () => {
    expect(LAND).toContain('could not be created');
    expect(LAND).toContain('nothing was committed');
  });
});

describe('scripts/land-pr.mjs · commit discipline', () => {
  it('commits only staged hunks when anything is staged (multi-stream trees stay clean)', () => {
    expect(LAND).toContain('git diff --cached --quiet');
    expect(LAND).toContain('Only the staged hunks land');
  });

  it('otherwise stages and commits the whole tree with the exact message', () => {
    expect(LAND).toContain('git add -A && git commit');
    expect(LAND).toContain('git commit -m "${MESSAGE');
    // The file list is printed BEFORE committing — nothing is swept in
    // silently.
    expect(LAND).toContain('git status --short');
  });
});

describe('scripts/land-pr.mjs · never bypasses the protection', () => {
  it('pushes only the feature branch with -u', () => {
    expect(LAND).toContain('git push -u origin "${branch}"');
  });

  it('never pushes (or otherwise writes) a main ref directly', () => {
    // This is a PR-creation tool; a main push here would bypass (or mask a
    // bypass of) the required checks and skip the recorded bypass — if a
    // future edit adds a main push or a raw `git push` without a branch ref,
    // fail here.
    expect(LAND).not.toMatch(/git push[^;]*\bmain\b/);
    expect(LAND).not.toMatch(/refs\/heads\/main/);
  });
});

describe('scripts/land-pr.mjs · the PR + merge path', () => {
  it('opens the PR against the base branch with the message as title/body', () => {
    expect(LAND).toContain('gh pr create --base "${BASE}" --head "${branch}"');
    expect(LAND).toContain('--title "${MESSAGE');
    expect(LAND).toContain('--body "${MESSAGE');
  });

  it('captures the PR URL via runQuiet (the number is needed to arm auto-merge)', () => {
    // A regression here would return an empty URL, so auto-merge arming
    // silently targets the wrong PR number — the exact bug caught live when
    // the helper's first run created PR #9 but armed nothing.
    expect(LAND).toContain('return runQuiet(`gh pr create');
    expect(LAND).toContain('prUrl.match(/(\\d+)\\s*$/)');
  });

  it('arms auto-merge with squash + branch deletion by default', () => {
    expect(LAND).toContain('gh pr merge "${prNumber}" --auto --squash --delete-branch');
  });

  it('supports --no-merge to stop at PR creation with manual-merge instructions', () => {
    expect(LAND).toContain('--no-merge');
    expect(LAND).toContain('gh pr merge ${prNumber} --squash --delete-branch');
  });
});
