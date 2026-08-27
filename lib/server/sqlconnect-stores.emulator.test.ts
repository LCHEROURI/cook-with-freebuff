// ============================================================================
// lib/server/sqlconnect-stores.emulator.test.ts — the store twin through the
// REAL SQL Connect stack, not mocks.
//
// The unit suite (sqlconnect-stores.test.ts) proves the twin's boundary with
// a mocked SDK. This suite drives the same contracts through the real
// generated SDK and a LIVE Data Connect emulator, where transaction
// semantics, the @check version guard, and the unconditional-steps rule are
// enforced by the emulator itself:
//
//   • a correlated createSession marks BOTH the derived idle-><cid> id and
//     the request id in ONE transaction (UpdateSessionWithTwoMarkers) — a
//     regression that split them would leave an unmarked orphan a retry
//     could duplicate, and here the markers are checked in the real table;
//   • a retried create with the same correlation id dedupes to the same
//     session (the marker read is the real one);
//   • a mark+clear transition commits both in one transaction: the cleared
//     marker is gone and the kept marker survives (the rollback invariant);
//   • a one-field update preserves every field it did not carry (the
//     omitted-variable semantics verified on the emulator in PR #190 review);
//   • a stale expectedVersion surfaces as VersionConflictError through the
//     service and as the /version conflict/i error through the store.
//
// Running (needs the SQL Connect emulator, NOT Java):
//   npx firebase-tools emulators:start --only dataconnect   (from dataconnect/)
//   RUN_SQLCONNECT_EMULATOR_TESTS=1 npx vitest run lib/server/sqlconnect-stores.emulator.test.ts
// Without a reachable emulator the suite SKIPS fast so plain `npm test` stays
// green; with the flag set, an unreachable emulator is a hard failure.
//
// NOT exercised here (documented in spec 0005 and phase verifications):
// rebaseActiveTimers is native-SQL DML, which the local emulator cannot
// execute (PGLite defect); it is compile-proven and exercised against
// Cloud SQL in the repository-parity phase.
// ============================================================================

import { describe, it, expect, beforeAll, vi } from 'vitest';
import net from 'node:net';
import { initializeApp, getApps } from 'firebase-admin/app';

vi.mock('server-only', () => ({}));

const SQLCONNECT_HOST = process.env.DATA_CONNECT_EMULATOR_HOST || '127.0.0.1:9399';
const SQLCONNECT_PORT = Number(SQLCONNECT_HOST.split(':').slice(-1)[0]);
const AUTO_BOOT = process.env.RUN_SQLCONNECT_EMULATOR_TESTS === '1';

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

const emulatorUp = await portInUse(SQLCONNECT_PORT);
if (!emulatorUp && AUTO_BOOT) {
  throw new Error(
    `RUN_SQLCONNECT_EMULATOR_TESTS=1 but no Data Connect emulator is reachable on ${SQLCONNECT_HOST}.\n` +
      'Boot one from dataconnect/: npx firebase-tools emulators:start --only dataconnect',
  );
}

// The twin's SDK reads DATA_CONNECT_EMULATOR_HOST when its client is first
// created, so the env var is set BEFORE the twin (and its SDK) load — the
// same import-ordering rule the Firestore emulator suite follows.
let stores: typeof import('./sqlconnect-stores');
let sessionServiceModule: typeof import('./session-service');

beforeAll(async () => {
  process.env.DATA_CONNECT_EMULATOR_HOST = SQLCONNECT_HOST;
  if (getApps().length === 0) {
    initializeApp({ projectId: 'demo-cook-with-freebuff' });
  }
  stores = await import('./sqlconnect-stores');
  sessionServiceModule = await import('./session-service');
});

/** Unique per-run ids: the emulator's PGLite database persists across runs. */
const run = Date.now();
let seq = 0;
const uid = (p: string) => `${p}-${run}-${++seq}`;

