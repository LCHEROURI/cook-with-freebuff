#!/usr/bin/env node
// ============================================================================
// scripts/tidy-branches.mjs — prune stale remote-tracking refs and delete
// merged local branches in one command, so the tidy state is one invocation
// away.
//
//   node scripts/tidy-branches.mjs                  # prune + delete merged branches
//   node scripts/tidy-branches.mjs --dry-run        # report what would change, change nothing
//   node scripts/tidy-branches.mjs --report <file>  # read-only scan: write a findings report,
//                                                   # touch NOTHING (for the weekly workflow)
//
// Three passes, all safe by construction:
//   1. `git remote prune origin` drops local tracking refs for branches that
//      were deleted server-side (the refs `git branch -r` would otherwise
//      keep showing after a teammate's branch cleanup).
//   2. `git branch -d` deletes branches fully merged into the base (main, or
//      the current branch if main does not exist). `-d` REFUSES an unmerged
//      branch — git enforces the "fully merged" claim, never the script.
//   3. The squash-merge blind spot: git ancestry cannot see a squash merge,
//      so a squash-merged branch's tip is NOT an ancestor of main and `--merged`
//      never lists it. This pass asks GitHub in ONE call (`gh pr list --state
//      merged`) which PR head branches were merged, intersects that with the
//      remaining local branches, and force-deletes only a branch whose PR is
//      confirmed merged on GitHub — the platform check replaces the blind
//      force delete. If gh is unavailable or the branch has no merged PR, the
//      branch is kept with a visible note, never force-deleted.
//
// --report mode: the weekly maintenance workflow (branch-tidy-weekly.yml)
// runs this read-only so it can OPEN A PR instead of mutating the repo. It
// runs the same detections (dry-run prune, --merged list, merged-PR squash
// check) PLUS a remote scan: because delete_branch_on_merge is OFF in this
// repo, merged PR head branches accumulate ON ORIGIN, and a fresh CI checkout
// has no local branches to tidy — so the remote list is the accumulation that
// matters on a schedule. The report lists every remote branch whose merged
// PR's headRefOid equals the remote tip (safe to delete via `git push origin
// --delete <name>`) with its PR number, prints `FINDINGS: N`, and touches
// nothing. Exit 0 either way; the workflow branches on the FINDINGS line.
//
// The current branch and the base itself are always skipped. Every git and gh
// call goes through execFileSync with an ARGUMENT ARRAY — never a shell string
// — so a branch name containing shell metacharacters (git allows names like
// `evil;touch$IFS/tmp/pwn`) is passed literally and can never be executed or
// expanded (Codex P1, PR #139 review). Deletions are verified after the fact
// in every pass: a branch is only reported deleted when it is provably gone
// (rev-parse --verify refs/heads/<name>) (Codex P2, PR #139 review).
// ============================================================================

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const reportIdx = args.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 && args[reportIdx + 1] ? args[reportIdx + 1] : null;
const REPORT_MODE = REPORT_PATH !== null;

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

