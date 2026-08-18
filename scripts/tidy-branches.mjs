#!/usr/bin/env node
// ============================================================================
// scripts/tidy-branches.mjs — prune stale remote-tracking refs and delete
// fully merged local branches in one command, so the tidy state is one
// invocation away.
//
//   node scripts/tidy-branches.mjs            # prune + delete merged branches
//   node scripts/tidy-branches.mjs --dry-run  # report what would change, change nothing
//
// Two passes, both safe by construction:
//   1. `git remote prune origin` drops local tracking refs for branches that
//      were deleted server-side (the refs `git branch -r` would otherwise
//      keep showing after a teammate's branch cleanup).
//   2. `git branch -d` deletes only branches fully merged into the base
//      (main, or the current branch if main does not exist). `-d` REFUSES an
//      unmerged branch — git enforces the "fully merged" claim, never the
//      script. The current branch and the base itself are always skipped.
//
// Every git call goes through execFileSync with an ARGUMENT ARRAY — never a
// shell string — so a branch name containing shell metacharacters (git allows
// names like `evil;touch$IFS/tmp/pwn`) is passed literally and can never be
// executed or expanded (Codex P1, PR #139 review). Deletions are verified
// after the fact: `git branch -d` checks its OWN base (the branch's upstream,
// or HEAD when none exists), which can differ from the `--merged main` list
// when running from a feature branch, so a refused branch is reported as kept
// and only a branch that is provably gone is reported as deleted (Codex P2,
// PR #139 review).
//
// Squash-merged branches are intentionally refused: git ancestry cannot see
// a squash merge, so `-d` reports them as not fully merged and the script
// leaves them for a platform check (e.g. gh pr view) before any -D. A silent
// force delete is exactly the destructive move this script exists to avoid.
// ============================================================================

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8' }).trim();
const step = (m) => console.log(`  ${DRY_RUN ? '·' : '✓'} ${m}`);
const skip = (m) => console.log(`  - ${m}`);

const branchExists = (name) => {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
};

// The base is main when it exists; otherwise the current branch (a fresh
// clone may have only its checked-out branch until the first fetch).
const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
let base = 'main';
try {
  run('git', ['rev-parse', '--verify', 'main']);
} catch {
  base = current;
}

// ── Pass 1: prune stale remote-tracking refs ────────────────────────────────
console.log(`\nPruning stale remote-tracking refs (origin):`);
if (DRY_RUN) {
  const dry = run('git', ['remote', 'prune', '--dry-run', 'origin']).trim();
  if (dry) {
    for (const line of dry.split('\n')) step(`would ${line.trim()}`);
  } else {
    skip('nothing stale');
  }
} else {
  const out = run('git', ['remote', 'prune', 'origin']).trim();
  if (out) {
    for (const line of out.split('\n')) step(line.trim());
  } else {
    skip('nothing stale');
  }
}

// ── Pass 2: delete fully merged local branches ──────────────────────────────
console.log(`\nLocal branches fully merged into ${base}:`);
const merged = run('git', ['branch', '--merged', base])
  .split('\n')
  .map((line) => line.replace(/^\*?\s*/, '').trim())
  .filter(Boolean)
  .filter((name) => name !== base && name !== current);

if (merged.length === 0) {
  skip('none');
} else {
  for (const name of merged) {
    if (DRY_RUN) {
      step(`would delete ${name}`);
      continue;
    }
    let refused = false;
    try {
      // `-d` refuses unmerged (incl. squash-merged) branches AND branches not
      // merged into ITS base (upstream, or HEAD) when that differs from the
      // --merged list's base — both throws here, recorded, never force-deleted.
      run('git', ['branch', '-d', name]);
    } catch {
      refused = true;
    }
    if (refused || branchExists(name)) {
      // Either -d refused outright, or it reported success but the branch is
      // still present — leave it for a platform check before any force delete.
      skip(`kept ${name} (not fully merged against -d's base — verify against GitHub before -D)`);
    } else {
      step(`deleted ${name}`);
    }
  }
}

console.log(`\nRESULT: ${DRY_RUN ? 'DRY RUN (nothing changed)' : 'PASS (branches tidy)'}`);
process.exit(0);
