// ============================================================================
// lib/server/rollback-resume.emulator.test.ts — marker atomicity through the
// REAL Firestore stack, not fakes.
//
// The unit suites prove the rollback-resume contract with in-memory stores and
// a fake Firestore that MODELS the read-before-write rule and the atomic
// marker write. This test drives the same cycle (pause → failed rebase →
// rollback → same-ID retry) through the real admin SDK, the real
// repositories, and the real production stores against a LIVE Firestore
// emulator, where transaction semantics are enforced by the emulator itself,
// not modeled by the test:
//
//   • the rollback clear of the original resume id rides the SAME transaction
//     as the re-pause (Codex P1, PR #58 review) — if a regression split the
//     clear into a separate write, the fake's modeling would not catch it,
//     but here the marker's absence is checked in the real collection;
//   • the legacy read-before-write ordering (Codex P1, PR #64 review) is
//     enforced by the emulator: a reordered transaction is REJECTED by real
//     Firestore, so the successful rollback IS the proof;
//   • the retry after the rollback transitions exactly once and rebases the
//     timer exactly once — the emulator's real version checks and real batch
//     semantics are what make the assertion discriminating.
//
// Running:
//   npm run test:emulator          — self-contained: boots + tears down its
//                                    own emulator (needs Java 21)
//   npm run emulators + npm test   — reuses a running emulator
// With no emulator reachable and auto-boot off, the suite SKIPS fast so the
// plain `npm test` CI job stays green without Java.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import type { Recipe } from '../domain/types';
import type { TimerStore } from './tools/types';

vi.mock('server-only', () => ({}));

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const EMULATOR_PORT = Number(EMULATOR_HOST.split(':').slice(-1)[0]);
const AUTO_BOOT = process.env.RUN_EMULATOR_TESTS === '1';
const EMULATOR_PROJECT = 'demo-cook-with-freebuff';

// ── Emulator lifecycle (boot or reuse, mirroring scripts/verify-live-emulator.mjs)

function portInUse(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        res(v);
      }
    };
    s.once('connect', () => {
      s.destroy();
      finish(true);
    });
    s.once('error', () => finish(false));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      finish(false);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PIDs currently listening on a TCP port (lsof -t), for orphan sweeping. */
async function listenersOnPort(port: number): Promise<number[]> {
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

async function bootEmulator(): Promise<{ stop: () => Promise<void> } | null> {
  if (await portInUse(EMULATOR_PORT)) return { stop: async () => {} };
  if (!AUTO_BOOT) return null;

  const child = spawn(
    'npx',
    ['-y', 'firebase-tools@latest', 'emulators:start', '--only', 'firestore', '--project', EMULATOR_PROJECT],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout?.on('data', (d) => {
    log += d.toString();
  });
  child.stderr?.on('data', (d) => {
    log += d.toString();
  });

  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await portInUse(EMULATOR_PORT, '127.0.0.1', 500)) {
      up = true;
      break;
    }
    await sleep(1_000);
  }
  if (!up) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    throw new Error(
      `Firestore emulator did not come up on :${EMULATOR_PORT}\n${log.split('\n').filter(Boolean).slice(-8).join('\n')}`,
    );
  }
  // The port binds just before the emulator finishes internal init.
  await sleep(1_500);
  return {
    stop: async () => {
      // firebase-tools runs the Java emulator as a child that can survive the
      // npx process-group kill (seen locally: the java process kept 8080 bound
      // after the group was killed). SIGTERM the group first, then SIGKILL,
      // then sweep the port for any orphaned listener.
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await sleep(1_000);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 6; i++) {
        if (!(await portInUse(EMULATOR_PORT))) return;
        await sleep(500);
      }
      for (const pid of await listenersOnPort(EMULATOR_PORT)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await sleep(500);
    },
  };
}

let emulator: { stop: () => Promise<void> } | null = null;
let bootError = '';
try {
  emulator = await bootEmulator();
} catch (e) {
  bootError = e instanceof Error ? e.message : String(e);
}

// When the user explicitly asked for the emulator run, a boot failure is a
// real failure — never a silent skip. Without the flag, skip quietly.
if (!emulator && AUTO_BOOT) {
  throw new Error(`RUN_EMULATOR_TESTS=1 but the Firestore emulator could not start:\n${bootError}`);
}

// The real modules are imported AFTER the emulator is up and the env var is
// set, because lib/server/admin.ts caches its Firestore instance at first
// import and branches on FIRESTORE_EMULATOR_HOST.
let repo: typeof import('./repositories');
let stores: typeof import('./stores');
let admin: typeof import('./admin');
let GuidedCookingService: typeof import('./guide-service').GuidedCookingService;

beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  repo = await import('./repositories');
  stores = await import('./stores');
  admin = await import('./admin');
  ({ GuidedCookingService } = await import('./guide-service'));
});

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [{ id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false }],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe.skipIf(!emulator)('rollback-resume marker atomicity · Firestore emulator', () => {
  afterAll(async () => {
    await emulator?.stop();
  });

  it(
    'replays pause → failed rebase rollback → same-ID retry through the real repositories ' +
      'and proves the marker clear rides the re-pause transaction',
    async () => {
      const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const userId = `user-${run}`;
      const recipeId = `recipe-${run}`;
      // Separator-free: the normal case, which also exercises the legacy
      // conditional read in the clear transaction (the PR #64 read-before-write
      // ordering the emulator enforces).
      const resumeId = `resume-${run}`;
      let sessionId = '';

      // A timer store that fails the ATOMIC rebase on demand — the exact
      // failure surface of the P1 chain: transition → rebase fails → rollback
      // to PAUSED → client retries with the SAME correlation ID.
      let failing = false;
      const flakyTimers: TimerStore = {
        ...stores.firestoreTimerStore,
        rebaseActiveTimers: async (sid, elapsedMs) => {
          if (failing) throw new Error('simulated rebase write failure');
          return stores.firestoreTimerStore.rebaseActiveTimers(sid, elapsedMs);
        },
      };

      const guide = new GuidedCookingService(
        stores.productionSessionService,
        flakyTimers,
        stores.firestoreRecipeStore,
      );

      try {
        // Seed the recipe into the REAL recipe repository, then run the real
        // guided flow: launch → done → WAITING_FOR_TIMER with an auto-started
        // timer (all through real Firestore transactions).
        await repo.createRecipe({ ...makeRecipe(), id: recipeId, userId });
        let snap = await guide.launchCookWithMe(userId, recipeId);
        expect(snap.phase).toBe('PREP_GUIDANCE');

        snap = await guide.completeCurrentAction(userId);
        expect(snap.phase).toBe('WAITING_FOR_TIMER');
        sessionId = snap.sessionId!;

        // Give the auto-started 240s timer 180s left so the rebase math below
        // is exact: endsAt = t_backdate + 180s.
        const [timer] = await flakyTimers.listActiveTimers(sessionId);
        expect(timer).toBeDefined();
        await flakyTimers.updateTimer(timer.id, {
          startedAt: Date.now() - 60_000,
          endsAt: Date.now() + 180_000,
        });

        // Pause, then let a real couple of seconds elapse while paused.
        const paused = await guide.pause(userId, sessionId);
        expect(paused.phase).toBe('PAUSED');
        const pausedAt = paused.pausedAt;
        expect(pausedAt).toBeTypeOf('number');
        await sleep(3_000);

        // First resume: the rebase fails → the route contract says the session
        // rolls back to PAUSED with the ORIGINAL pausedAt and a recoverable
        // TIMER_REBASE_FAILED.
        failing = true;
        await expect(guide.resume(userId, sessionId, { correlationId: resumeId })).rejects.toMatchObject({
          code: 'TIMER_REBASE_FAILED',
        });

        const rolledBack = await stores.productionSessionService.getSession(sessionId);
        expect(rolledBack?.currentPhase).toBe('PAUSED');
        expect(rolledBack?.pausedAt).toBe(pausedAt);

        // THE atomicity proof, against the real collection: the original
        // resume id's marker was cleared in the SAME transaction as the
        // re-pause. If a regression split the clear into a separate write
        // (or swallowed it after a committed pause), this marker would still
        // be present and the retry below would be eaten as a duplicate.
        expect(await repo.hasCorrelationMarker(resumeId)).toBe(false);

        // The re-pause itself committed with its own UNIQUE rollback marker —
        // it was not swallowed as a duplicate of the resume id (the PR #53
        // per-attempt nonce, proven here with real transaction semantics).
        const db = admin.getAdminDb();
        expect(db).not.toBeNull();
        const markerSnap = await db!.collection('correlation_markers').get();
        const rollbackMarkers = markerSnap.docs.filter((d) => {
          const rawId = d.data()?.rawId;
          return typeof rawId === 'string' && rawId.startsWith(`resume-rollback:${resumeId}:`);
        });
        expect(rollbackMarkers.length).toBeGreaterThan(0);

        // Retry with the SAME correlation id while the store is healthy: the
        // rollback made it legal again, so it transitions PAUSED → ACTIVE once
        // and rebases from the ORIGINAL endsAt exactly once.
        failing = false;
        const t0 = Date.now();
        const retried = await guide.resume(userId, sessionId, { correlationId: resumeId });
        expect(retried.phase).toBe('WAITING_FOR_TIMER');

        // The retry was processed — its marker is back (mark rides the
        // transition transaction).
        expect(await repo.hasCorrelationMarker(resumeId)).toBe(true);

        // EXACTLY ONE rebase: endsAt was t_backdate + 180s and the single
        // shift adds the paused duration (≈ t0 − pause), landing ≈ t0 + 180s.
        // A second shift (the pre-fix double rebase) would add the pause
        // duration again and land ≈ t0 + 183s — outside the tolerance.
        const [rebased] = await flakyTimers.listActiveTimers(sessionId);
        expect(rebased.status).toBe('RUNNING');
        expect(rebased.endsAt).toBeGreaterThan(t0 + 179_000);
        expect(rebased.endsAt).toBeLessThan(t0 + 181_000);
      } finally {
        // Best-effort cleanup of this run's docs so a REUSED dev emulator
        // (npm run emulators, which exports on exit) is not polluted.
        try {
          if (sessionId) {
            const db = admin.getAdminDb();
            if (db) {
              const timers = await db.collection('timers').where('sessionId', '==', sessionId).get();
              for (const d of timers.docs) await d.ref.delete();
              const events = await db.collection('cooking_session_events').where('sessionId', '==', sessionId).get();
              for (const d of events.docs) await d.ref.delete();
              await db.collection('cooking_sessions').doc(sessionId).delete();
            }
          }
          const db = admin.getAdminDb();
          if (db) {
            await db.collection('recipes').doc(recipeId).delete();
            const markers = await db.collection('correlation_markers').get();
            for (const d of markers.docs) {
              const rawId = d.data()?.rawId;
              if (typeof rawId === 'string' && (rawId === resumeId || rawId.startsWith(`resume-rollback:${resumeId}:`))) {
                await d.ref.delete();
              }
            }
          }
        } catch {
          /* best effort */
        }
      }
    },
  );
});
