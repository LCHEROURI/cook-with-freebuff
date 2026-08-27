// ============================================================================
// lib/server/sqlconnect-stores.test.ts — lock the SQL Connect twin's contract.
//
// The twin (migration Phase 2, spec 0005) must satisfy the same contracts the
// Firestore repositories lock in repositories.test.ts: zod validation before
// any I/O, immutable-field enforcement, the updateSession optimistic-
// concurrency error (matching /version conflict/i so the session service can
// wrap it), and the marker riding the same mutation as the session update.
// The generated SDK is mocked: these tests prove the boundary, not the wire.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// Every operation the twin may call. Tests assert on these; any call NOT
// configured by a test failing loudly is the point (validate-before-IO).
vi.mock('./dataconnect', () => ({
  getCookingSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionWithMarker: vi.fn(),
  getActiveSession: vi.fn(),
  insertCookingSession: vi.fn(),
  insertSessionEvent: vi.fn(),
  getSessionEvents: vi.fn(),
  getCorrelationMarker: vi.fn(),
  upsertCorrelationMarker: vi.fn(),
  deleteCorrelationMarker: vi.fn(),
  updateSessionWithTwoMarkers: vi.fn(),
  insertCookingTimer: vi.fn(),
  getCookingTimer: vi.fn(),
  updateCookingTimer: vi.fn(),
  getActiveTimers: vi.fn(),
  rebaseTimers: vi.fn(),
  saveRecipe: vi.fn(),
  getRecipe: vi.fn(),
  listRecipes: vi.fn(),
  deleteRecipe: vi.fn(),
  listPantryItems: vi.fn(),
  getPantryItem: vi.fn(),
  upsertPantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  getDietaryProfile: vi.fn(),
  upsertDietaryProfile: vi.fn(),
  upsertLeftover: vi.fn(),
  getLeftover: vi.fn(),
  listLeftovers: vi.fn(),
  upsertGroceryItem: vi.fn(),
  getGroceryItem: vi.fn(),
  listGroceryItems: vi.fn(),
  deleteGroceryItem: vi.fn(),
  insertAgentToolLog: vi.fn(),
}));

import * as sdk from './dataconnect';
import {
  sqlconnectSessionStore,
  sqlconnectTimerStore,
  sqlconnectRecipeStore,
  sqlconnectLeftoverStore,
} from './sqlconnect-stores';
import { markerKey } from './repositories';

const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Schema-valid recipe body pieces (recipeSchema requires non-empty arrays). */
const INGREDIENT = { id: 'i1', name: 'pasta', quantity: 0.5, unit: 'cup', optional: false };
const PREP_STEP = {
  id: 'p1',
  stepNumber: 1,
  instruction: 'Boil water',
  spokenInstruction: 'Boil water',
  estimatedSeconds: 60,
  ingredientsUsed: [],
  equipmentUsed: [],
};
const COOKING_STEP = {
  id: 'c1',
  stepNumber: 1,
  instruction: 'Cook pasta',
  spokenInstruction: 'Cook the pasta',
  ingredientsUsed: ['i1'],
  equipmentUsed: [],
};

/** A full session row as the SDK returns it (ISO timestamps, null columns). */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: 'u1',
    recipeId: null,
    status: 'ACTIVE',
    currentPhase: 'PREP_GUIDANCE',
    currentPrepStepIndex: 0,
    currentCookingStepIndex: 0,
    previousState: null,
    resumableState: null,
    activeTimerIds: [],
    availableIngredients: [],
    recoveryContext: null,
    pendingSubstitution: null,
    pendingPantryItems: null,
    startedAt: iso(T0),
    lastActivityAt: iso(T0),
    pausedAt: null,
    completedAt: null,
    version: 2,
    ...overrides,
  };
}

function timerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    userId: 'u1',
    sessionId: 's1',
    label: 'Boil',
    durationSeconds: 60,
    startedAt: iso(T0),
    endsAt: iso(T0 + 60_000),
    status: 'RUNNING',
    stepId: null,
    completedAt: null,
    ...overrides,
  };
}

function recipeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    userId: 'u1',
    title: 'Pasta',
    description: null,
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 10,
    totalMinutes: 15,
    ingredients: [],
    prepSteps: [],
    cookingSteps: [],
    equipment: [],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    proteinCategories: null,
    preferences: null,
    generatedAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function leftoverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    userId: 'u1',
    recipeId: null,
    title: 'Pasta leftovers',
    servings: 2,
    completedAt: iso(T0),
    storedAt: iso(T0),
    status: 'ACTIVE',
    notes: null,
    ...overrides,
  };
}

