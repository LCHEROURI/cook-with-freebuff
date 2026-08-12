#!/usr/bin/env node
// ============================================================================
// scripts/verify-deployed-hash-gate.mjs — the verify:deployed-hash gate.
//
// Reports the commit Vercel is CURRENTLY serving and compares it against
// local HEAD, so you know what you are about to change before any deploy.
// It composes the existing shared driver (scripts/verify-deployed-hash.mjs)
// rather than reimplementing its machinery — the same token-resolution chain,
// team resolution, v13 host lookup, and exit-code contract the CI
// deployment_status gate uses, so the local gate and the post-deploy gate can
// never disagree about what "the live commit" means.
//
//   1. Resolves local HEAD (git rev-parse HEAD).
//   2. Runs verify-deployed-hash.mjs with
//        --url https://cook-with-freebuff.vercel.app   (the live production
//            alias — public, not deployment-protected)
//        --expect <local HEAD>
//      which prints the live commit / url / created and asserts the deployed
//      sha matches local HEAD.
//   3. Forwards the child's verdict verbatim and mirrors its exit code:
//        0 = PASS — live is exactly your HEAD
//        1 = FAIL — live commit ≠ local HEAD (you are about to deploy a
//            change, or the site has not caught up — deploy first, re-run)
//        2 = VERCEL_TOKEN invalid/revoked (the child printed the
//            paste-a-fresh-token guidance) — kept distinct so a caller can
//            surface it as a credential problem, never a generic failure
//
//   --stale-guard (the CI push-time mode): on the exit-1 mismatch the
//   DIRECTION decides. If live is an ancestor of the expected head the push
//   is a forward deploy — pass (exit 0) and leave the after-deploy proof to
//   the post-deploy workflow. If live is NOT an ancestor (a stale/rollback
//   push would clobber production) — fail with a STALE-HEAD BLOCK. A normal
//   forward push is live-behind-HEAD by construction, so without the
//   direction check a push-time gate would fail every healthy push.
//
//   --head <sha> (the CI PR-time variant): pins the compared-against commit
//   to the PR head (github.event.pull_request.head.sha) instead of the local
//   checkout's HEAD. That matters on PRs because the checkout is the MERGE
//   ref — which always contains current base main, so comparing against it
//   would make every stale PR pass. The direction rule is the same, applied
//   to the PR head: FAIL iff live is NOT an ancestor of the PR head (the PR
//   was cut before live's current state — stale, update the branch); PASS if
//   the PR head already contains the entire live state.
//
// Usage:
//   npm run verify:deployed-hash                      # plain report + expect
//   node scripts/verify-deployed-hash-gate.mjs --stale-guard   # CI push gate
//   node scripts/verify-deployed-hash-gate.mjs --stale-guard --head <pr-sha>
//                                                      # CI PR gate
//
// Read-only against Vercel and git; no source changes.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const CANONICAL_URL = 'https://cook-with-freebuff.vercel.app';
export const APPHOSTING_URL = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';
export const STALE_GUARD = process.argv.includes('--stale-guard');
const headArgIdx = process.argv.indexOf('--head');
export const HEAD_ARG = headArgIdx !== -1 ? (process.argv[headArgIdx + 1] ?? '').trim() : '';

// ── 1. Expected head ─────────────────────────────────────────────────────────
// --head <sha> pins the compared-against commit (PR head in CI); without it
// local HEAD is resolved via git (the operator / push-time contract).
let LOCAL_HEAD;
if (HEAD_ARG) {
  LOCAL_HEAD = HEAD_ARG;
} else {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0 || !head.stdout.trim()) {
    console.error('✗ FAIL: could not resolve local HEAD (git rev-parse HEAD failed).');
    process.exit(1);
  }
  LOCAL_HEAD = head.stdout.trim();
}
const headLabel = HEAD_ARG ? 'PR head' : 'local HEAD';

