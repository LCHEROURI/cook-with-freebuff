#!/usr/bin/env node
// ============================================================================
// scripts/verify-deployed-hash.mjs — report the exact commit a Firebase App
// Hosting host is serving, so the post-deploy gate never has to infer the
// hash from a successful push.
//
// App Hosting is the primary production host and its /api/build-info route is
// PUBLIC (a commit SHA carries no secrets), so there is no token, no API, no
// team resolution, and no CLI auth store anywhere in this script — the whole
// hash surface is a plain HTTP read.
//
// Usage:
//   node scripts/verify-deployed-hash.mjs
//     → the commit the canonical App Hosting URL serves
//   node scripts/verify-deployed-hash.mjs --url <host>
//     → the commit THAT host serves (any App Hosting or dev URL)
//   node scripts/verify-deployed-hash.mjs [--url <host>] --expect <sha>
//     → exits nonzero unless the served commit sha starts with <sha>; an
//       --expect assertion on a host exposing no commit FAILS (fail closed),
//       so the stale-head guard can never silently accept an unchecked push
//
// Exit codes: 0 = PASS, 1 = FAIL (mismatch or unverifiable --expect). Read-only
// against the host; no source changes.
// ============================================================================

import { fileURLToPath } from 'node:url';

export const PRODUCTION_URL = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';

/**
 * Parse CLI flags. Each raw arg is trimmed first: a GitHub Actions
 * plain-scalar `run: cmd \` block folds the trailing backslash-newline into
 * a literal backslash-space, so `--url "…"` arrives in bash as the single
 * word ` --url` (leading space). Trimming recovers the flag so the script
 * can never silently fall back to the default host because a flag lost its
 * leading position.
 */
export function parseArgs(rawArgs) {
  const args = rawArgs.map((a) => a.trim());
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    expect: flag('--expect'),
    url: flag('--url'),
  };
}

/**
 * Fetch the commit SHA an App Hosting build serves, via its `/api/build-info`
 * endpoint (inlined NEXT_PUBLIC_APP_COMMIT_SHA at build time). Returns ''
 * when the route is missing or the build predates the endpoint — the caller
 * treats that as unverifiable, never a mismatch.
 */
export async function resolveAppHostingCommit(hostUrl) {
  const url = `${hostUrl.replace(/\/$/, '')}/api/build-info`;
  const res = await fetch(url);
  if (!res.ok) return '';
  const body = await res.json().catch(() => null);
  return typeof body?.commitSha === 'string' ? body.commitSha : '';
}

async function main() {
  const { expect: EXPECT, url: URL_TARGET } = parseArgs(process.argv.slice(2));
  const HOST = (URL_TARGET ?? PRODUCTION_URL).replace(/\/$/, '');

  console.log(`\nApp Hosting: ${HOST}`);
  const sha = await resolveAppHostingCommit(HOST);
  console.log(`  commit  ${sha || '(unknown — /api/build-info missing or predates the endpoint)'}`);

  if (!EXPECT) {
    console.log('\nRESULT: PASS (deployed hash reported)');
    process.exit(0);
  }

  if (!sha) {
    // Fail CLOSED: an --expect assertion that cannot be verified must not
    // report PASS, or the stale-head guard (and the gate that wraps it) would
    // silently accept an unchecked push while production's commit is unknown.
    console.error('  ✗ no commit exposed by this host — cannot verify against --expect');
    console.error('\nRESULT: FAIL (unverifiable — the live commit is unknown, so the expected sha cannot be confirmed)');
    process.exit(1);
  }

  if (sha.toLowerCase().startsWith(EXPECT.toLowerCase())) {
    console.log(`\n  ✓ served commit matches --expect ${EXPECT}`);
    console.log('\nRESULT: PASS');
    process.exit(0);
  }

  console.error(`\n  ✗ served commit ${sha} does not match --expect ${EXPECT}`);
  console.error('\nRESULT: FAIL');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