/** A schema-valid recipe for create/update calls. */
function recipeInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    userId: 'u1',
    title: 'Pasta',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 10,
    totalMinutes: 15,
    ingredients: [INGREDIENT],
    prepSteps: [PREP_STEP],
    cookingSteps: [COOKING_STEP],
    equipment: ['pot'],
    dietaryTags: ['vegetarian'],
    allergens: [],
    safetyNotes: [],
    generatedAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const key = (res: unknown) => ({ data: res as unknown as Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Session store: optimistic concurrency + markers ──────────────────────────

describe('sqlconnectSessionStore.updateSession — concurrency contract', () => {
  it('throws the version-conflict error and never calls a mutation on mismatch', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow({ version: 3 }) }) as never,
    );
    await expect(
      sqlconnectSessionStore.updateSession('s1', { status: 'PAUSED' }, 2),
    ).rejects.toThrow(/version conflict/i);
    expect(sdk.updateSession).not.toHaveBeenCalled();
    expect(sdk.updateSessionWithMarker).not.toHaveBeenCalled();
  });

  it('throws not-found before any mutation when the session is missing', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(key({}) as never);
    await expect(
      sqlconnectSessionStore.updateSession('nope', { status: 'PAUSED' }, 1),
    ).rejects.toThrow('Session nope not found');
    expect(sdk.updateSession).not.toHaveBeenCalled();
  });

  it('rejects immutable-field changes before calling the connector', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    await expect(
      sqlconnectSessionStore.updateSession(
        's1',
        { userId: 'someone-else' } as never,
        2,
      ),
    ).rejects.toThrow('Cannot change immutable field userId');
    expect(sdk.updateSession).not.toHaveBeenCalled();
  });

  it('updates without a marker and returns the merged row with version+1', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSession).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    const updated = await sqlconnectSessionStore.updateSession('s1', {
      status: 'PAUSED',
      pausedAt: T0 + 5,
    }, 2);    expect(sdk.updateSessionWithMarker).not.toHaveBeenCalled();
    const vars = vi.mocked(sdk.updateSession).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(vars.expectedVersion).toBe(2);
    expect(vars.status).toBe('PAUSED');
    expect(vars.pausedAt).toBe(iso(T0 + 5));
    expect(typeof vars.lastActivityAt).toBe('string');
    // Fields the partial did not carry are OMITTED (never coerced to null):
    // the emulator-verified contract is that absent update vars leave their
    // columns untouched, so a one-field update cannot clobber the row.
    expect(vars.previousState).toBeUndefined();
    expect(vars.resumableState).toBeUndefined();
    expect(vars.recipeId).toBeUndefined();
    expect(vars.availableIngredients).toBeUndefined();
    // The returned row is the merged state this update produced.
    expect(updated.version).toBe(3);
    expect(updated.status).toBe('PAUSED');
    expect(updated.pausedAt).toBe(T0 + 5);
  });

  it('persists recipeId when the partial attaches one (guided cooking attach)', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSession).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    const updated = await sqlconnectSessionStore.updateSession('s1', { recipeId: 'r-attached' }, 2);
    const vars = vi.mocked(sdk.updateSession).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(vars.recipeId).toBe('r-attached');
    expect(vars.status).toBeUndefined();
    expect(updated.recipeId).toBe('r-attached');
    expect(updated.version).toBe(3);
  });

  it('rides the marker in the SAME mutation, base64url keyed, no-op clear key', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSessionWithMarker).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    await sqlconnectSessionStore.updateSession(
      's1',
      { status: 'PAUSED' },
      2,
      { mark: 'pause-1' },
    );
    const vars = vi.mocked(sdk.updateSessionWithMarker).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars.markerKey).toBe(markerKey('pause-1'));
    expect(vars.markerRawId).toBe('pause-1');
    expect(vars.clearMarkerKey).toBe('');
    expect(sdk.updateSession).not.toHaveBeenCalled();
    expect(sdk.updateSessionWithTwoMarkers).not.toHaveBeenCalled();
  });

  it('rides TWO distinct markers in one transaction (the correlated create)', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSessionWithTwoMarkers).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    await sqlconnectSessionStore.updateSession('s1', {}, 2, {
      mark: ['idle->cid-1', 'cid-1'],
    });
    const vars = vi.mocked(sdk.updateSessionWithTwoMarkers).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars.markerKeyA).toBe(markerKey('idle->cid-1'));
    expect(vars.markerKeyB).toBe(markerKey('cid-1'));
    expect(sdk.updateSession).not.toHaveBeenCalled();
    expect(sdk.updateSessionWithMarker).not.toHaveBeenCalled();
  });

  it('carries the clear key through the same transaction when a marker clears', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSessionWithMarker).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    await sqlconnectSessionStore.updateSession('s1', {}, 2, {
      mark: 'resume-2',
      clear: 'a/b',
    });
    const vars = vi.mocked(sdk.updateSessionWithMarker).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars.clearMarkerKey).toBe(markerKey('a/b'));
  });

  it('maps a null @check result (raced after the read) to the conflict error', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSession).mockResolvedValue(key({}) as never);
    await expect(
      sqlconnectSessionStore.updateSession('s1', { status: 'PAUSED' }, 2),
    ).rejects.toThrow(/version conflict/i);
  });

  it('rejects more than two distinct markers (the connector carries two writes)', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    await expect(
      sqlconnectSessionStore.updateSession('s1', {}, 2, {
        mark: ['a', 'b', 'c'],
      }),
    ).rejects.toThrow(/at most two correlation markers/);
    expect(sdk.updateSessionWithMarker).not.toHaveBeenCalled();
    expect(sdk.updateSessionWithTwoMarkers).not.toHaveBeenCalled();
  });

  it('rejects clear-only transitions (not expressible in the connector)', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    await expect(
      sqlconnectSessionStore.updateSession('s1', {}, 2, { clear: 'a' }),
    ).rejects.toThrow(/cannot clear a marker without writing one/);
  });

  it('dedupes a repeated mark instead of failing (the service passes [cid, cid])', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    vi.mocked(sdk.updateSessionWithMarker).mockResolvedValue(
      key({ session_ver: { id: 's1' } }) as never,
    );
    await sqlconnectSessionStore.updateSession('s1', {}, 2, {
      mark: ['cid-1', 'cid-1'],
    });
    expect(sdk.updateSessionWithMarker).toHaveBeenCalledTimes(1);
  });
});

