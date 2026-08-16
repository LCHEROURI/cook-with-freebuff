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
const VOICE = readFileSync('scripts/drive-live-voice.mjs', 'utf8');

// The declaration extraction the lockstep assertion runs. Kept as one helper
// so the drift-mutation proof below exercises the SAME code path — a future
// edit to the extraction (or the assertion) is immediately visible to both
// tests instead of silently weakening one.
const probeGraceDecl = (source: string): string | undefined =>
  source.split('\n').find((line) => line.startsWith('const PROBE_GRACE_MS'));

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
    const seedLine = SRC.indexOf('seededRecipeId = `${PROBE_PREFIX}${t}`');
    expect(sweepCall).toBeGreaterThan(-1);
    expect(seedLine).toBeGreaterThan(sweepCall);
  });

  it('seeds and sweeps under a configurable probe prefix (default verify-live-)', () => {
    // The prefix must be a FLAG (not a hardcoded string) so the local dev run
    // can pass its own disjoint namespace and a concurrent CI run's sweep can
    // never touch it.
    expect(SRC).toContain("const PROBE_PREFIX = flag('--probe-prefix', 'verify-live-');");
    expect(SRC).toContain('seededRecipeId = `${PROBE_PREFIX}${t}`');
  });

  it('archives stale probe sessions as ABANDONED and deletes orphaned probe recipes', () => {
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    expect(fn).toContain("d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() })");
    expect(fn).toContain('!d.id.startsWith(PROBE_PREFIX)');
    expect(fn).toContain('Promise.allSettled(deletes)');
  });

  it('never sweeps a recipe seeded within the grace period (a concurrent run\'s in-flight probe)', () => {
    // The deployed CI verify and a local verify:live:local share the owner,
    // Firestore, and `verify-live-` namespace. A concurrent run's seeded
    // recipe is transiently orphaned between [3c] and [4]; sweeping it there
    // fails that run's relaunch with RECIPE_NOT_FOUND. Two windows are
    // guarded: seed→launch (from updatedAt/createdAt) and [3c]→[4] (from
    // orphanedAt, stamped at the orphaning instant so the drivers' duration
    // can't expire it mid-run).
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    expect(SRC).toContain('const PROBE_GRACE_MS = 15 * 60 * 1000;');
    expect(SRC).toContain('const ORPHAN_GRACE_MS = 30 * 60 * 1000;');
    expect(fn).toContain("const data = d.data();");
    expect(fn).toContain('const orphanedAt = data.orphanedAt;');
    expect(fn).toContain('typeof orphanedAt === \'number\' && orphanedAt > orphanCutoff');
    expect(fn).toContain("const seededAt = data.updatedAt ?? data.createdAt ?? 0;");
    expect(fn).toContain('typeof seededAt === \'number\' && seededAt < cutoff');
  });

  it('stamps orphanedAt at the [3c] settle so the sweep measures grace from the orphaning point', () => {
    // The seeded recipe becomes orphaned only when [3c] deletes its probe
    // session; measuring the grace from seed time (updatedAt) would let the
    // [3d]/[3e] driver duration push an in-flight seed past the window. The
    // settle must record the orphaning instant on the recipe itself.
    expect(SRC).toContain("db.collection('recipes').doc(seededRecipeId).update({ orphanedAt: Date.now() })");
  });

  it('sweeps ONLY verify-live- prefixed sessions — a real session can never be archived', () => {
    const fnStart = SRC.indexOf('async function sweepStaleProbes');
    const fn = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    // The ACTIVE/PAUSED filter must be AND-ed with the prefix check — never
    // OR-ed — so every owner session is NOT a sweep target by default.
    expect(fn).toMatch(/s\.recipeId\.startsWith\(PROBE_PREFIX\)\s*&&\s*\(s\.status === 'ACTIVE' \|\| s\.status === 'PAUSED'\)/);
    // And no blanket "archive all ACTIVE sessions" escape hatch anywhere.
    expect(fn).not.toContain('status: \'ACTIVE\'');
  });

  it('still exits 0 on PASS and 1 on FAIL after the rewrite', () => {
    expect(SRC).toContain("process.exit(runExit === 0 && failures === 0 ? 0 : 1);");
  });
});

