import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// scripts/verify-deployed-hash.test.ts — lock scripts/verify-deployed-hash.mjs.
//
// Same discipline as verify-live-local.test.ts / ci-workflows.test.ts: read
// the REAL script (never a fixture) and lock the load-bearing contracts so a
// future edit that silently breaks the post-deploy hash gate fails here:
//
//   1. Token-resolution chain — VERCEL_TOKEN env → .env.local (quotes
//      stripped) → the Vercel CLI auth store. The chain ORDER and each
//      fallback are asserted with a mocked node:fs so tests never depend on
//      the real .env.local (whose token value may rotate).
//   2. --url / --expect / --compare-url flag handling — including the
//      leading-space trim recovery (the GitHub Actions plain-scalar `run:`
//      backslash trap that once made the script silently fall back to the
//      list branch) and the null-for-missing-value contract.
//   3. The invalid-token exit-2 path — Vercel flags a dead/revoked token
//      with invalidToken: true; the script must detect it, thread the
//      __INVALID_TOKEN__ marker from resolveByHost through main's catch
//      sites, and exit 2 (never 1), so CI shows the paste-a-fresh-token
//      guidance instead of a generic failure.
//
// The exit-2 path is proven END TO END: the real script is spawned in a child
// process with a stub preloaded onto globalThis.fetch, so main() runs its full
// URL-target branch and the child genuinely exits 2.
// ============================================================================

