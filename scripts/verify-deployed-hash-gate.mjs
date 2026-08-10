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
//   DIRECTION decides. If live is an ancestor of local HEAD the push is a
//   forward deploy — pass (exit 0) and leave the after-deploy proof to the
//   post-deploy workflow. If live is NOT an ancestor (a stale/rollback push
//   would clobber production) — fail with a STALE-HEAD BLOCK. A normal
//   forward push is live-behind-HEAD by construction, so without the
//   direction check a push-time gate would fail every healthy push.
//
// Usage:
//   npm run verify:deployed-hash                      # plain report + expect
//   node scripts/verify-deployed-hash-gate.mjs --stale-guard   # CI push gate
//
// Read-only against Vercel and git; no source changes.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const CANONICAL_URL = 'https://cook-with-freebuff.vercel.app';
export const STALE_GUARD = process.argv.includes('--stale-guard');

// ── 1. Local HEAD ───────────────────────────────────────────────────────────
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.status !== 0 || !head.stdout.trim()) {
  console.error('✗ FAIL: could not resolve local HEAD (git rev-parse HEAD failed).');
  process.exit(1);
}
const LOCAL_HEAD = head.stdout.trim();

console.log('\n=== verify:deployed-hash — live commit vs local HEAD (before any deploy) ===');
console.log(`  local HEAD  ${LOCAL_HEAD}`);

// ── 2. Run the shared hash driver against the live production alias ────────
// stdio piped so --stale-guard can parse the live commit from the report;
// the child's output is forwarded verbatim either way.
const child = spawnSync(
  process.execPath,
  ['scripts/verify-deployed-hash.mjs', '--url', CANONICAL_URL, '--expect', LOCAL_HEAD],
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

const anc = spawnSync('git', ['merge-base', '--is-ancestor', live, 'HEAD']);
if (anc.status === 0) {
  console.log(`\n  ✓ live (${live.slice(0, 12)}…) is behind local HEAD — forward deploy; the post-deploy gate verifies after Vercel finishes`);
  console.log('RESULT: PASS (stale-guard)');
  process.exit(0);
}

console.error(`\n  ✗ STALE-HEAD BLOCK: live is at ${live} and the pushed HEAD (${LOCAL_HEAD.slice(0, 12)}…) is not ahead of it.`);
console.error('  Pushing would roll the site back or clobber history — pull/rebase first.');
console.error('  RESULT: FAIL');
process.exit(1);
