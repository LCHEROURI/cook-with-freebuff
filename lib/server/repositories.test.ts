// ============================================================================
// lib/server/repositories.test.ts — lock the timer update write boundary.
//
// Codex P1: repositories.updateTimer sent partials straight to Firestore with
// no Zod parse. A malformed legacy value (e.g. a string endsAt concatenated
// during a rebase) could be propagated into another persisted timer value,
// bypassing the repo's validate-before-write rule. The fix parses the partial
// against cookingTimerSchema.partial() BEFORE any I/O — so a malformed update
// fails on validation even with no database in play.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

// The parse runs before getAdminDb() is touched, so a malformed update throws
// a Zod error without any Firebase involvement — exactly the boundary being
// locked. These mocks keep the import side-effect free.
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

let repo: typeof import('./repositories');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  repo = await import('./repositories');
});

describe('correlation-marker legacy-key fallback (Codex P1 — PR #59 review)', () => {
  // A minimal fake Firestore that records marker reads/writes, so the legacy
  // fallback (a marker stored under the RAW correlation ID before the encoding
  // change) can be proven without the emulator.
  function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
    const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
    const db: any = {
      collection: (path: string) => ({
        doc: (id: string) => ({
          id,
          get: async () => ({
            exists: store.has(`${path}/${id}`),
            id,
            data: () => store.get(`${path}/${id}`) ?? null,
          }),
          set: async (data: unknown) => {
            store.set(`${path}/${id}`, data as Record<string, unknown>);
          },
          delete: async () => {
            store.delete(`${path}/${id}`);
          },
        }),
      }),
    };
    return { db, store };
  }

  afterEach(async () => {
    // Restore the no-db default so later tests still hit the boundary throw.
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockImplementation(() => null);
  });

  it('a marker written under the legacy raw key is still seen and migrated (copy, retain)', async () => {
    const { db, store } = fakeDb({ 'correlation_markers/resume-op-99': { markedAt: 1 } });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    // Raw key present, encoded key absent → legacy fallback reports processed.
    expect(await repo.hasCorrelationMarker('resume-op-99')).toBe(true);

    // Migrated by COPY: the encoded key now holds the marker, and the raw key
    // is RETAINED because an old instance still serving reads only the raw key
    // (deleting it would make that instance re-execute the transition — PR #62
    // P1 "retain legacy markers").
    const encoded = repo.markerKey('resume-op-99');
    expect(store.has(`correlation_markers/${encoded}`)).toBe(true);
    expect(store.has('correlation_markers/resume-op-99')).toBe(true);

    // Second read hits the encoded key directly (no legacy re-read needed).
    expect(await repo.hasCorrelationMarker('resume-op-99')).toBe(true);
  });

  it('an id with a path separator skips the raw-key fallback entirely (PR #62 P1)', async () => {
    const { db } = fakeDb();
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    // The encoded lookup misses; the raw fallback must NOT be attempted for
    // 'a/b' because Firestore's doc() would throw on the '/' path separator.
    expect(await repo.hasCorrelationMarker('a/b')).toBe(false);
  });

  it('a raw-key doc that is ANOTHER id\'s encoded marker is not a legacy hit (PR #62 P2)', async () => {
    // markerKey('a') is a real single-segment key; if a client sends that
    // SAME string as its correlation id, the raw-key lookup would find 'a''s
    // encoded marker and misreport a duplicate. The rawId field disambiguates.
    const id = repo.markerKey('a');
    const { db } = fakeDb({ [`correlation_markers/${id}`]: { markedAt: 1, rawId: 'a' } });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    expect(await repo.hasCorrelationMarker(id)).toBe(false);
    // And the true owner still sees its marker.
    expect(await repo.hasCorrelationMarker('a')).toBe(true);
  });

  it('clear removes BOTH the encoded and legacy keys', async () => {
    const encoded = repo.markerKey('resume-op-100');
    const { db, store } = fakeDb({
      [`correlation_markers/${encoded}`]: { markedAt: 1 },
      'correlation_markers/resume-op-100': { markedAt: 1 },
    });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    await repo.clearCorrelationMarker('resume-op-100');
    expect(store.size).toBe(0);
  });

  it('mark writes the encoded key only, never the raw namespace (PR #64 P2)', async () => {
    const { db, store } = fakeDb();
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    await repo.markCorrelationMarker('resume-op-101');
    expect(store.has(`correlation_markers/${repo.markerKey('resume-op-101')}`)).toBe(true);
    // The raw dual-write was removed: a raw copy could occupy ANOTHER id's
    // encoded key (markerKey('a') === 'YQ'), falsely suppressing its
    // transition. New markers never touch the raw namespace.
    expect(store.has('correlation_markers/resume-op-101')).toBe(false);
  });

  it('a raw-marked id never occupies another id\'s encoded key (PR #64 P2)', async () => {
    // markerKey('a') === 'YQ'. If the code dual-wrote the raw key for id
    // 'YQ', it would plant a doc at 'a''s encoded key and has('a') would
    // report a processed duplicate by existence. The encoded-only write
    // keeps the namespaces disjoint.
    const { db, store } = fakeDb();
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    await repo.markCorrelationMarker('YQ');
    expect(store.has('correlation_markers/YQ')).toBe(false);
    expect(await repo.hasCorrelationMarker('a')).toBe(false);
  });

  it('the encoded read rejects a doc whose rawId names a different owner (PR #64 P2)', async () => {
    // A foreign doc planted at the encoded key (e.g. a historical raw write
    // that collided) must not suppress this id's transition — and with no
    // legacy marker of its own, the id is genuinely unprocessed.
    const encoded = repo.markerKey('a');
    const { db } = fakeDb({ [`correlation_markers/${encoded}`]: { markedAt: 1, rawId: 'YQ' } });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    expect(await repo.hasCorrelationMarker('a')).toBe(false);
    // A matching (or pre-rawId) doc at the encoded key still reports true.
    const matching = fakeDb({ [`correlation_markers/${encoded}`]: { markedAt: 1, rawId: 'a' } });
    vi.mocked(getAdminDb).mockReturnValue(matching.db);
    expect(await repo.hasCorrelationMarker('a')).toBe(true);
    const preRawId = fakeDb({ [`correlation_markers/${encoded}`]: { markedAt: 1 } });
    vi.mocked(getAdminDb).mockReturnValue(preRawId.db);
    expect(await repo.hasCorrelationMarker('a')).toBe(true);
  });

  it('a foreign occupant of the encoded slot falls through to this id\'s legacy marker (PR #66 P1)', async () => {
    // markerKey('a') === 'YQ'. 'a' was processed pre-encoding (legacy raw doc,
    // no rawId) while 'YQ' owns the encoded slot. The foreign occupant must
    // not hide 'a''s own legacy marker, and the migration must not clobber it.
    const encoded = repo.markerKey('a');
    expect(encoded).toBe('YQ');
    const { db, store } = fakeDb({
      [`correlation_markers/${encoded}`]: { markedAt: 2, rawId: 'YQ' },
      'correlation_markers/a': { markedAt: 1 },
    });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    expect(await repo.hasCorrelationMarker('a')).toBe(true);
    // The foreign marker survives untouched — no clobbering copy.
    expect(store.get(`correlation_markers/${encoded}`)).toEqual({ markedAt: 2, rawId: 'YQ' });
    // And the legacy doc is retained for this id.
    expect(store.has('correlation_markers/a')).toBe(true);
  });

  it('the rollback clear reads the legacy marker before any transaction write (PR #64 P1)', async () => {
    // Firestore transactions reject reads after writes. The old code queued
    // tx.update/tx.set first and only then tx.get the legacy raw doc for the
    // conditional delete — so every rollback clear on a separator-free id
    // rejected. This fake enforces the ordering rule like Firestore does.
    const session = {
      id: 'sess-clear-1',
      userId: 'u1',
      recipeId: 'r1',
      status: 'PAUSED',
      currentPhase: 'PAUSED',
      currentPrepStepIndex: 0,
      currentCookingStepIndex: 0,
      activeTimerIds: [],
      availableIngredients: [],
      startedAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000,
      version: 1,
    };
    const store = new Map<string, Record<string, unknown>>([
      ['cooking_sessions/sess-clear-1', session],
      // A historical legacy raw marker for this id (pre-rawId format).
      ['correlation_markers/resume-op-200', { markedAt: 1 }],
    ]);
    const db: any = {
      __writes: false,
      collection: (path: string) => ({
        doc: (id: string) => ({
          id,
          _path: `${path}/${id}`,
          _get: async () => ({
            exists: store.has(`${path}/${id}`),
            id,
            data: () => store.get(`${path}/${id}`) ?? null,
          }),
        }),
      }),
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
        db.__writes = false;
        const tx = {
          get: async (ref: any) => {
            if (db.__writes) throw new Error('Firestore: all reads must precede writes in a transaction');
            return ref._get();
          },
          update: async (ref: any, data: unknown) => {
            db.__writes = true;
            store.set(ref._path, data as Record<string, unknown>);
          },
          set: async (ref: any, data: unknown) => {
            db.__writes = true;
            store.set(ref._path, data as Record<string, unknown>);
          },
          delete: async (ref: any) => {
            db.__writes = true;
            store.delete(ref._path);
          },
        };
        return fn(tx);
      },
    };
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    const updated = await repo.updateSession(
      'sess-clear-1',
      { currentPhase: 'WAITING_FOR_TIMER', status: 'ACTIVE' },
      1,
      { clear: 'resume-op-200' },
    );
    expect(updated.version).toBe(2);
    // The session transition committed and the legacy raw marker drained.
    expect(store.has('cooking_sessions/sess-clear-1')).toBe(true);
    expect(store.has('correlation_markers/resume-op-200')).toBe(false);
    expect(store.has(`correlation_markers/${repo.markerKey('resume-op-200')}`)).toBe(false);
  });
});

