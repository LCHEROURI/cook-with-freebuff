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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