// Shared state between the vi.mock factory (which runs at import time, before
// the body) and the test body: the REAL fs functions, captured so string-lock
// tests and the exit-2 spawn test can bypass the mock.
const fsRef = vi.hoisted(() => ({
  realReadFileSync: null as null | typeof import('node:fs')['readFileSync'],
  realWriteFileSync: null as null | typeof import('node:fs')['writeFileSync'],
  realRmSync: null as null | typeof import('node:fs')['rmSync'],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  fsRef.realReadFileSync = actual.readFileSync;
  fsRef.realWriteFileSync = actual.writeFileSync;
  fsRef.realRmSync = actual.rmSync;
  return { ...actual, readFileSync: vi.fn() };
});

import {
  INVALID_TOKEN_MESSAGE,
  PROJECT,
  PRODUCTION_URL,
  compareDrift,
  extractSha,
  isInvalidToken,
  parseArgs,
  readToken,
  resolveByHost,
} from './verify-deployed-hash.mjs';

const SCRIPT_SRC = String(fsRef.realReadFileSync?.('scripts/verify-deployed-hash.mjs', 'utf8') ?? '');

// ── Deterministic readToken inputs (the mocked readFileSync dispatches on
// ── path so each source in the chain can be controlled independently) ───────
let envLocalContent: string | undefined;
let cliStoreContent: string | undefined;

beforeEach(() => {
  envLocalContent = undefined;
  cliStoreContent = undefined;
  const mock = vi.mocked(readFileSync);
  mock.mockReset();
  mock.mockImplementation((p) => {
    const path = String(p);
    if (path.includes('.env.local')) {
      if (envLocalContent === undefined) throw new Error('ENOENT: .env.local');
      return envLocalContent;
    }
    if (path.includes('com.vercel.cli')) {
      if (cliStoreContent === undefined) throw new Error('ENOENT: auth.json');
      return cliStoreContent;
    }
    throw new Error('ENOENT: ' + path);
  });
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

describe('readToken · token-resolution chain', () => {
  it('prefers the VERCEL_TOKEN env var without touching any file', () => {
    process.env.VERCEL_TOKEN = 'env-token';
    expect(readToken()).toBe('env-token');
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
  });

  it('falls back to .env.local, stripping surrounding quotes', () => {
    envLocalContent = 'FIREBASE_API_KEY=x\nVERCEL_TOKEN="quoted-token"\n';
    expect(readToken()).toBe('quoted-token');
  });

  it('accepts an unquoted .env.local value', () => {
    envLocalContent = 'VERCEL_TOKEN=plain-token\n';
    expect(readToken()).toBe('plain-token');
  });

  it('skips an empty .env.local value and keeps walking the chain', () => {
    envLocalContent = 'VERCEL_TOKEN=""\n';
    cliStoreContent = JSON.stringify({ token: 'cli-token' });
    expect(readToken()).toBe('cli-token');
  });

  it('falls back to the Vercel CLI auth store', () => {
    cliStoreContent = JSON.stringify({ token: 'cli-token' });
    expect(readToken()).toBe('cli-token');
  });

  it('returns null when every source is missing', () => {
    expect(readToken()).toBeNull();
  });
});

describe('parseArgs · --url / --expect / --compare-url handling', () => {
  it('parses all three flags in any order', () => {
    expect(
      parseArgs(['--compare-url', 'https://c.vercel.app', '--expect', 'abc123', '--url', 'https://u.vercel.app']),
    ).toEqual({ expect: 'abc123', url: 'https://u.vercel.app', compareUrl: 'https://c.vercel.app' });
  });

  it('recovers flags that lost their leading position (GH Actions block-scalar trim)', () => {
    // A plain-scalar `run: cmd \` block folds the trailing backslash-newline
    // into a literal backslash+space, so the arg arrives as ' --url'. Without
    // the trim, the flag is invisible and the script silently falls back to
    // the production-list branch — the exact trap the trim exists for.
    expect(parseArgs([' --expect', 'abc123'])).toEqual({ expect: 'abc123', url: null, compareUrl: null });
    expect(parseArgs(['--url ', 'https://u.vercel.app '])).toEqual({
      expect: null,
      url: 'https://u.vercel.app',
      compareUrl: null,
    });
  });

  it('returns null for a flag with no value (never an undefined comparison)', () => {
    expect(parseArgs(['--expect'])).toEqual({ expect: null, url: null, compareUrl: null });
  });

  it('returns all-null when no flags are given (plain report mode)', () => {
    expect(parseArgs([])).toEqual({ expect: null, url: null, compareUrl: null });
  });
});

describe('extractSha · deployment record → commit sha', () => {
  it('reads meta.githubCommitSha first', () => {
    expect(extractSha({ meta: { githubCommitSha: 'abc123' } })).toBe('abc123');
  });

  it('falls back to gitSource.sha', () => {
    expect(extractSha({ gitSource: { sha: 'def456' } })).toBe('def456');
  });

  it('returns empty when neither is recorded', () => {
    expect(extractSha({})).toBe('');
    expect(extractSha(null)).toBe('');
  });
});

describe('compareDrift · alias-routing verdict', () => {
  it('match on equal shas, mismatch on different shas', () => {
    expect(compareDrift('abc', 'abc')).toBe('match');
    expect(compareDrift('abc', 'def')).toBe('mismatch');
  });

  it('unverifiable when either side is missing', () => {
    expect(compareDrift('', 'abc')).toBe('unverifiable');
    expect(compareDrift('abc', '')).toBe('unverifiable');
  });
});

describe('isInvalidToken · Vercel credential-flag detection', () => {
  it('catches the top-level and nested error shapes', () => {
    expect(isInvalidToken({ invalidToken: true })).toBe(true);
    expect(isInvalidToken({ error: { invalidToken: true } })).toBe(true);
  });

  it('returns false for healthy or empty bodies', () => {
    expect(isInvalidToken({})).toBe(false);
    expect(isInvalidToken({ error: { message: 'nope' } })).toBe(false);
    expect(isInvalidToken(null)).toBe(false);
    expect(isInvalidToken(undefined)).toBe(false);
  });
});

describe('resolveByHost · v13 deployment lookup', () => {
  it('tries the team-scoped lookup first when a team id is known', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'cook-abc123.vercel.app',
        createdAt: 1_700_000_000_000,
        meta: { githubCommitSha: 'deadbeef' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const dep = await resolveByHost('cook-with-freebuff.vercel.app', 'deployment URL', 'tok', 'team_1');
    expect(dep.sha).toBe('deadbeef');
    expect(dep.url).toBe('cook-abc123.vercel.app');
    expect(String(fetchMock.mock.calls[0][0])).toContain('teamId=team_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bare unscoped lookup when the team-scoped call fails', async () => {
    // With a team id known, the lookup tries the team-scoped URL first and
    // falls back to the bare (globally-unique-subdomain) URL on failure — the
    // guarantee that keeps the gate green even when the token can see the
    // deployment but not the team.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => null })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: 'cook.vercel.app', meta: { githubCommitSha: 'beefcafe' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const dep = await resolveByHost('cook-with-freebuff.vercel.app', 'deployment URL', 'tok', 'team_1');
    expect(dep.sha).toBe('beefcafe');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('teamId=team_1');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('teamId=');
  });

  it('throws the __INVALID_TOKEN__ marker on an invalid credential (drives exit 2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { invalidToken: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveByHost('cook-with-freebuff.vercel.app', 'deployment URL', 'bad', null)).rejects.toThrow(
      '__INVALID_TOKEN__',
    );
  });

  it('throws a descriptive error on a non-token API failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => null });
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveByHost('gone.vercel.app', 'deployment URL', 'tok', null)).rejects.toThrow(
      'Vercel API returned HTTP 404',
    );
  });
});

describe('exit-2 path · end to end (real script, stubbed Vercel API)', () => {
  it('exits 2 with the paste-a-fresh-token guidance when Vercel flags the token', async () => {
    const preload = join(tmpdir(), `verify-hash-preload-${process.pid}.cjs`);
    fsRef.realWriteFileSync?.(
      preload,
      `globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/v2/user')) return { ok: true, status: 200, json: async () => ({ user: { defaultTeamId: 'team_1' } }) };
  if (u.includes('/v2/teams')) return { ok: true, status: 200, json: async () => ({ teams: [{ id: 'team_1' }] }) };
  return { ok: false, status: 401, json: async () => ({ error: { invalidToken: true } }) };
};
`,
    );
    try {
      const result = await new Promise<{ code: number; stderr: string }>((resolveRun, reject) => {
        execFile(
          process.execPath,
          ['scripts/verify-deployed-hash.mjs', '--url', 'https://cook-with-freebuff.vercel.app'],
          {
            cwd: resolve(process.cwd()),
            env: { ...process.env, VERCEL_TOKEN: 'definitely-invalid', NODE_OPTIONS: `--require "${preload}"` },
          },
          (error, _stdout, stderr) => {
            if (error) {
              const err = error as NodeJS.ErrnoException & { code?: number | string };
              resolveRun({ code: typeof err.code === 'number' ? err.code : 1, stderr });
            } else {
              reject(new Error('expected the script to exit nonzero'));
            }
          },
        );
      });
      // The whole point of the exit-2 contract: a dead token must NOT look
      // like a generic gate failure (exit 1) — CI must see the dedicated
      // "paste a fresh token" code so it can surface the guidance.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('invalid or revoked');
      expect(result.stderr).toContain('paste a fresh token');
    } finally {
      fsRef.realRmSync?.(preload, { force: true });
    }
  });
});

describe('contract lock · exit-2 invalid-token wiring in the script', () => {
  it('keeps the marker threaded from resolveByHost through main to process.exit(2)', () => {
    expect(SCRIPT_SRC).toContain('__INVALID_TOKEN__');
    expect(SCRIPT_SRC).toContain('process.exit(2)');
    // The exit-2 handler must be defined and used — a future edit that turns
    // the invalid-token path into a generic exit(1) fails here.
    const invalidTokenExitDef = SCRIPT_SRC.indexOf('const invalidTokenExit =');
    expect(invalidTokenExitDef).toBeGreaterThan(-1);
    expect(SCRIPT_SRC.indexOf('process.exit(2)')).toBeGreaterThan(invalidTokenExitDef);
    // Every catch site that sees the marker must route to invalidTokenExit
    // (or rethrow it), never fall through to a generic failure. At least the
    // resolveByHost throw, resolveTeam's two guards, and the two main() URL
    // catches must all thread it.
    const markerGuards = SCRIPT_SRC.match(/includes\('__INVALID_TOKEN__'\)/g) ?? [];
    expect(markerGuards.length).toBeGreaterThanOrEqual(3);
    // The list branch (no --url) also exits 2 on an invalid token, not 1.
    expect(SCRIPT_SRC).toContain('invalidTokenExit(null);');
  });

  it('keeps the guidance message on the exit-2 path', () => {
    expect(INVALID_TOKEN_MESSAGE).toContain('paste a fresh token');
    expect(INVALID_TOKEN_MESSAGE).toContain('https://vercel.com/account/tokens');
    expect(SCRIPT_SRC).toContain('console.error(`✗ FAIL: ${INVALID_TOKEN_MESSAGE}`)');
  });
});

describe('contract lock · token-resolution chain order in the script', () => {
  it('keeps env → .env.local → CLI store, in that order', () => {
    const envGuard = SCRIPT_SRC.indexOf('if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;');
    const envLocalRead = SCRIPT_SRC.indexOf("readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')");
    const cliStoreRead = SCRIPT_SRC.indexOf(
      "readFileSync(resolve(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'), 'utf8')",
    );
    expect(envGuard).toBeGreaterThan(-1);
    expect(envLocalRead).toBeGreaterThan(envGuard);
    expect(cliStoreRead).toBeGreaterThan(envLocalRead);
  });
});

describe('constants · project identity', () => {
  it('targets the cook project and its canonical URL', () => {
    expect(PROJECT).toBe('cook-with-freebuff');
    expect(PRODUCTION_URL).toBe('https://cook-with-freebuff.vercel.app');
  });
});

describe('contract lock · plain-mode project filter (projectId, not name)', () => {
  it('filters the v6 list query by projectId from the vercel link file, not the project name', () => {
    // The v6 deployments LIST endpoint filters by PROJECT ID, not name —
    // passing `project=<name>` is silently ignored and the report returns the
    // team's latest deployment regardless of project (which could be the
    // OTHER app's commit). The load-bearing line below is what keeps the
    // plain report scoped to THIS project; a revert to `project=${PROJECT}`
    // fails here.
    expect(SCRIPT_SRC).toContain("projectId = JSON.parse(readFileSync(resolve(process.cwd(), '.vercel/project.json'), 'utf8'))?.projectId ?? null;");
    expect(SCRIPT_SRC).toContain('projectId ? `projectId=${encodeURIComponent(projectId)}` : `project=${PROJECT}`');
  });

  it('keeps the name fallback only for pre-link repos, and documents why the id is required', () => {
    // The fallback exists so an unlinked repo still works; the comment must
    // stay so the silent-ignore bug cannot return without re-deciding. CI
    // never uses this list branch (the post-deploy gates always pass --url),
    // so the lock protects the local report's trustworthiness.
    expect(SCRIPT_SRC).toContain('SILENTLY IGNORED');
    expect(SCRIPT_SRC).toContain('name fallback only applies before the repo is linked');
    expect(SCRIPT_SRC).toContain('CI never uses');
    expect(SCRIPT_SRC).toContain('this list branch');
  });
});