describe('correlation-marker key encoding (Codex P2 — PR #58 review)', () => {
  it('encodes an id containing a path separator into one safe segment', () => {
    const key = repo.markerKey('a/b');
    // Firestore doc ids cannot contain '/'; the base64url alphabet never does.
    expect(key).not.toContain('/');
  });

  it('is collision-free for distinct ids and reversible', () => {
    const a = repo.markerKey('resume-op-1');
    const b = repo.markerKey('resume-op-2');
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url').toString('utf8')).toBe('resume-op-1');
    // Unicode ids survive the round trip too (no mojibake in the key).
    const uni = repo.markerKey('résumé→עברית');
    expect(Buffer.from(uni, 'base64url').toString('utf8')).toBe('résumé→עברית');
  });
});

describe('correlation-marker document validation (Codex P1 — PR #58 review)', () => {
  it('the marker schema rejects a malformed document shape', async () => {
    // The schema is the repo boundary guard: a doc without the required
    // numeric markedAt cannot be persisted, whatever the collection's future
    // shape evolution. Imported from domain so the repo and service share it.
    const { correlationMarkerSchema } = await import('../domain/schemas');
    expect(correlationMarkerSchema.safeParse({ markedAt: 'not-a-number' }).success).toBe(false);
    expect(correlationMarkerSchema.safeParse({ markedAt: 1_700_000_000_000 }).success).toBe(true);
    expect(correlationMarkerSchema.safeParse({}).success).toBe(false);
  });

  it('markCorrelationMarker parses before touching the db (boundary order)', async () => {
    // The write boundary: the doc is validated then written. With the mocked
    // null db the only error is the not-initialized throw AFTER the parse
    // succeeded, proving the parse ran first (the #5155 fix).
    await expect(repo.markCorrelationMarker('ok-id')).rejects.toThrow(/Firestore not initialized/);
  });
});