// ── Session store: reads + markers ───────────────────────────────────────────

describe('sqlconnectSessionStore reads and marker ops', () => {
  it('converts the session row timestamps back to EpochMs', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(
      key({ cookingSession: sessionRow() }) as never,
    );
    const s = await sqlconnectSessionStore.getSession('s1');
    expect(s?.startedAt).toBe(T0);
    expect(s?.lastActivityAt).toBe(T0);
    expect(s?.pausedAt).toBeUndefined();
  });

  it('returns null for a missing session', async () => {
    vi.mocked(sdk.getCookingSession).mockResolvedValue(key({}) as never);
    expect(await sqlconnectSessionStore.getSession('s1')).toBeNull();
  });

  it('takes the newest active row for getActiveSession', async () => {
    vi.mocked(sdk.getActiveSession).mockResolvedValue(
      key({ cookingSessions: [sessionRow({ id: 'newest' })] }) as never,
    );
    const s = await sqlconnectSessionStore.getActiveSession('u1');
    expect(s?.id).toBe('newest');
    vi.mocked(sdk.getActiveSession).mockResolvedValue(key({ cookingSessions: [] }) as never);
    expect(await sqlconnectSessionStore.getActiveSession('u1')).toBeNull();
  });

  it('looks markers up by the base64url key only (no legacy namespace here)', async () => {
    vi.mocked(sdk.getCorrelationMarker).mockResolvedValue(
      key({ correlationMarker: { key: markerKey('a/b'), rawId: 'a/b' } }) as never,
    );
    expect(await sqlconnectSessionStore.hasCorrelationMarker('a/b')).toBe(true);
    const vars = vi.mocked(sdk.getCorrelationMarker).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars.key).toBe('YS9i');

    vi.mocked(sdk.getCorrelationMarker).mockResolvedValue(key({}) as never);
    expect(await sqlconnectSessionStore.hasCorrelationMarker('a/b')).toBe(false);
  });

  it('marks and clears by the base64url key', async () => {
    await sqlconnectSessionStore.markCorrelationMarker('x');
    expect(vi.mocked(sdk.upsertCorrelationMarker).mock.calls[0][0]).toMatchObject({
      key: markerKey('x'),
      rawId: 'x',
    });
    await sqlconnectSessionStore.clearCorrelationMarker('x');
    expect(vi.mocked(sdk.deleteCorrelationMarker).mock.calls[0][0]).toMatchObject({
      key: markerKey('x'),
    });
  });
});

