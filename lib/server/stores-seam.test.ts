// ============================================================================
// lib/server/stores-seam.test.ts — lock the cutover seam's selection contract.
//
// The seam (spec 0005 phase 3) moves a store through three stages via two
// env lists, with zero call-site edits:
//
//   (none)                 every store on Firestore — today's behavior.
//   STORES_DUAL_WRITE=x    writes fan out to Firestore (authoritative) and
//                          the twin (best-effort, logged on failure); reads
//                          stay on Firestore. The backfill window.
//   STORES_DUAL_WRITE=x +  reads flip to the twin while dual-write
//   STORES_ON_SQLCONNECT=x continues, so not-yet-redeployed instances still
//                          write both backends during a rolling deploy.
//
// The fence: flipping reads without dual-write enabled fails at boot —
// writes accepted during a backfill or rolling deploy would land only in
// Firestore and vanish from SQL Connect reads.
//
// The event plane is independent: `events` is its own key, routed through
// splitSessionStore, so events can cut over before session rows and markers
// (the documented order) while marker mutations stay atomic with session
// updates on the session plane.
//
// The seam reads the env at module evaluation, so each case reloads the
// module tree under resetModules. stores, the twin, and the repo module are
// imported from that SAME post-reset registry — a stale top-level import
// would carry different export identities and make routing assertions
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

const mockFn = () => vi.fn();

vi.mock('./repositories', () => ({
  getSession: mockFn(),
  createSession: mockFn(),
  updateSession: mockFn(),
  getActiveSession: mockFn(),
  createEvent: mockFn(),
  listSessionEvents: mockFn(),
  hasCorrelationMarker: mockFn(),
  markCorrelationMarker: mockFn(),
  clearCorrelationMarker: mockFn(),
  createTimer: mockFn(),
  getTimer: mockFn(),
  updateTimer: mockFn(),
  listActiveTimers: mockFn(),
  rebaseActiveTimers: mockFn(),
  createToolLog: mockFn(),
  createRecipe: mockFn(),
  getRecipe: mockFn(),
  updateRecipe: mockFn(),
  listRecipes: mockFn(),
  deleteRecipe: mockFn(),
  listPantryItems: mockFn(),
  getPantryItem: mockFn(),
  createPantryItem: mockFn(),
  deletePantryItem: mockFn(),
  getDietaryProfile: mockFn(),
  upsertDietaryProfile: mockFn(),
  createLeftover: mockFn(),
  getLeftover: mockFn(),
  listLeftovers: mockFn(),
  updateLeftover: mockFn(),
  createGroceryItem: mockFn(),
  getGroceryItem: mockFn(),
  listGroceryItems: mockFn(),
  updateGroceryItem: mockFn(),
  deleteGroceryItem: mockFn(),
}));

vi.mock('./sqlconnect-stores', () => ({
  sqlconnectSessionStore: {
    getSession: mockFn(),
    createSession: mockFn(),
    updateSession: mockFn(),
    getActiveSession: mockFn(),
    createEvent: mockFn(),
    listSessionEvents: mockFn(),
    hasCorrelationMarker: mockFn(),
    markCorrelationMarker: mockFn(),
    clearCorrelationMarker: mockFn(),
  },
  sqlconnectTimerStore: {
    createTimer: mockFn(),
    getTimer: mockFn(),
    updateTimer: mockFn(),
    listActiveTimers: mockFn(),
    rebaseActiveTimers: mockFn(),
  },
  sqlconnectLogStore: { createLog: mockFn() },
  sqlconnectRecipeStore: {
    createRecipe: mockFn(),
    getRecipe: mockFn(),
    updateRecipe: mockFn(),
    listRecipes: mockFn(),
    deleteRecipe: mockFn(),
  },
  sqlconnectPantryStore: { listItems: mockFn(), getItem: mockFn(), upsertItem: mockFn(), deleteItem: mockFn() },
  sqlconnectDietaryProfileStore: { getProfile: mockFn(), upsertProfile: mockFn() },
  sqlconnectLeftoverStore: {
    createLeftover: mockFn(),
    getLeftover: mockFn(),
    listLeftovers: mockFn(),
    updateLeftover: mockFn(),
  },
  sqlconnectGroceryStore: {
    createGroceryItem: mockFn(),
    getGroceryItem: mockFn(),
    listGroceryItems: mockFn(),
    updateGroceryItem: mockFn(),
    deleteGroceryItem: mockFn(),
  },
}));

type Stores = typeof import('./stores');
type Twin = typeof import('./sqlconnect-stores');
type Repo = typeof import('./repositories');