const localBranches = () =>
  run('git', ['branch', '--format', '%(refname:short)'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

// One gh call: head branch → { number, headRefOid } for every merged PR.
// headRefOid is the merged PR's head commit, which must EQUAL the local
// branch's tip before a force delete — a reused branch name (or a fork's
// merged PR with the same name) can otherwise match by name alone and delete
// NEW unmerged commits (Codex P1, PR #140 review). Returns a Map, or null
// when gh is unavailable (missing binary, unauthenticated, or the call
// failed) — the caller then KEEPS squash candidates instead of force-deleting
// blind.
const mergedPrHeads = () => {
  try {
    const out = run('gh', ['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid,number', '--limit', '1000']);
    return new Map(JSON.parse(out).map((pr) => [pr.headRefName, { number: pr.number, headRefOid: pr.headRefOid }]));
  } catch {
    return null;
  }
};

const localTip = (name) => {
  try {
    return run('git', ['rev-parse', 'refs/heads/' + name]);
  } catch {
    return null;
  }
};

// Remote branch name → tip sha, from origin (no fetch needed). The base
// (main) is dropped: a merged-PR list can never justify deleting main.
const remoteBranches = () => {
  const out = run('git', ['ls-remote', '--heads', 'origin']).trim();
  if (!out) return new Map();
  return new Map(
    out
      .split('\n')
      .map((line) => {
        const m = line.match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/);
        return m ? [m[2], m[1]] : null;
      })
      .filter(Boolean),
  );
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
let staleRefs = [];
if (REPORT_MODE || DRY_RUN) {
  const dry = run('git', ['remote', 'prune', '--dry-run', 'origin']).trim();
  staleRefs = dry ? dry.split('\n').map((l) => l.trim()) : [];
  if (staleRefs.length === 0) {
    skip('nothing stale');
  } else {
    for (const line of staleRefs) step(`would ${line}`);
  }
} else {
  const out = run('git', ['remote', 'prune', 'origin']).trim();
  if (out) {
    for (const line of out.split('\n')) step(line.trim());
  } else {
    skip('nothing stale');
  }
}

// ── Pass 2: delete branches fully merged into the base (git-visible) ────────
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
    if (REPORT_MODE || DRY_RUN) {
      step(`would delete ${name}`);
      continue;
    }
    let refused = false;
    try {
      // `-d` refuses unmerged (incl. squash-merged) branches AND branches not
      // merged into ITS base (upstream, or HEAD) when that differs from the
      // --merged list's base — both throw here, recorded, never force-deleted.
      run('git', ['branch', '-d', name]);
    } catch {
      refused = true;
    }
    if (refused || branchExists(name)) {
      // Either -d refused outright, or it reported success but the branch is
      // still present. Do NOT force-delete here: the GitHub confirmation for
      // squash merges lives in pass 3, which checks this branch too.
      skip(`kept ${name} (git sees it merged into ${base} but -d refused — pass 3 checks GitHub)`);
    } else {
      step(`deleted ${name}`);
    }
  }
}

// ── Pass 3: squash-merged branches, confirmed against GitHub ────────────────
console.log(`\nLocal branches with a MERGED PR on GitHub (squash-merge blind spot):`);
const prHeads = mergedPrHeads();
let localSquash = [];
let localTipDiffers = [];
if (prHeads === null) {
  skip('gh unavailable (missing, unauthenticated, or failed) — squash-merged branches kept; verify manually with gh pr view before any -D');
} else {
  // A name match alone is NOT proof: the merged PR's headRefOid must equal the
  // local branch's tip, or a reused/fork branch name would delete new work
  // (Codex P1, PR #140 review). Three outcomes per local branch:
  //   • tip == merged PR head  → force delete (the ONLY -D in the script)
  //   • name matches, tip differs → KEPT, visible note (possible reused name
  //     or fork PR — new work must never be deleted on a name match)
  //   • no merged PR at all    → not a candidate, skipped silently
  const named = localBranches().filter((name) => name !== base && name !== current && prHeads.has(name));
  localSquash = named.filter((name) => localTip(name) === prHeads.get(name).headRefOid);
  localTipDiffers = named.filter((name) => localTip(name) !== prHeads.get(name).headRefOid);
  if (named.length === 0) {
    skip('none');
  } else {
    for (const name of localTipDiffers) {
      // Visible, not silent: the name matches a merged PR but the tip does not
      // — this is either a reused branch name with new work (must stay) or a
      // fork's PR that merely shares the name. Never deleted on name alone.
      skip(`kept ${name} (matches merged PR #${prHeads.get(name).number} but the tip differs — possible reused/fork name with new work; left alone)`);
    }
    for (const name of localSquash) {
      const pr = prHeads.get(name).number;
      if (REPORT_MODE || DRY_RUN) {
        step(`would delete ${name} (squash-merged — PR #${pr} merged on GitHub, tip matches)`);
        continue;
      }
      let refused = false;
      try {
        // The ONLY force delete in the script, and only after GitHub confirmed
        // the branch's PR is merged AND its tip equals the merged PR's head —
        // the platform check replaces the blind -D.
        run('git', ['branch', '-D', name]);
      } catch {
        refused = true;
      }
      if (refused || branchExists(name)) {
        skip(`kept ${name} (PR #${pr} merged but the branch would not delete — investigate)`);
      } else {
        step(`deleted ${name} (squash-merged — PR #${pr} merged on GitHub, tip matches)`);
      }
    }
  }
}