describe('scripts/verify-live.mjs · fetch resilience', () => {
  it('retries only an opted-in stale-socket failure, exactly once, never a timeout', () => {
    // The [4] relaunch POST dies on the stale keep-alive socket left by the
    // minutes-long Chrome driver stages (undici "fetch failed", EPIPE), which
    // crashed verify:live:local at RESULT: FAIL before [4] could run. The
    // retry must re-establish the connection once — but ONLY when the caller
    // opts in (retryOnConnectError) AND the error is a socket-level code that
    // proves the request was never delivered. A timeout/abort (the server may
    // have accepted the request) must rethrow: launch/done/create_recipe are
    // not idempotent, and a blind repeat would duplicate the mutation.
    const fnStart = SRC.indexOf('const fetchJson = async');
    const fn = SRC.slice(fnStart, SRC.indexOf('let body = null', fnStart));
    expect(fn).toContain("const retryOnConnectError = init?.retryOnConnectError === true;");
    // STALE_SOCKET_CODES is a top-level const just above fetchJson.
    // Only the codes observed in the field are allowed: the retry must stay
    // limited to provably-undelivered requests, so speculative undici codes
    // (ECONNABORTED, UND_ERR_SOCKET, UND_ERR_CONNECT) stay out by contract.
    expect(SRC).toContain("const STALE_SOCKET_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE'];");
    expect(fn).toContain('if (!retryOnConnectError || !STALE_SOCKET_CODES.includes(cause)) throw e;');
    expect(fn).toContain('retrying once on a fresh connection');
    // Two attempts total: the first, then exactly one opt-in retry.
    expect(fn.match(/await attempt\(\)/g)).toHaveLength(2);
    // The timeoutMs and retryOnConnectError options must be stripped from the
    // init spread — never forwarded to fetch as headers/body.
    expect(fn).toContain('const { timeoutMs: _drop, retryOnConnectError: _drop2, ...rest } = init ?? {};');
  });

  it('opts the [4] relaunch into the retry with the probe-only safety rationale', () => {
    // Only the relaunch (the first fetch after the Chrome stages) opts in.
    // It must go straight through fetchJson with retryOnConnectError, not
    // through the shared cook() helper, which would swallow the flag into the
    // JSON body instead of the init options.
    expect(SRC).toContain("body: JSON.stringify({ action: 'launch', recipeId: seededRecipeId }),\n    retryOnConnectError: true,");
    expect(SRC).toContain('never user data');
  });
});

describe('scripts/verify-live.mjs × drive-live-voice.mjs · shared seed grace (spec 0002)', () => {
  it('keeps the PROBE_GRACE_MS declaration lockstep across both drivers', () => {
    // The 15-minute seed grace protects the seed→launch window in BOTH
    // drivers, which share the owner, Firestore, and the probe namespace. A
    // concurrent run's sweep must never delete a live run's in-flight seed,
    // so drift between the two files fails CI (spec 0002, AC-2). Assert the
    // FULL declaration line, not just the numeric value: a value change OR a
    // rename in one file fails loudly instead of silently weakening the guard.
    const verifyDecl = probeGraceDecl(SRC);
    const voiceDecl = probeGraceDecl(VOICE);
    expect(verifyDecl).toBeDefined();
    expect(voiceDecl).toBeDefined();
    expect(verifyDecl).toBe(voiceDecl);
  });

  it('proves the lockstep assertion catches drift in either driver (mutation)', () => {
    // Mutation proof: the equality above must have discriminating power, not
    // pass vacuously. Mutate ONLY the value expression in an in-memory copy
    // of each REAL driver source (never on disk) and assert the exact
    // comparison the lockstep test runs now fails. If a future edit to
    // probeGraceDecl or the lockstep assertion stopped detecting a changed
    // declaration, this test goes red with it.
    const verifyDecl = probeGraceDecl(SRC);
    const voiceDecl = probeGraceDecl(VOICE);
    expect(verifyDecl).toBeDefined();
    expect(voiceDecl).toBeDefined();

    // Drift the voice driver: 15 → 20 minutes in the value expression only.
    // The expression appears exactly once in the file, in the declaration.
    const mutatedVoice = VOICE.replace('15 * 60 * 1000', '20 * 60 * 1000');
    const driftedVoice = probeGraceDecl(mutatedVoice);
    expect(driftedVoice).toBeDefined();
    expect(driftedVoice).not.toBe(voiceDecl); // the mutation actually landed
    expect(driftedVoice).not.toBe(verifyDecl); // ...so the lockstep equality fails

    // Mirror direction: drift the verify-live source the same way.
    const mutatedVerify = SRC.replace('15 * 60 * 1000', '20 * 60 * 1000');
    const driftedVerify = probeGraceDecl(mutatedVerify);
    expect(driftedVerify).toBeDefined();
    expect(driftedVerify).not.toBe(verifyDecl);
    expect(driftedVerify).not.toBe(voiceDecl);
  });
});
