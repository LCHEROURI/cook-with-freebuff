import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-cleanup.test.ts — lock verify-live's guaranteed cleanup.
//
// The owner account accumulated 8 stale ACTIVE sessions (7 from the /cook
// screen's browser launches + the stuck COLLECTING_INGREDIENTS one) that
// hijacked the deployed screen. verify-live's cleanup previously ran ONLY on
// the happy path and the token-failure path — a run killed mid-flight (CI
// timeout, fetch throw, SIGTERM) leaked the seeded recipe + session, proven by
// the orphaned `verify-live-*` recipes left in Firestore. This test locks the
// contracts that close that hole:
//
//   1. try/finally — the whole flow runs inside try/finally, so cleanup runs
//      on EVERY exit path (success, crash, signal), not just the happy one.
//   2. Signal handlers — SIGINT / SIGTERM / unhandledRejection /
//      uncaughtException all route through the same cleanup-then-exit path.
//   3. Pre-run sweep — before seeding anything, leftover probe sessions
//      (recipeId prefixed `verify-live-`) are archived (ABANDONED) and their
//      orphaned probe recipes deleted, so a killed run's leftovers are cleaned
//      by the NEXT run even if the first could not clean up at all.
//   4. Probe discriminator — only `verify-live-`-prefixed recipes are swept,
//      so a REAL cooking session can never be archived by the sweep.
//
// Same discipline as scripts/verify-live-local.test.ts: read the REAL script
// from disk (never a fixture) and assert the load-bearing pieces survive
// future edits.
// ============================================================================

const SRC = readFileSync('scripts/verify-live.mjs', 'utf8');

describe('scripts/verify-live.mjs · guaranteed cleanup', () => {
  it('wraps the whole flow in try/finally with cleanup in the finally block', () => {
    // The cleanup must be UNCONDITIONAL: a `finally` running `await cleanup()`
    // after both the success path and the crash path. A bare `await cleanup()`
    // at the end of the happy path (the pre-fix shape) leaks on any throw.
    const tryIdx = SRC.indexOf('try {');
    const finallyIdx = SRC.indexOf('} finally {');
    const cleanupIdx = SRC.indexOf('await cleanup()', finallyIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(finallyIdx).toBeGreaterThan(tryIdx);
    expect(cleanupIdx).toBeGreaterThan(finallyIdx);
    expect(SRC.slice(finallyIdx, cleanupIdx)).toContain('RESULT:');
  });

  it('registers SIGINT/SIGTERM/unhandledRejection/uncaughtException handlers that clean up before exit', () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']) {
      expect(SRC).toContain(`process.on('${signal}'`);
    }
    // Every handler must route through the same cleanup-then-exit helper.
    expect(SRC).toContain('const exitWithCleanup = async (code, reason) => {');
    expect(SRC).toContain('await cleanup()');
    expect(SRC).toContain('process.exit(code)');
  });

  it('runs a pre-run sweep BEFORE seeding anything of its own', () => {
    const sweepCall = SRC.indexOf('await sweepStaleProbes()');
    const seedLine = SRC.indexOf('seededRecipeId = `verify-live-${t}`');
    expect(sweepCall).toBeGreaterThan(-1);
    expect(seedLine).toBeGreaterThan(sweepCall);
  });

  it('archives stale probe sessions as ABANDONED and deletes orphaned probe recipes', () => {
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    expect(fn).toContain("d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() })");
    expect(fn).toContain("d.id.startsWith('verify-live-')");
    expect(fn).toContain('Promise.allSettled(deletes)');
  });

  it('never sweeps a recipe seeded within the grace period (a concurrent run\'s in-flight probe)', () => {
    // The deployed CI verify and a local verify:live:local share the owner,
    // Firestore, and `verify-live-` namespace. A concurrent run's seeded
    // recipe is transiently orphaned between [3c] and [4]; sweeping it there
    // fails that run's relaunch with RECIPE_NOT_FOUND. The grace guard keeps
    // a fresh seed alive while still deleting genuinely old leftovers.
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    expect(SRC).toContain('const PROBE_GRACE_MS = 15 * 60 * 1000;');
    expect(fn).toContain("const seededAt = d.data().updatedAt ?? d.data().createdAt ?? 0;");
    expect(fn).toContain('typeof seededAt === \'number\' && seededAt < cutoff');
  });

  it('sweeps ONLY verify-live- prefixed sessions — a real session can never be archived', () => {
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    // The ACTIVE/PAUSED filter must be AND-ed with the prefix check — never
    // OR-ed — so every owner session is NOT a sweep target by default.
    expect(fn).toMatch(/s\.recipeId\.startsWith\('verify-live-'\)\s*&&\s*\(s\.status === 'ACTIVE' \|\| s\.status === 'PAUSED'\)/);
    // And no blanket "archive all ACTIVE sessions" escape hatch anywhere.
    expect(fn).not.toContain('status: \'ACTIVE\'');
  });

  it('still exits 0 on PASS and 1 on FAIL after the rewrite', () => {
    expect(SRC).toContain("process.exit(runExit === 0 && failures === 0 ? 0 : 1);");
  });
});

describe('scripts/verify-live.mjs · fetch resilience', () => {
  it('retries a network-level fetch failure exactly once', () => {
    // The [4] relaunch POST dies on the stale keep-alive socket left by the
    // minutes-long Chrome driver stages (undici "fetch failed", EPIPE), which
    // crashed verify:live:local at RESULT: FAIL before [4] could run. The
    // retry must re-establish the connection once, and must NOT retry HTTP
    // errors (fetch only throws on network failure, never on a response).
    const fnStart = SRC.indexOf('const fetchJson = async');
    const fn = SRC.slice(fnStart, SRC.indexOf('let body = null', fnStart));
    expect(fn).toContain('const attempt = () => fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });');
    expect(fn).toContain('res = await attempt();');
    expect(fn).toContain('retrying once');
    // Both attempts share one URL + init; a fresh AbortSignal per attempt.
    expect(fn.match(/await attempt\(\)/g)).toHaveLength(2);
  });
});