// ── Pass 4 (report mode only): remote branches with a merged PR ─────────────
// delete_branch_on_merge is OFF in this repo, so merged PR head branches stay
// on origin — the accumulation a weekly schedule must surface. Same proof as
// pass 3: the remote tip must EQUAL the merged PR's headRefOid, so a reused
// name can never be listed as cleanable.
let remoteSquash = [];
let remoteTipDiffers = [];
if (REPORT_MODE) {
  console.log(`\nRemote branches (origin) with a MERGED PR on GitHub:`);
  if (prHeads === null) {
    skip('gh unavailable — cannot confirm remote squash merges');
  } else {
    const remotes = remoteBranches();
    const named = [...remotes.keys()].filter((name) => name !== base && prHeads.has(name));
    remoteSquash = named.filter((name) => remotes.get(name) === prHeads.get(name).headRefOid);
    remoteTipDiffers = named.filter((name) => remotes.get(name) !== prHeads.get(name).headRefOid);
    if (named.length === 0) {
      skip('none');
    } else {
      for (const name of remoteTipDiffers) {
        skip(`kept ${name} (matches merged PR #${prHeads.get(name).number} but the remote tip differs — possible reused/fork name; left alone)`);
      }
      for (const name of remoteSquash) {
        step(`cleanable ${name} (PR #${prHeads.get(name).number} merged on GitHub, remote tip matches — safe to git push origin --delete ${name})`);
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (REPORT_MODE) {
  const findings =
    staleRefs.length + merged.length + localSquash.length + remoteSquash.length;
  const lines = [
    '# Weekly branch tidy report',
    '',
    `Generated ${new Date().toISOString()} by scripts/tidy-branches.mjs (report mode). Read only: nothing was changed.`,
    `Base: \`${base}\`. A branch is listed as cleanable only when GitHub confirms its PR merged AND the tip matches the merged PR head.`,
    '',
    `## Stale remote-tracking refs (${staleRefs.length})`,
    ...(staleRefs.length ? staleRefs.map((l) => `- \`${l}\``) : ['- none']),
    '',
    `## Local branches fully merged into ${base} (${merged.length})`,
    ...(merged.length ? merged.map((n) => `- \`${n}\``) : ['- none']),
    '',
    `## Local squash-merged branches (tip matches merged PR head) (${localSquash.length})`,
    ...(localSquash.length ? localSquash.map((n) => `- \`${n}\` — PR #${prHeads.get(n).number}`) : ['- none']),
    '',
    `## Remote branches with a merged PR on origin (tip matches merged PR head) (${remoteSquash.length})`,
    ...(remoteSquash.length ? remoteSquash.map((n) => `- \`${n}\` — PR #${prHeads.get(n).number} (delete with \`git push origin --delete ${n}\`)`) : ['- none']),
    '',
    `## Kept (name matches a merged PR but the tip differs — reused/fork risk) (${localTipDiffers.length + remoteTipDiffers.length})`,
    ...(localTipDiffers.length ? localTipDiffers.map((n) => `- \`${n}\` — local, PR #${prHeads.get(n).number}`) : []),
    ...(remoteTipDiffers.length ? remoteTipDiffers.map((n) => `- \`${n}\` — remote, PR #${prHeads.get(n).number}`) : []),
    '',
    `FINDINGS: ${findings}`,
    '',
  ];
  const report = lines.join('\n');
  writeFileSync(REPORT_PATH, report);
  console.log(`\n${report}`);
  console.log(`\nReport written to ${REPORT_PATH}`);
  process.exit(0);
}

console.log(`\nRESULT: ${DRY_RUN ? 'DRY RUN (nothing changed)' : 'PASS (branches tidy)'}`);
process.exit(0);