// ── Timer store: validate-before-IO boundary ─────────────────────────────────

describe('sqlconnectTimerStore.updateTimer — write boundary', () => {
  it('fails on a malformed partial before any I/O (no SDK call)', async () => {
    await expect(
      sqlconnectTimerStore.updateTimer('t1', {
        durationSeconds: 'sixty' as never,
      }),
    ).rejects.toThrow();
    expect(sdk.getCookingTimer).not.toHaveBeenCalled();
    expect(sdk.updateCookingTimer).not.toHaveBeenCalled();
  });

  it('rejects fields the connector cannot express, naming them', async () => {
    await expect(
      sqlconnectTimerStore.updateTimer('t1', { label: 'renamed' }),
    ).rejects.toThrow(/cannot express: label/);
    expect(sdk.getCookingTimer).not.toHaveBeenCalled();
  });

  it('rejects immutable timer fields (they are also inexpressible) with no I/O', async () => {
    await expect(
      sqlconnectTimerStore.updateTimer('t1', { durationSeconds: 120 }),
    ).rejects.toThrow(/cannot express: durationSeconds/);
    expect(sdk.getCookingTimer).not.toHaveBeenCalled();
    expect(sdk.updateCookingTimer).not.toHaveBeenCalled();
  });

  it('throws not-found for a missing timer', async () => {
    vi.mocked(sdk.getCookingTimer).mockResolvedValue(key({}) as never);
    await expect(
      sqlconnectTimerStore.updateTimer('t1', { status: 'COMPLETED' }),
    ).rejects.toThrow('timers/t1 not found');
  });

  it('sends the completion with an ISO completedAt and a null endsAt', async () => {
    vi.mocked(sdk.getCookingTimer).mockResolvedValue(
      key({ cookingTimer: timerRow() }) as never,
    );
    vi.mocked(sdk.updateCookingTimer).mockResolvedValue(key({}) as never);
    await sqlconnectTimerStore.updateTimer('t1', {
      status: 'COMPLETED',
      completedAt: T0 + 61_000,
    });
    const vars = vi.mocked(sdk.updateCookingTimer).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars).toEqual({
      id: 't1',
      status: 'COMPLETED',
      completedAt: iso(T0 + 61_000),
    });
    // endsAt was not in the partial, so it is OMITTED (not nulled): the
    // timer's real deadline must survive the completion write.
    expect(vars.endsAt).toBeUndefined();
  });
});

describe('sqlconnectTimerStore reads and rebase', () => {
  it('round-trips timer timestamps as EpochMs', async () => {
    vi.mocked(sdk.getCookingTimer).mockResolvedValue(
      key({ cookingTimer: timerRow() }) as never,
    );
    const t = await sqlconnectTimerStore.getTimer('t1');
    expect(t?.startedAt).toBe(T0);
    expect(t?.endsAt).toBe(T0 + 60_000);
  });

  it('returns null for a missing timer', async () => {
    vi.mocked(sdk.getCookingTimer).mockResolvedValue(key({}) as never);
    expect(await sqlconnectTimerStore.getTimer('t1')).toBeNull();
  });

  it('converts created timer timestamps to ISO on the wire', async () => {
    vi.mocked(sdk.insertCookingTimer).mockResolvedValue(key({}) as never);
    await sqlconnectTimerStore.createTimer({
      id: 't1',
      userId: 'u1',
      sessionId: 's1',
      label: 'Boil',
      durationSeconds: 60,
      startedAt: T0,
      endsAt: T0 + 60_000,
      status: 'RUNNING',
    });
    const vars = vi.mocked(sdk.insertCookingTimer).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(vars.startedAt).toBe(iso(T0));
    expect(vars.endsAt).toBe(iso(T0 + 60_000));
  });

  it('rebases with the elapsed offset (proven on Cloud SQL; native SQL here)', async () => {
    vi.mocked(sdk.rebaseTimers).mockResolvedValue(key({ rebaseTimers: 2 }) as never);
    await sqlconnectTimerStore.rebaseActiveTimers('s1', 5_000);
    expect(vi.mocked(sdk.rebaseTimers).mock.calls[0][0]).toEqual({
      sessionId: 's1',
      offsetMs: 5_000,
    });
  });
});

// ── Recipe store: upsert with immutables ─────────────────────────────────────

