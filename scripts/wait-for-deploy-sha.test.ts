import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// ============================================================================
// scripts/wait-for-deploy-sha.test.ts — lock scripts/wait-for-deploy-sha.mjs.
//
// The wait-for-sha poll is the load-bearing half of the App Hosting primary
// migration: `firebase deploy --only apphosting` can return while the rollout
// is still building, so the post-deploy gate polls the host's /api/build-info
// (tokenless) until it serves the pushed commit. These tests drive the poll
// loop with injected probe/sleep (no real HTTP or timers) and lock:
//
//   1. The poll loop polls until the served commit matches --expect
//      (prefix match, case-insensitive), reporting the waited seconds.
//   2. A timeout where the host never serves the expected commit returns
//      { ok: false } with the last seen sha — the CLI fails loudly with the
//      hop named.
//   3. Flag parsing (defaults, time conversions, trim recovery).
//   4. Tokenless: no VERCEL_TOKEN anywhere.
// ============================================================================

import { PRODUCTION_URL, parseArgs, waitForDeploySha } from './wait-for-deploy-sha.mjs';

const SCRIPT_SRC = readFileSync('scripts/wait-for-deploy-sha.mjs', 'utf8');

const instantSleep = async () => {};

describe('waitForDeploySha · poll loop', () => {
  it('returns ok immediately when the host already serves the expected commit', async () => {
    const probe = vi.fn().mockResolvedValue('abc123def456');
    const verdict = await waitForDeploySha({
      url: 'https://x.hosted.app',
      expect: 'abc123',
      timeoutMs: 900_000,
      intervalMs: 20_000,
      probe,
      sleep: instantSleep,
    });
    expect(verdict).toEqual({ ok: true, sha: 'abc123def456', waitedSec: 0 });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps polling until the host catches up (prefix match, case-insensitive)', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('deadbeef')
      .mockResolvedValueOnce('ABC123dead');
    const verdict = await waitForDeploySha({
      url: 'https://x.hosted.app',
      expect: 'abc123',
      timeoutMs: 900_000,
      intervalMs: 20_000,
      probe,
      sleep: instantSleep,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.sha).toBe('ABC123dead');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('times out with { ok: false } and the last seen sha when the commit never appears', async () => {
    const probe = vi.fn().mockResolvedValue('deadbeef');
    const verdict = await waitForDeploySha({
      url: 'https://x.hosted.app',
      expect: 'abc123',
      timeoutMs: 100,
      intervalMs: 20_000, // irrelevant — sleep is instant, the timeout bounds the loop
      probe,
      sleep: instantSleep,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.sha).toBe('deadbeef');
    // The loop is bounded by the Date.now() budget: it terminates with a
    // finite number of probes even when probe + sleep are instant (in
    // production the 20s interval bounds it to ~45 probes per 15-min timeout).
    expect(probe.mock.calls.length).toBeGreaterThan(0);
  });

  it('treats a never-answering host as a timeout, not a match', async () => {
    const probe = vi.fn().mockResolvedValue('');
    const verdict = await waitForDeploySha({
      url: 'https://x.hosted.app',
      expect: 'abc123',
      timeoutMs: 100,
      intervalMs: 20_000,
      probe,
      sleep: instantSleep,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.sha).toBe('');
  });
});

describe('parseArgs · flags and defaults', () => {
  it('defaults the URL to the canonical App Hosting production URL and converts seconds', () => {
    expect(parseArgs([])).toEqual({
      url: PRODUCTION_URL,
      expect: '',
      timeoutMs: 900_000,
      intervalMs: 20_000,
    });
  });

  it('parses --url / --expect / --timeout / --interval', () => {
    expect(parseArgs(['--url', 'https://x.hosted.app', '--expect', 'abc123', '--timeout', '60', '--interval', '5'])).toEqual({
      url: 'https://x.hosted.app',
      expect: 'abc123',
      timeoutMs: 60_000,
      intervalMs: 5_000,
    });
  });

  it('recovers flags that lost their leading position (GH Actions block-scalar trim)', () => {
    expect(parseArgs([' --expect', 'abc123'])).toEqual({
      url: PRODUCTION_URL,
      expect: 'abc123',
      timeoutMs: 900_000,
      intervalMs: 20_000,
    });
  });
});

describe('constants · project identity', () => {
  it('targets the App Hosting canonical URL as the production URL', () => {
    expect(PRODUCTION_URL).toBe('https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
  });
});

describe('contract lock · tokenless by design', () => {
  it('has no Vercel machinery', () => {
    expect(SCRIPT_SRC).not.toContain('VERCEL_TOKEN');
    expect(SCRIPT_SRC).not.toContain('vercel.com');
  });
});