async function loadStores(env: Record<string, string | undefined>): Promise<{
  stores: Stores;
  twin: Twin;
  repo: Repo;
}> {
  vi.resetModules();
  for (const key of ['STORES_DUAL_WRITE', 'STORES_ON_SQLCONNECT']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  // Sequential, twin FIRST: after resetModules the mock module must be
  // instantiated before stores.ts resolves its own './sqlconnect-stores'
  // import — parallel dynamic imports race the mock instantiation and
  // stores.ts can end up with the real module (the routed call then hits
  // the real SDK instead of the mocks asserted on below).
  const twin = (await import('./sqlconnect-stores')) as unknown as Twin;
  const stores = (await import('./stores')) as Stores;
  const repoMod = (await import('./repositories')) as Repo;
  return { stores, twin, repo: repoMod };
}

const RECIPE = { id: 'r1', userId: 'u1' } as unknown as Parameters<
  Stores['firestoreRecipeStore']['createRecipe']
>[0];

beforeEach(() => {
  // resetModules does not clear the mock registry, so the cached factory
  // instances (and their call counts) persist across tests — reset history
  // explicitly so per-test routing assertions start from zero.
  vi.clearAllMocks();
  delete process.env.STORES_DUAL_WRITE;
  delete process.env.STORES_ON_SQLCONNECT;
});

describe('the cutover seam (STORES_DUAL_WRITE / STORES_ON_SQLCONNECT)', () => {
  it('keeps every store on Firestore by default (reads and writes)', async () => {
    const { stores, twin, repo } = await loadStores({});
    const ctx = stores.buildProductionContext('u1');
    await ctx.recipeStore!.getRecipe('r1');
    await ctx.recipeStore!.createRecipe(RECIPE);
    expect(repo.getRecipe).toHaveBeenCalledTimes(1);
    expect(repo.createRecipe).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectRecipeStore.getRecipe).not.toHaveBeenCalled();
    expect(twin.sqlconnectRecipeStore.createRecipe).not.toHaveBeenCalled();
  });

  it('fails at boot when a store flips reads without the dual-write stage', async () => {
    vi.resetModules();
    process.env.STORES_ON_SQLCONNECT = 'recipes';
    await expect(import('./stores')).rejects.toThrow(/STORES_DUAL_WRITE/);
    delete process.env.STORES_ON_SQLCONNECT;
  });

  it('dual-write: writes fan out to both backends, reads stay on Firestore', async () => {
    const { stores, twin, repo } = await loadStores({ STORES_DUAL_WRITE: 'recipes' });
    const ctx = stores.buildProductionContext('u1');
    await ctx.recipeStore!.createRecipe(RECIPE);
    expect(repo.createRecipe).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectRecipeStore.createRecipe).toHaveBeenCalledTimes(1);
    await ctx.recipeStore!.getRecipe('r1');
    expect(repo.getRecipe).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectRecipeStore.getRecipe).not.toHaveBeenCalled();
  });

  it('dual-write: a twin failure never breaks the primary write (logged, best-effort)', async () => {
    const { stores, twin } = await loadStores({ STORES_DUAL_WRITE: 'recipes' });
    vi.mocked(twin.sqlconnectRecipeStore.createRecipe).mockRejectedValueOnce(new Error('dc down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = stores.buildProductionContext('u1');
    await expect(ctx.recipeStore!.createRecipe(RECIPE)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      '[dual-write] secondary write failed',
      expect.objectContaining({
        event: 'sqlconnect_dual_write_drift',
        store: 'recipes',
        operation: 'createRecipe',
        id: RECIPE.id,
        action: 'backfill_required',
      }),
    );
    errSpy.mockRestore();
  });

  it('flip: reads come from the twin while writes still fan out to both', async () => {
    const { stores, twin, repo } = await loadStores({
      STORES_DUAL_WRITE: 'recipes',
      STORES_ON_SQLCONNECT: 'recipes',
    });
    const ctx = stores.buildProductionContext('u1');
    await ctx.recipeStore!.getRecipe('r1');
    expect(twin.sqlconnectRecipeStore.getRecipe).toHaveBeenCalledTimes(1);
    expect(repo.getRecipe).not.toHaveBeenCalled();
    await ctx.recipeStore!.createRecipe(RECIPE);
    expect(repo.createRecipe).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectRecipeStore.createRecipe).toHaveBeenCalledTimes(1);
  });

  it('events: the event plane flips independently of the session plane', async () => {
    const { stores, twin, repo } = await loadStores({
      STORES_DUAL_WRITE: 'events',
      STORES_ON_SQLCONNECT: 'events',
    });
    // Event methods route to the twin's event plane...
    await stores.productionSessionStore.listSessionEvents('s1');
    expect(twin.sqlconnectSessionStore.listSessionEvents).toHaveBeenCalledTimes(1);
    expect(repo.listSessionEvents).not.toHaveBeenCalled();
    // ...while session rows and markers stay on Firestore.
    await stores.productionSessionStore.getSession('s1');
    expect(repo.getSession).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectSessionStore.getSession).not.toHaveBeenCalled();
  });

  it('events dual-write: createEvent lands in both backends', async () => {
    const { stores, twin, repo } = await loadStores({ STORES_DUAL_WRITE: 'events' });
    const event = {
      id: 'e1',
      sessionId: 's1',
      userId: 'u1',
      type: 'TEST',
      at: 1,
    } as unknown as Parameters<Stores['productionSessionStore']['createEvent']>[0];
    await stores.productionSessionStore.createEvent(event);
    expect(repo.createEvent).toHaveBeenCalledTimes(1);
    expect(twin.sqlconnectSessionStore.createEvent).toHaveBeenCalledTimes(1);
  });

  it('tolerates whitespace and empty entries in both lists', async () => {
    const { stores, twin, repo } = await loadStores({
      STORES_DUAL_WRITE: ' recipes , timers ,',
      STORES_ON_SQLCONNECT: ' recipes , , ',
    });
    const ctx = stores.buildProductionContext('u1');
    await ctx.recipeStore!.getRecipe('r1');
    expect(twin.sqlconnectRecipeStore.getRecipe).toHaveBeenCalledTimes(1);
    expect(repo.getRecipe).not.toHaveBeenCalled();
    // Timers are dual-write only: reads stay on Firestore.
    await stores.firestoreTimerStore.getTimer('t1');
    expect(twin.sqlconnectTimerStore.getTimer).not.toHaveBeenCalled();
  });

  it('treats an empty string exactly like an absent value', async () => {
    const { stores, twin } = await loadStores({
      STORES_DUAL_WRITE: '',
      STORES_ON_SQLCONNECT: '',
    });
    const ctx = stores.buildProductionContext('u1');
    await ctx.recipeStore!.getRecipe('r1');
    expect(twin.sqlconnectRecipeStore.getRecipe).not.toHaveBeenCalled();
    expect(ctx.sessionService).toBe(stores.productionSessionService);
  });
});
