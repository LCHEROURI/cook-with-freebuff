#!/usr/bin/env node
// ============================================================================
// scripts/land-pr.mjs — one-command landing path under the PR-only flow.
//
// Branch protection on `main` requires three green checks (validate, the
// preview hash gate, the emulator-compare smoke), strict up-to-date mode, and
// a pull request — the owner can bypass with recording, but the PR path keeps
// every landing gated. Doing the branch → PR → checks → merge path by hand is
// a nine-step dance; this script is that path in one command:
//
//     node scripts/land-pr.mjs --message "fix: ..."
//
// It refuses to push to main directly (it never touches a main ref), so it
// cannot accidentally bypass the protection it exists to satisfy. What it
// does:
//
//   1. Requires a dirty tree (staged OR unstaged/untracked) and being on the
//      base branch (default `main`).
//   2. Creates a feature branch (--branch, or derived from the message).
//   3. Commits: if changes are already staged, ONLY the staged changes are
//      committed (so a hunk-split multi-stream tree stays clean); otherwise
//      everything in the tree is staged and committed. The full file list is
//      printed first — nothing is swept in silently.
//   4. Pushes the feature branch (-u, never main).
//   5. Opens a PR against the base branch with the message as title/body.
//   6. Enables auto-merge (squash, delete branch) unless --no-merge — the PR
//      merges itself the moment both required checks pass.
//   7. With --wait, blocks until the PR merges (timeout --wait-timeout
//      seconds, default 600) and reports the outcome — the whole landing,
//      end to end, in one command.
//
// Exit codes: 0 = PR created (and auto-merge armed unless --no-merge);
// 1 = nothing to commit / git or gh failed; 2 = wrong base branch.
// ============================================================================

import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

function run(cmd, opts = {}) {
  // With stdio 'inherit' execSync returns null (nothing is captured), so the
  // trim is null-safe — a null return is NOT a failure.
  const out = execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
  return out == null ? '' : String(out).trim();
}

function runQuiet(cmd) {
  return run(cmd, { silent: true });
}

function fail(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

// ---- parse arguments -------------------------------------------------------

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const MESSAGE = take('--message');
const BRANCH_FLAG = take('--branch');
const BASE = take('--base') || 'main';
const NO_MERGE = args.includes('--no-merge');
const WAIT = args.includes('--wait');
const WAIT_TIMEOUT_S = Number(take('--wait-timeout')) || 600;

if (!MESSAGE) {
  fail(1, 'a commit/PR message is required: node scripts/land-pr.mjs --message "fix: ..."');
}
if (WAIT && NO_MERGE) {
  fail(1, '--wait needs auto-merge — drop --no-merge (or drop --wait)');
}

// ---- guards ----------------------------------------------------------------

const ROOT = runQuiet('git rev-parse --show-toplevel');
process.chdir(ROOT);

const currentBranch = runQuiet('git rev-parse --abbrev-ref HEAD');
if (currentBranch !== BASE) {
  fail(2, `must be on ${BASE} to land (currently on ${currentBranch}) — commit on a branch works, but landing starts from ${BASE}`);
}

// git diff --cached --quiet exits 0 when there is nothing staged.
const HAS_STAGED = (() => {
  try {
    execSync('git diff --cached --quiet', { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
})();

const TREE_DIRTY = runQuiet('git status --porcelain') !== '';
if (!TREE_DIRTY) {
  fail(1, 'nothing to commit — the working tree is clean on ' + BASE);
}

// ---- derive the branch name ------------------------------------------------

let branch = BRANCH_FLAG;
if (!branch) {
  // "fix: expose the stuck-queue duration" -> "fix/expose-the-stuck-queue-duration"
  const match = MESSAGE.match(/^([a-z]+)(\([^)]+\))?:\s*(.+)$/i);
  const type = match ? match[1].toLowerCase() : 'land';
  const rest = (match ? match[3] : MESSAGE)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  branch = `${type}/${rest}`;
}

// ---- create the branch ------------------------------------------------------

try {
  run(`git checkout -b "${branch}"`);
} catch {
  fail(1, `branch \`${branch}\` could not be created (does it already exist?) — nothing was committed`);
}

// ---- commit ----------------------------------------------------------------

console.log(`\nLanding on branch \`${branch}\` (base \`${BASE}\`)\n`);
console.log('Files that will be included in the commit:');
console.log(runQuiet('git status --short'));
console.log('');

try {
  if (HAS_STAGED) {
    // Only the staged hunks land — unstaged/untracked work stays in the tree.
    run(`git commit -m "${MESSAGE.replace(/"/g, '\\"')}"`);
  } else {
    run(`git add -A && git commit -m "${MESSAGE.replace(/"/g, '\\"')}"`);
  }
} catch {
  fail(1, 'commit failed — nothing was committed');
}

// ---- push + PR + auto-merge -------------------------------------------------

try {
  run(`git push -u origin "${branch}"`);
} catch {
  fail(1, `push failed — branch \`${branch}\` committed locally but not pushed`);
}

// runQuiet so the URL is CAPTURED (run() inherits stdio and returns nothing
// — the PR number is needed to arm auto-merge).
const prUrl = (() => {
  try {
    return runQuiet(`gh pr create --base "${BASE}" --head "${branch}" --title "${MESSAGE.replace(/"/g, '\\"')}" --body "${MESSAGE.replace(/"/g, '\\"')}"`);
  } catch {
    fail(1, 'PR creation failed — the branch is pushed, create the PR manually');
  }
})();

const prNumber = prUrl.match(/(\d+)\s*$/)?.[1] || prUrl.split('/').pop();

if (NO_MERGE) {
  console.log(`\n✓ PR created (no auto-merge): ${prUrl}`);
  console.log(`  Merge it once both required checks are green: gh pr merge ${prNumber} --squash --delete-branch`);
} else {
  try {
    run(`gh pr merge "${prNumber}" --auto --squash --delete-branch`);
    console.log(`\n✓ PR created with auto-merge armed (squash): ${prUrl}`);
    console.log('  It merges itself once the required checks pass.');
  } catch {
    fail(1, `PR created at ${prUrl}, but arming auto-merge failed — merge it manually once checks are green`);
  }

  if (WAIT) {
    console.log(`  Waiting for PR #${prNumber} to merge (timeout ${WAIT_TIMEOUT_S}s)...`);
    const deadline = Date.now() + WAIT_TIMEOUT_S * 1000;
    let last = '';
    let merged = false;
    while (Date.now() < deadline) {
      await sleep(20_000);
      const state = runQuiet(`gh pr view "${prNumber}" --json state --jq .state`);
      if (state && state !== last) {
        console.log(`  [${new Date().toISOString().slice(11, 19)}] ${state}`);
        last = state;
      }
      if (state === 'MERGED') {
        merged = true;
        break;
      }
      if (state === 'CLOSED') break;
    }
    if (merged) {
      console.log(`\n✓ PR #${prNumber} MERGED — branch + PR + checks + merge completed in one command: ${prUrl}`);
    } else {
      fail(1, `PR #${prNumber} did not merge within ${WAIT_TIMEOUT_S}s (last state: ${last || 'unknown'}) — auto-merge stays armed, check ${prUrl}`);
    }
  }
}
