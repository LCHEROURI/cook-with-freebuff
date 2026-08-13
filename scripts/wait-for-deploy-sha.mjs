#!/usr/bin/env node
// ============================================================================
// scripts/wait-for-deploy-sha.mjs — poll a host until it serves the expected
// commit.
//
// `firebase deploy --only apphosting` can return while the rollout is still
// queued or building, so a post-deploy gate cannot trust the deploy job's
// exit code alone. This helper polls <host>/api/build-info (tokenless, public)
// until the served commit matches --expect, then exits 0 — the gate PROVES
// the host serves the pushed commit before exercising it. On timeout it
// exits 1 with the failing hop named.
//
// Usage:
//   node scripts/wait-for-deploy-sha.mjs --url <host> --expect <sha>
//       [--timeout <seconds>] [--interval <seconds>]
//
// Exit codes: 0 = the host serves the expected commit, 1 = timeout (or the
// host never exposed the commit). Read-only against the host.
// ============================================================================

import { fileURLToPath } from 'node:url';

export const PRODUCTION_URL = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';

/**
 * Parse CLI flags (same leading-space trim recovery as verify-deployed-hash).
 */
export function parseArgs(rawArgs) {
  const args = rawArgs.map((a) => a.trim());
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    url: flag('--url', PRODUCTION_URL),
    expect: flag('--expect', ''),
    timeoutMs: Number(flag('--timeout', '900')) * 1000,
    intervalMs: Number(flag('--interval', '20')) * 1000,
  };
}

/** Probe one host: the commit /api/build-info reports ('' on any failure). */
export async function probeBuildInfo(hostUrl) {
  const url = `${hostUrl.replace(/\/$/, '')}/api/build-info`;
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const body = await res.json().catch(() => null);
    return typeof body?.commitSha === 'string' ? body.commitSha : '';
  } catch {
    return '';
  }
}

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the host serves the expected commit. Injectable probe and sleep
 * keep the poll loop unit-testable without real HTTP or timers.
 * Returns { ok, sha, waitedSec }.
 */
export async function waitForDeploySha({ url, expect: EXPECT, timeoutMs, intervalMs, probe = probeBuildInfo, sleep = defaultSleep }) {
  const startedAt = Date.now();
  let lastSha = '';
  while (Date.now() - startedAt < timeoutMs) {
    lastSha = await probe(url);
    if (lastSha && lastSha.toLowerCase().startsWith(String(EXPECT).toLowerCase())) {
      return { ok: true, sha: lastSha, waitedSec: Math.round((Date.now() - startedAt) / 1000) };
    }
    await sleep(intervalMs);
  }
  return { ok: false, sha: lastSha, waitedSec: Math.round((Date.now() - startedAt) / 1000) };
}

async function main() {
  const { url: URL_TARGET, expect: EXPECT, timeoutMs, intervalMs } = parseArgs(process.argv.slice(2));
  if (!EXPECT) {
    console.error('✗ FAIL: --expect <sha> is required (the commit the host must serve).');
    process.exit(1);
  }
  const HOST = URL_TARGET.replace(/\/$/, '');
  console.log(`\nWaiting for ${HOST} to serve commit ${EXPECT} (timeout ${Math.round(timeoutMs / 1000)}s, poll every ${Math.round(intervalMs / 1000)}s)...`);

  const verdict = await waitForDeploySha({ url: HOST, expect: EXPECT, timeoutMs, intervalMs });
  if (verdict.ok) {
    console.log(`  ✓ host serves the expected commit (${verdict.sha.slice(0, 12)}…) after ${verdict.waitedSec}s`);
    console.log('\nRESULT: PASS');
    process.exit(0);
  }
  console.error(`  ✗ the rollout did not serve commit ${EXPECT} within ${Math.round(timeoutMs / 1000)}s (last served: ${verdict.sha || 'none — /api/build-info unanswered'})`);
  console.error('  The deploy job may have exited before the rollout built; re-run the job or investigate the rollout in App Hosting.');
  console.error('\nRESULT: FAIL');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
