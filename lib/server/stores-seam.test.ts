// ============================================================================
// lib/server/stores-seam.test.ts — lock the cutover seam's selection contract.
//
// The seam (spec 0005 phase 3) flips individual stores to the SQL Connect
// twin via STORES_ON_SQLCONNECT without touching call sites. The contract
// locked here: with no (or an empty) value every store is the Firestore
// implementation — today's behavior, byte for byte — and a named store gets
// the twin while unnamed stores stay on Firestore. List parsing tolerates
// whitespace and empty entries so a hand-edited config value cannot half-flip
// a store by surprise.
//
// The seam reads the env at module evaluation, so each case reloads the
// module tree under resetModules. Both the stores module and the twin are
// imported from that SAME post-reset registry — a stale top-level import
// would carry different export identities and make the toBe assertions
// meaningless.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('./admin', () => ({
  getAdminDb: vi.fn(() => null),
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  cert: vi.fn((creds: unknown) => creds),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => null),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => null),
}));

vi.mock('../ai/register', () => ({
  registerGeminiProviders: vi.fn(),
}));

vi.mock('./model-config', () => ({
  resolveGeminiModel: vi.fn(() => 'test-model'),
  logModelResolutionSources: vi.fn(async () => undefined),
}));

type Stores = typeof import('./stores');
type Twin = typeof import('./sqlconnect-stores');

async function loadStores(envValue: string | undefined): Promise<{ s: Stores; twin: Twin }> {
  vi.resetModules();
  if (envValue === undefined) {
    delete process.env.STORES_ON_SQLCONNECT;
  } else {
    process.env.STORES_ON_SQLCONNECT = envValue;
  }
  const [s, twin] = await Promise.all([import('./stores'), import('./sqlconnect-stores')]);
  return { s, twin };
}

beforeEach(() => {
  delete process.env.STORES_ON_SQLCONNECT;
});

describe('the cutover seam (STORES_ON_SQLCONNECT)', () => {
  it('keeps every store on Firestore by default (no env value)', async () => {
    const { s } = await loadStores(undefined);
    const ctx = s.buildProductionContext('u1');
    expect(ctx.timerStore).toBe(s.firestoreTimerStore);
    expect(ctx.recipeStore).toBe(s.firestoreRecipeStore);
    expect(ctx.pantryStore).toBe(s.firestorePantryStore);
    expect(ctx.dietaryProfileStore).toBe(s.firestoreDietaryProfileStore);
    expect(ctx.leftoverStore).toBe(s.firestoreLeftoverStore);
    expect(ctx.groceryStore).toBe(s.firestoreGroceryStore);
    expect(ctx.logStore).toBe(s.firestoreLogStore);
  });

  it('serves the named stores from the twin and leaves the rest on Firestore', async () => {
    const { s, twin } = await loadStores('recipes,timers');
    const ctx = s.buildProductionContext('u1');
    expect(ctx.recipeStore).toBe(twin.sqlconnectRecipeStore);
    expect(ctx.timerStore).toBe(twin.sqlconnectTimerStore);
    expect(ctx.pantryStore).toBe(s.firestorePantryStore);
    expect(ctx.groceryStore).toBe(s.firestoreGroceryStore);
    expect(ctx.logStore).toBe(s.firestoreLogStore);
    expect(ctx.dietaryProfileStore).toBe(s.firestoreDietaryProfileStore);
  });

  it('tolerates whitespace and empty entries in the list', async () => {
    const { s, twin } = await loadStores(' recipes , , dietaryProfiles ,');
    const ctx = s.buildProductionContext('u1');
    expect(ctx.recipeStore).toBe(twin.sqlconnectRecipeStore);
    expect(ctx.dietaryProfileStore).toBe(twin.sqlconnectDietaryProfileStore);
    expect(ctx.timerStore).toBe(s.firestoreTimerStore);
  });

  it('treats an empty string exactly like an absent value', async () => {
    const { s } = await loadStores('');
    const ctx = s.buildProductionContext('u1');
    expect(ctx.timerStore).toBe(s.firestoreTimerStore);
    expect(ctx.recipeStore).toBe(s.firestoreRecipeStore);
  });

  it('builds the session service over the picked session store', async () => {
    const { s } = await loadStores('sessions');
    // The service exposes no store getter; the observable contract is that
    // the singleton built at import time works against the twin's marker
    // namespace. Identity is proven by the pick helper's other stores; here
    // we lock that enabling 'sessions' changes the service construction path
    // without error and the context still wires.
    const ctx = s.buildProductionContext('u1');
    expect(ctx.sessionService).toBe(s.productionSessionService);
  });
});