describe('sqlconnectRecipeStore — upsert with immutable enforcement', () => {
  it('rejects a generatedAt change on an existing recipe before saving', async () => {
    vi.mocked(sdk.getRecipe).mockResolvedValue(
      key({ recipe: recipeRow() }) as never,
    );
    await expect(
      sqlconnectRecipeStore.updateRecipe(recipeInput({ generatedAt: T0 + 1, updatedAt: T0 + 1 })),
    ).rejects.toThrow('Cannot change immutable field generatedAt');
    expect(sdk.saveRecipe).not.toHaveBeenCalled();
  });

  it('saves through the upsert with ISO timestamps when immutables hold', async () => {
    vi.mocked(sdk.getRecipe).mockResolvedValue(key({ recipe: recipeRow() }) as never);
    vi.mocked(sdk.saveRecipe).mockResolvedValue(key({ recipe_upsert: {} }) as never);
    await sqlconnectRecipeStore.createRecipe(recipeInput({ updatedAt: T0 + 2 }));
    const vars = vi.mocked(sdk.saveRecipe).mock.calls[0][0] as unknown as Record<
  string,
  unknown
>;
    expect(vars.generatedAt).toBe(iso(T0));
    expect(vars.updatedAt).toBe(iso(T0 + 2));
  });

  it('saves a brand new recipe with no pre-read hit', async () => {
    vi.mocked(sdk.getRecipe).mockResolvedValue(key({}) as never);
    vi.mocked(sdk.saveRecipe).mockResolvedValue(key({ recipe_upsert: {} }) as never);
    await sqlconnectRecipeStore.createRecipe(recipeInput({ id: 'r2', title: 'Soup', servings: 4 }));
    expect(sdk.saveRecipe).toHaveBeenCalledTimes(1);
  });

  it('validates before any I/O: a malformed recipe never reaches the SDK', async () => {
    await expect(
      sqlconnectRecipeStore.createRecipe(recipeInput({ servings: 'two' as never })),
    ).rejects.toThrow();
    expect(sdk.getRecipe).not.toHaveBeenCalled();
    expect(sdk.saveRecipe).not.toHaveBeenCalled();
  });
});

// ── Leftover store: the merge path where immutables are the operative guard ──

describe('sqlconnectLeftoverStore — partial update via read, merge, validate, upsert', () => {
  it('rejects an immutable recipeId change on an existing leftover', async () => {
    vi.mocked(sdk.getLeftover).mockResolvedValue(
      key({ leftover: leftoverRow() }) as never,
    );
    await expect(
      sqlconnectLeftoverStore.updateLeftover('l1', { recipeId: 'r-other' }),
    ).rejects.toThrow('Cannot change immutable field recipeId');
    expect(sdk.upsertLeftover).not.toHaveBeenCalled();
  });

  it('throws not-found before any write for a missing leftover', async () => {
    vi.mocked(sdk.getLeftover).mockResolvedValue(key({}) as never);
    await expect(
      sqlconnectLeftoverStore.updateLeftover('l1', { status: 'CONSUMED' }),
    ).rejects.toThrow('leftovers/l1 not found');
    expect(sdk.upsertLeftover).not.toHaveBeenCalled();
  });

  it('merges the partial onto the current row and writes the full row back', async () => {
    vi.mocked(sdk.getLeftover).mockResolvedValue(
      key({ leftover: leftoverRow() }) as never,
    );
    vi.mocked(sdk.upsertLeftover).mockResolvedValue(key({ leftover_upsert: {} }) as never);
    await sqlconnectLeftoverStore.updateLeftover('l1', {
      status: 'CONSUMED',
      notes: 'eaten Tuesday',
    });
    const vars = vi.mocked(sdk.upsertLeftover).mock.calls[0][0] as unknown as Record<
  string,
  unknown
>;
    expect(vars).toMatchObject({
      id: 'l1',
      userId: 'u1',
      title: 'Pasta leftovers',
      status: 'CONSUMED',
      notes: 'eaten Tuesday',
      completedAt: iso(T0),
      storedAt: iso(T0),
    });
  });

  it('validates before any I/O: a malformed partial never reaches the SDK', async () => {
    await expect(
      sqlconnectLeftoverStore.updateLeftover('l1', { servings: 'two' as never }),
    ).rejects.toThrow();
    expect(sdk.getLeftover).not.toHaveBeenCalled();
    expect(sdk.upsertLeftover).not.toHaveBeenCalled();
  });
});