console.log('\n=== verify:deployed-hash — live commit vs expected head (before any deploy) ===');
console.log(`  ${headLabel}  ${LOCAL_HEAD}`);

// ── 2. Run the shared hash driver against the live production alias + the
// Firebase App Hosting URL (both asserted against the same expected head) ───
// stdio piped so --stale-guard can parse the live commit from the report;
// the child's output is forwarded verbatim either way.
const child = spawnSync(
  process.execPath,
  ['scripts/verify-deployed-hash.mjs', '--url', CANONICAL_URL, '--apphosting-url', APPHOSTING_URL, '--expect', LOCAL_HEAD],
  { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
);
const childOut = `${child.stdout ?? ''}${child.stderr ?? ''}`;
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);

// ── 3. Mirror the child's verdict ───────────────────────────────────────────
const code = child.status ?? 1;
if (code === 2) {
  // The child already printed the invalid/revoked-token guidance. Exit 2 is
  // kept distinct from FAIL so callers can treat credentials separately.
  process.exit(2);
}
if (code !== 1) process.exit(code);

// ── 4. exit 1: live ≠ local HEAD — the direction decides (--stale-guard) ──
// Without the flag the plain mismatch is the verdict. With it, only a STALE
// head fails; a forward deploy passes here and is proven after deploy.
if (!STALE_GUARD) process.exit(1);

const live = childOut.match(/^  commit  ([0-9a-f]{40})$/m)?.[1] ?? '';
if (!live) {
  // No live sha (offline, API error, or no deployment yet): we cannot make
  // the direction call, and a silently-green broken gate is the failure mode
  // this guard exists to prevent — fail loudly.
  console.error('✗ FAIL: could not determine the live commit — cannot guard against a stale-head push.');
  process.exit(1);
}

// Ensure the ancestry check has a real object graph to walk. The CI checkout
// is shallow (fetch-depth 1): HEAD is a boundary with NO parents, so
// `git merge-base --is-ancestor live HEAD` can never walk back to live and
// would falsely block EVERY forward push (the direction call sees HEAD as a
// root and concludes "not ahead"). Unshallow first — GitHub serves full
// history — so HEAD's parent chain exists; then fetch each commit by sha as a
// fallback for the PR-head case, where the head lives on an unmerged branch
// not reachable from origin/main. Without either, `git merge-base` on a
// missing object exits 128 (or a future git change silently flips the
// verdict) — and a silently-green broken guard is the failure this exists to
// prevent.
if (spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).stdout.trim() === 'true') {
  if (spawnSync('git', ['fetch', '--quiet', '--unshallow', 'origin']).status !== 0) {
    console.error('✗ FAIL: could not deepen the shallow checkout for the ancestry check — cannot guard against a stale-head push.');
    process.exit(1);
  }
}
const ensureCommit = (sha) => {
  if (spawnSync('git', ['cat-file', '-e', sha]).status === 0) return true;
  return spawnSync('git', ['fetch', '--quiet', 'origin', sha]).status === 0;
};
if (!ensureCommit(live) || !ensureCommit(LOCAL_HEAD)) {
  console.error('✗ FAIL: could not fetch the commits needed for the ancestry check — cannot guard against a stale head.');
  process.exit(1);
}

const anc = spawnSync('git', ['merge-base', '--is-ancestor', live, LOCAL_HEAD]);
if (anc.status === 0) {
  console.log(`\n  ✓ live (${live.slice(0, 12)}…) is behind ${headLabel} — forward deploy; the post-deploy gate verifies after Vercel finishes`);
  console.log('RESULT: PASS (stale-guard)');
  process.exit(0);
}

console.error(`\n  ✗ STALE-HEAD BLOCK: live is at ${live} and the ${headLabel} (${LOCAL_HEAD.slice(0, 12)}…) is not ahead of it.`);
console.error('  Pushing would roll the site back or clobber history — pull/rebase first.');
console.error('  RESULT: FAIL');
process.exit(1);
