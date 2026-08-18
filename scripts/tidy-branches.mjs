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
// Squash-merged branches are intentionally refused: git ancestry cannot see
// a squash merge, so `-d` reports them as not fully merged and the script
// leaves them for a platform check (e.g. gh pr view) before any -D. A silent
// force delete is exactly the destructive move this script exists to avoid.
// ============================================================================

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const step = (m) => console.log(`  ${DRY_RUN ? '·' : '✓'} ${m}`);
const skip = (m) => console.log(`  - ${m}`);

// The base is main when it exists; otherwise the current branch (a fresh
// clone may have only its checked-out branch until the first fetch).
const current = run('git rev-parse --abbrev-ref HEAD');
let base = 'main';
try {
  run('git rev-parse --verify main');
} catch {
  base = current;
}

// ── Pass 1: prune stale remote-tracking refs ────────────────────────────────
console.log(`\nPruning stale remote-tracking refs (origin):`);
if (DRY_RUN) {
  const dry = run('git remote prune origin --dry-run').trim();
  if (dry) {
    for (const line of dry.split('\n')) step(`would ${line.trim()}`);
  } else {
    skip('nothing stale');
  }
} else {
  const out = run('git remote prune origin').trim();
  if (out) {
    for (const line of out.split('\n')) step(line.trim());
  } else {
    skip('nothing stale');
  }
}

// ── Pass 2: delete fully merged local branches ──────────────────────────────
console.log(`\nLocal branches fully merged into ${base}:`);
const merged = run(`git branch --merged ${base}`)
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
    try {
      run(`git branch -d ${name}`);
      step(`deleted ${name}`);
    } catch {
      // `-d` refuses unmerged (incl. squash-merged) branches; leave them for
      // a platform check before any force delete.
      skip(`kept ${name} (not fully merged — verify against GitHub before -D)`);
    }
  }
}

console.log(`\nRESULT: ${DRY_RUN ? 'DRY RUN (nothing changed)' : 'PASS (branches tidy)'}`);
process.exit(0);
