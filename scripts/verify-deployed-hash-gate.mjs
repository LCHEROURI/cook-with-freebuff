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
// Usage:
//   npm run verify:deployed-hash
//
// Read-only against Vercel and git; no source changes.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const CANONICAL_URL = 'https://cook-with-freebuff.vercel.app';

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
// stdio inherited so the child's report (commit / url / created / project)
// and its RESULT: verdict reach the operator exactly as written.
const child = spawnSync(
  process.execPath,
  ['scripts/verify-deployed-hash.mjs', '--url', CANONICAL_URL, '--expect', LOCAL_HEAD],
  { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit' },
);

// ── 3. Mirror the child's verdict ───────────────────────────────────────────
const code = child.status ?? 1;
if (code === 2) {
  // The child already printed the invalid/revoked-token guidance. Exit 2 is
  // kept distinct from FAIL so callers can treat credentials separately.
  process.exit(2);
}
process.exit(code);
