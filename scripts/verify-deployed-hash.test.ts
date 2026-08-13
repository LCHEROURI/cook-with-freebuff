import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// scripts/verify-deployed-hash.test.ts — lock scripts/verify-deployed-hash.mjs.
//
// Same discipline as ci-workflows.test.ts: read the REAL script (never a
// fixture) and lock the load-bearing contracts so a future edit that silently
// breaks the hash gate fails here:
//
//   1. The script is TOKENLESS — the live commit comes from the host's public
//      /api/build-info, so there is no VERCEL_TOKEN chain, no Vercel API, no
//      team resolution, no CLI auth store, and no exit-2 credential path. A
//      regression that reintroduces any of that machinery fails the negative
//      lock below.
//   2. --url / --expect flag handling — including the leading-space trim
//      recovery (the GitHub Actions plain-scalar `run:` backslash trap) and
//      the null-for-missing-value contract.
//   3. resolveAppHostingCommit maps /api/build-info to the commit sha, with
//      missing route or missing sha → '' (the caller fails CLOSED on that
//      when an --expect assertion is in play).
//   4. The canonical production URL is the App Hosting URL.
// ============================================================================

import { PRODUCTION_URL, parseArgs, resolveAppHostingCommit } from './verify-deployed-hash.mjs';

const SCRIPT_SRC = readFileSync('scripts/verify-deployed-hash.mjs', 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contract lock · tokenless by design (no Vercel machinery)', () => {
  it('has no token chain, no Vercel API, no team resolution, and no exit-2 credential path', () => {
    // The whole point of the App Hosting primary migration: the hash surface
    // is a plain HTTP read of a public route. Any of these returning would
    // silently reintroduce a credential dependency the pipeline no longer has.
    expect(SCRIPT_SRC).not.toContain('VERCEL_TOKEN');
    expect(SCRIPT_SRC).not.toContain('vercel.com');
    expect(SCRIPT_SRC).not.toContain('api.vercel.com');
    expect(SCRIPT_SRC).not.toContain('com.vercel.cli');
    expect(SCRIPT_SRC).not.toContain('.env.local');
    expect(SCRIPT_SRC).not.toContain('process.exit(2)');
    expect(SCRIPT_SRC).not.toContain('invalidToken');
  });

  it('still carries the trim-recovery comment that documents the Actions backslash trap', () => {
    // The leading-space trim exists because a plain-scalar `run: cmd \` block
    // folds the trailing backslash-newline into a literal backslash+space —
    // without the trim, --url could silently fall back to the default host.
    expect(SCRIPT_SRC).toContain('leading position');
  });
});

describe('parseArgs · --url / --expect handling', () => {
  it('parses both flags in any order', () => {
    expect(parseArgs(['--expect', 'abc123', '--url', 'https://u.hosted.app'])).toEqual({
      expect: 'abc123',
      url: 'https://u.hosted.app',
    });
  });

  it('recovers flags that lost their leading position (GH Actions block-scalar trim)', () => {
    expect(parseArgs([' --expect', 'abc123'])).toEqual({ expect: 'abc123', url: null });
    expect(parseArgs(['--url ', 'https://u.hosted.app '])).toEqual({
      expect: null,
      url: 'https://u.hosted.app',
    });
  });

  it('returns null for a flag with no value (never an undefined comparison)', () => {
    expect(parseArgs(['--expect'])).toEqual({ expect: null, url: null });
  });

  it('returns all-null when no flags are given (plain report mode)', () => {
    expect(parseArgs([])).toEqual({ expect: null, url: null });
  });
});

describe('resolveAppHostingCommit · /api/build-info → commit sha', () => {
  it('returns the commitSha from a healthy build-info response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commitSha: 'abc123def456', builtAt: '2026-08-12T00:00:00.000Z' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const sha = await resolveAppHostingCommit('https://x.hosted.app');
    expect(fetchMock).toHaveBeenCalledWith('https://x.hosted.app/api/build-info');
    expect(sha).toBe('abc123def456');
  });

  it('returns empty when the route 404s or predates the endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await resolveAppHostingCommit('https://x.hosted.app')).toBe('');
  });

  it('returns empty when the body has no commitSha', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await resolveAppHostingCommit('https://x.hosted.app')).toBe('');
  });
});

describe('constants · project identity', () => {
  it('targets the App Hosting canonical URL as the production URL', () => {
    expect(PRODUCTION_URL).toBe('https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
  });
});

describe('main() · fail-closed --expect (Codex P1)', () => {
  it('FAILS when --expect is given but the host exposes no commit — never a PASS that lets the stale-head guard silently through', () => {
    // The old behavior exited 0 ("unverifiable skip") when build-info was
    // missing, so verify-deployed-hash-gate.mjs's `code !== 1` branch passed
    // while production's commit was unknown. An unverifiable assertion must
    // fail closed.
    expect(SCRIPT_SRC).toContain("if (!EXPECT)");
    expect(SCRIPT_SRC).toContain("if (!sha)");
    expect(SCRIPT_SRC).toContain('RESULT: FAIL (unverifiable — the live commit is unknown');
    expect(SCRIPT_SRC).toContain('process.exit(1)');
    expect(SCRIPT_SRC).not.toContain('RESULT: PASS (unverifiable)');
  });
});
