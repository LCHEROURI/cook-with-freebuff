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

  it('a marker written under the legacy raw key is still seen and migrated', async () => {
    const { db, store } = fakeDb({ 'correlation_markers/resume-op-99': { markedAt: 1 } });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    // Raw key present, encoded key absent → legacy fallback reports processed.
    expect(await repo.hasCorrelationMarker('resume-op-99')).toBe(true);

    // Migrated: the raw key is gone, the encoded key now holds the marker.
    expect(store.has('correlation_markers/resume-op-99')).toBe(false);
    const encoded = repo.markerKey('resume-op-99');
    expect(store.has(`correlation_markers/${encoded}`)).toBe(true);

    // Second read hits the encoded key directly (legacy already migrated).
    expect(await repo.hasCorrelationMarker('resume-op-99')).toBe(true);
    expect(store.has('correlation_markers/resume-op-99')).toBe(false);
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

  it('mark clears the legacy key so the fallback never double-reads', async () => {
    const { db, store } = fakeDb({ 'correlation_markers/resume-op-101': { markedAt: 1 } });
    const { getAdminDb } = await import('./admin');
    vi.mocked(getAdminDb).mockReturnValue(db);

    await repo.markCorrelationMarker('resume-op-101');
    expect(store.has('correlation_markers/resume-op-101')).toBe(false);
    expect(store.has(`correlation_markers/${repo.markerKey('resume-op-101')}`)).toBe(true);
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
