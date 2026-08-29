// ============================================================================
// lib/server/store-backend-contract.emulator.test.ts — shared backend contract.
//
// This suite deliberately covers only behavior shared by the Firestore and
// SQL Connect implementations. Firestore-only legacy marker compatibility
// remains in repositories.test.ts; SQL Connect-specific transaction coverage
// remains in sqlconnect-stores.emulator.test.ts.
//
// Backend selection:
//   BACKEND_CONTRACT=firestore  uses the Firestore emulator on port 8080
//   BACKEND_CONTRACT=sqlconnect uses the SQL Connect emulator on port 9399
//
// Without the selected emulator, the suite skips. With RUN_EMULATOR_TESTS=1
// or RUN_SQLCONNECT_EMULATOR_TESTS=1, an unreachable emulator is a failure.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';

vi.mock('server-only', () => ({}));
import { initializeApp, getApps } from 'firebase-admin/app';
import {
  EMULATOR_HOST,
  AUTO_BOOT,
  bootEmulator,
} from '../../scripts/emulator-test-helper';

const backend = process.env.BACKEND_CONTRACT ?? 'firestore';
const isSqlConnect = backend === 'sqlconnect';
const sqlConnectHost = process.env.DATA_CONNECT_EMULATOR_HOST ?? '127.0.0.1:9399';
const sqlConnectPort = Number(sqlConnectHost.split(':').slice(-1)[0]);
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? EMULATOR_HOST;
const firestorePort = Number(firestoreHost.split(':').slice(-1)[0]);
const autoBoot = isSqlConnect
  ? process.env.RUN_SQLCONNECT_EMULATOR_TESTS === '1'
  : AUTO_BOOT;

function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

const emulatorUp = await portInUse(isSqlConnect ? sqlConnectPort : firestorePort);
if (!emulatorUp && autoBoot && !isSqlConnect) {
  // The Firestore helper owns its own boot lifecycle and its environment
  // setup. SQL Connect is booted by the CI shell and by the existing suite.
  // Firestore is the only backend this shared file auto-boots.
}

let ownedFirestoreEmulator: { stop: () => Promise<void> } | null = null;
let stores: typeof import('./stores');
let sqlStores: typeof import('./sqlconnect-stores');

beforeAll(async () => {
  if (isSqlConnect) {
    process.env.DATA_CONNECT_EMULATOR_HOST = sqlConnectHost;
    if (getApps().length === 0) initializeApp({ projectId: 'demo-cook-with-freebuff' });
    sqlStores = await import('./sqlconnect-stores');
  } else {
    process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
    if (!emulatorUp && autoBoot) {
      ownedFirestoreEmulator = await bootEmulator();
    }
    stores = await import('./stores');
  }
});

afterAll(async () => {
  await ownedFirestoreEmulator?.stop();
});

const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const id = (prefix: string) => `${prefix}-${runId}`;

describe.skipIf(!emulatorUp && !autoBoot)(`shared store contract · ${backend}`, () => {
  it('round-trips a recipe through create, get, list, update, and delete', async () => {
    const recipe = {
      id: id('recipe'),
      userId: id('user'),
      title: 'Contract recipe',
      description: 'Backend contract fixture',
      servings: 2,
      estimatedPrepMinutes: 5,
      estimatedCookMinutes: 10,
      totalMinutes: 15,
      ingredients: [{ id: id('ingredient'), name: 'rice', quantity: 1, unit: 'cup', optional: false }],
      equipment: ['pot'],
      prepSteps: [],
      cookingSteps: [],
      dietaryTags: [],
      allergens: [],
      safetyNotes: [],
      generatedAt: Date.now(),
      updatedAt: Date.now(),
    } as Parameters<typeof import('./repositories')['createRecipe']>[0];

    if (isSqlConnect) {
      await sqlStores.sqlconnectRecipeStore.createRecipe(recipe);
      expect(await sqlStores.sqlconnectRecipeStore.getRecipe(recipe.id)).toMatchObject({ id: recipe.id });
      expect(await sqlStores.sqlconnectRecipeStore.listRecipes(recipe.userId!)).toHaveLength(1);
      await sqlStores.sqlconnectRecipeStore.updateRecipe({ ...recipe, title: 'Updated contract recipe' });
      expect((await sqlStores.sqlconnectRecipeStore.getRecipe(recipe.id))?.title).toBe('Updated contract recipe');
      await sqlStores.sqlconnectRecipeStore.deleteRecipe(recipe.id);
      expect(await sqlStores.sqlconnectRecipeStore.getRecipe(recipe.id)).toBeNull();
    } else {
      await stores.firestoreRecipeStore.createRecipe(recipe);
      expect(await stores.firestoreRecipeStore.getRecipe(recipe.id)).toMatchObject({ id: recipe.id });
      expect(await stores.firestoreRecipeStore.listRecipes(recipe.userId!)).toHaveLength(1);
      await stores.firestoreRecipeStore.updateRecipe({ ...recipe, title: 'Updated contract recipe' });
      expect((await stores.firestoreRecipeStore.getRecipe(recipe.id))?.title).toBe('Updated contract recipe');
      await stores.firestoreRecipeStore.deleteRecipe(recipe.id);
      expect(await stores.firestoreRecipeStore.getRecipe(recipe.id)).toBeNull();
    }
  });

  it('round-trips a timer through create, active listing, update, and get', async () => {
    const timer = {
      id: id('timer'),
      userId: id('user'),
      sessionId: id('session'),
      label: 'Contract timer',
      durationSeconds: 60,
      startedAt: Date.now(),
      endsAt: Date.now() + 60_000,
      status: 'RUNNING',
    } as Parameters<typeof import('./repositories')['createTimer']>[0];
    const store = isSqlConnect ? sqlStores.sqlconnectTimerStore : stores.firestoreTimerStore;
    await store.createTimer(timer);
    expect(await store.getTimer(timer.id)).toMatchObject({ id: timer.id, status: 'RUNNING' });
    expect(await store.listActiveTimers(timer.sessionId)).toHaveLength(1);
    await store.updateTimer(timer.id, { status: 'COMPLETED', completedAt: Date.now() });
    expect((await store.getTimer(timer.id))?.status).toBe('COMPLETED');
  });
});