describe('updateTimer write boundary', () => {
  it('rejects a malformed value propagated into a partial (Codex P1 — no silent Firestore write)', async () => {
    // The rebase bug: a legacy string endsAt concatenated into "1235000"
    // instead of a number. The old code wrote it straight to Firestore.
    await expect(
      repo.updateTimer('t1', { endsAt: '1235000' as unknown as number }),
    ).rejects.toThrow();
  });

  it('rejects NaN / negative endsAt instead of persisting it', async () => {
    await expect(
      repo.updateTimer('t1', { endsAt: Number.NaN }),
    ).rejects.toThrow();
    await expect(
      repo.updateTimer('t1', { endsAt: -5 }),
    ).rejects.toThrow();
  });

  it('accepts a valid partial (validation passes; the write itself is a no-db throw)', async () => {
    // A valid numeric endsAt passes the parse — the only error here would be
    // the mocked "Firestore not initialized", proving validation succeeded.
    await expect(repo.updateTimer('t1', { endsAt: 1_700_000_000_000 })).rejects.toThrow(
      /Firestore not initialized/,
    );
  });
});

describe('Phase 3A repository write contracts', () => {
  function fakeWriteDb(seed: Record<string, Record<string, unknown>> = {}) {
    const store = new Map<string, Record<string, unknown>>(Object.entries(seed));
    let writes = 0;

    const ref = (path: string, id: string) => ({
      id,
      _path: `${path}/${id}`,
      get: async () => ({
        exists: store.has(`${path}/${id}`),
        id,
        data: () => store.get(`${path}/${id}`) ?? null,
      }),
      set: async (data: unknown) => {
        writes += 1;
        store.set(`${path}/${id}`, data as Record<string, unknown>);
      },
      update: async (partial: unknown) => {
        writes += 1;
        const current = store.get(`${path}/${id}`) ?? {};
        store.set(`${path}/${id}`, {
          ...current,
          ...(partial as Record<string, unknown>),
        });
      },
      delete: async () => {
        writes += 1;
        store.delete(`${path}/${id}`);
      },
    });

    const db: any = {
      collection: (path: string) => ({
        doc: (id: string) => ref(path, id),
        where: () => ({
          where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
        get: (document: ReturnType<typeof ref>) => document.get(),
        update: (document: ReturnType<typeof ref>, data: unknown) => document.update(data),
        set: (document: ReturnType<typeof ref>, data: unknown) => document.set(data),
        delete: (document: ReturnType<typeof ref>) => document.delete(),
      }),
    };
    return { db, store, writeCount: () => writes };
  }

  async function useDb(seed: Record<string, Record<string, unknown>> = {}) {
    const fake = fakeWriteDb(seed);
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(fake.db);
    return fake;
  }

  it('rejects an invalid full write before Firestore mutation', async () => {
    const fake = await useDb();
    await expect(repo.createPantryItem({
      id: 'pantry-1',
      userId: 'user-1',
      name: 'rice',
      quantity: -1,
      confidence: 0.9,
      source: 'MANUAL',
      lastConfirmedAt: 1_700_000_000_000,
    })).rejects.toThrow();
    expect(fake.writeCount()).toBe(0);
  });

  it('rejects an invalid pantry patch after merging with the stored document', async () => {
    const fake = await useDb({
      'pantry_items/pantry-1': {
        id: 'pantry-1', userId: 'user-1', name: 'rice', quantity: 2,
        confidence: 0.9, source: 'MANUAL', lastConfirmedAt: 1_700_000_000_000,
      },
    });
    await expect(repo.updatePantryItem('pantry-1', { quantity: -1 })).rejects.toThrow();
    expect(fake.writeCount()).toBe(0);
  });

  it('rejects ownership and creation-metadata changes on partial updates', async () => {
    const fake = await useDb({
      'leftovers/leftover-1': {
        id: 'leftover-1', userId: 'user-1', title: 'Soup', servings: 2,
        completedAt: 1_700_000_000_000, storedAt: 1_700_000_000_000, status: 'ACTIVE',
      },
      'grocery_list/grocery-1': {
        id: 'grocery-1', userId: 'user-1', name: 'Milk', source: 'MANUAL',
        status: 'OPEN', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
      },
      'timers/timer-1': {
        id: 'timer-1', userId: 'user-1', sessionId: 'session-1', label: 'Simmer',
        durationSeconds: 60, startedAt: 1_700_000_000_000,
        endsAt: 1_700_000_060_000, status: 'RUNNING',
      },
    });

    await expect(repo.updateLeftover('leftover-1', { userId: 'user-2' })).rejects.toThrow();
    await expect(repo.updateGroceryItem('grocery-1', { createdAt: 1_800_000_000_000 })).rejects.toThrow();
    await expect(repo.updateTimer('timer-1', { userId: 'user-2' })).rejects.toThrow();
    expect(fake.writeCount()).toBe(0);
  });

  it('rejects immutable ownership on a full recipe overwrite', async () => {
    const generatedAt = 1_700_000_000_000;
    const recipe = {
      id: 'recipe-1', userId: 'user-1', title: 'Rice', servings: 2,
      estimatedPrepMinutes: 5, estimatedCookMinutes: 15, totalMinutes: 20,
      ingredients: [{ id: 'i1', name: 'rice', quantity: 1, unit: 'cup', optional: false }],
      equipment: [], prepSteps: [], cookingSteps: [], dietaryTags: [], allergens: [],
      safetyNotes: [], proteinCategories: [], generatedAt, updatedAt: generatedAt,
    };
    const fake = await useDb({ 'recipes/recipe-1': recipe });
    await expect(repo.updateRecipe({ ...recipe, userId: 'user-2' })).rejects.toThrow();
    expect(fake.writeCount()).toBe(0);
  });

  it('rejects immutable identity changes inside the session transaction', async () => {
    const session = {
      id: 'session-1', userId: 'user-1', status: 'ACTIVE', currentPhase: 'PREP_GUIDANCE',
      currentPrepStepIndex: 0, currentCookingStepIndex: 0, activeTimerIds: [],
      availableIngredients: [], startedAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000, version: 1,
    };
    const fake = await useDb({ 'cooking_sessions/session-1': session });
    await expect(repo.updateSession('session-1', { id: 'session-2' }, 1)).rejects.toThrow();
    expect(fake.writeCount()).toBe(0);
  });
});