describe.skipIf(!emulatorUp)('SQL Connect store twin · Data Connect emulator', () => {
  it('marks BOTH the derived transition id and the request id on a correlated create, in one transaction', async () => {
    const service = new sessionServiceModule.SessionService(stores.sqlconnectSessionStore);
    const cid = uid('cid');
    const session = await service.createSession('emulator-user', { correlationId: cid });

    // The create auto-transitions out of IDLE (version 2), and the marker
    // table holds BOTH ids — the two-marker transaction committed atomically.
    expect(session.version).toBe(2);
    expect(session.currentPhase).toBe('COLLECTING_INGREDIENTS');
    expect(await stores.sqlconnectSessionStore.hasCorrelationMarker(`idle->${cid}`)).toBe(true);
    expect(await stores.sqlconnectSessionStore.hasCorrelationMarker(cid)).toBe(true);
  });

  it('dedupes a retried create with the same correlation id to the same session', async () => {
    const service = new sessionServiceModule.SessionService(stores.sqlconnectSessionStore);
    const cid = uid('cid');
    const first = await service.createSession('emulator-user', { correlationId: cid });
    const retry = await service.createSession('emulator-user', { correlationId: cid });
    expect(retry.id).toBe(first.id);
    expect(retry.version).toBe(first.version);
  });

  it('commits a mark+clear transition atomically: cleared marker gone, kept marker present', async () => {
    const store = stores.sqlconnectSessionStore;
    const service = new sessionServiceModule.SessionService(store);
    const cid = uid('cid');
    const session = await service.createSession('emulator-user', { correlationId: cid });

    // The rollback shape: the re-pause writes its OWN marker and clears the
    // original resume marker in the SAME transaction.
    const rollbackMarker = uid('rollback');
    await store.updateSession(
      session.id,
      { status: 'PAUSED', pausedAt: Date.now() },
      session.version,
      { mark: rollbackMarker, clear: cid },
    );

    expect(await store.hasCorrelationMarker(rollbackMarker)).toBe(true);
    expect(await store.hasCorrelationMarker(cid)).toBe(false);
    const reloaded = await store.getSession(session.id);
    expect(reloaded?.status).toBe('PAUSED');
    expect(reloaded?.version).toBe(session.version + 1);
  });

  it('preserves every field a one-field update did not carry', async () => {
    const store = stores.sqlconnectSessionStore;
    const service = new sessionServiceModule.SessionService(store);
    const session = await service.createSession('emulator-user');

    await store.updateSession(
      session.id,
      { status: 'PAUSED', pausedAt: 1_234_567 },
      session.version,
    );
    const reloaded = await store.getSession(session.id);
    expect(reloaded?.status).toBe('PAUSED');
    // Untouched columns survive (the omitted-variable contract): the create
    // transition's resumableState and the recipe-less id are intact, and the
    // explicit fields of the partial are the only deltas.
    expect(reloaded?.version).toBe(session.version + 1);
    expect(reloaded?.currentPhase).toBe(session.currentPhase);
    expect(reloaded?.activeTimerIds).toEqual(session.activeTimerIds);
    expect(reloaded?.startedAt).toBe(session.startedAt);
    expect(reloaded?.userId).toBe(session.userId);
    expect(reloaded?.pausedAt).toBe(1_234_567);
  });

  it('persists recipeId when a partial attaches one (guided cooking attach)', async () => {
    const store = stores.sqlconnectSessionStore;
    const id = uid('no-recipe');
    const t = Date.now();
    await store.createSession({
      id,
      userId: 'emulator-user',
      status: 'ACTIVE',
      currentPhase: 'COLLECTING_INGREDIENTS',
      currentPrepStepIndex: 0,
      currentCookingStepIndex: 0,
      activeTimerIds: [],
      availableIngredients: [],
      startedAt: t,
      lastActivityAt: t,
      version: 1,
    });
    const recipeId = uid('recipe');
    await store.updateSession(id, { recipeId }, 1);
    const reloaded = await store.getSession(id);
    expect(reloaded?.recipeId).toBe(recipeId);
    expect(reloaded?.version).toBe(2);
  });

  it('surfaces a stale expectedVersion as VersionConflictError through the service', async () => {
    const service = new sessionServiceModule.SessionService(stores.sqlconnectSessionStore);
    const session = await service.createSession('emulator-user');
    await expect(
      service.transitionTo(session.id, 999, 'CONFIRMING_INGREDIENTS', 'USER_INPUT'),
    ).rejects.toThrow(sessionServiceModule.VersionConflictError);
    // The losing update must not have advanced the session.
    const reloaded = await stores.sqlconnectSessionStore.getSession(session.id);
    expect(reloaded?.version).toBe(session.version);
  });

  it('reports the store-level conflict error for a directly stale update', async () => {
    const store = stores.sqlconnectSessionStore;
    const service = new sessionServiceModule.SessionService(store);
    const session = await service.createSession('emulator-user');
    await expect(
      store.updateSession(session.id, { status: 'PAUSED' }, 99),
    ).rejects.toThrow(/version conflict/i);
  });

  it('rolls the marker writes back when the guarded update aborts (transaction atomicity)', async () => {
    const store = stores.sqlconnectSessionStore;
    const service = new sessionServiceModule.SessionService(store);
    const cid = uid('cid');
    const session = await service.createSession('emulator-user', { correlationId: cid });

    // A successful unmarked bump moves the version forward, so the marked
    // update below carries a genuinely stale expectedVersion.
    await store.updateSession(
      session.id,
      { status: 'PAUSED', pausedAt: Date.now() },
      session.version,
    );
    const staleVersion = session.version;

    // Now a marked transition that loses the race: the @check version guard
    // fails INSIDE the mutation, so the mark and the clear must abort with
    // it. A regression that moved the marker writes out of the guarded
    // transaction would still land them on the conflict — leaving a phantom
    // marker a retry could double-consume and a cleared marker a resume
    // path still depends on.
    const doomedMarker = uid('doomed');
    await expect(
      store.updateSession(
        session.id,
        { status: 'ACTIVE', currentPhase: 'CONFIRMING_INGREDIENTS' },
        staleVersion,
        { mark: doomedMarker, clear: cid },
      ),
    ).rejects.toThrow(/version conflict/i);

    // Full rollback, verified on real rows: the session is untouched, the
    // doomed marker never existed, and the cleared marker is still present.
    expect(await store.hasCorrelationMarker(doomedMarker)).toBe(false);
    expect(await store.hasCorrelationMarker(cid)).toBe(true);
    const reloaded = await store.getSession(session.id);
    expect(reloaded?.version).toBe(staleVersion + 1);
    expect(reloaded?.status).toBe('PAUSED');
  });

  it('round-trips a timer completion through the twin', async () => {
    const store = stores.sqlconnectTimerStore;
    const startedAt = Date.now();
    const timerId = uid('timer');
    await store.createTimer({
      id: timerId,
      userId: 'emulator-user',
      sessionId: uid('timer-session'),
      label: 'Boil',
      durationSeconds: 60,
      startedAt,
      endsAt: startedAt + 60_000,
      status: 'RUNNING',
    });
    await store.updateTimer(timerId, { status: 'COMPLETED', completedAt: startedAt + 61_000 });
    const reloaded = await store.getTimer(timerId);
    expect(reloaded?.status).toBe('COMPLETED');
    expect(reloaded?.completedAt).toBe(startedAt + 61_000);
    // The deadline was NOT in the partial: it survives the completion write.
    expect(reloaded?.endsAt).toBe(startedAt + 60_000);
    // Immutable fields cannot be changed (the boundary, enforced on real data).
    await expect(
      store.updateTimer(timerId, { durationSeconds: 120 }),
    ).rejects.toThrow(/cannot express/);
  });
});
