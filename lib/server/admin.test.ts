// ============================================================================
// lib/server/admin.test.ts — lock the Firestore settings() idempotency fix.
//
// When lib/server/admin.ts is evaluated more than once (dev HMR, or duplicate
// import specifiers in a server bundle), each copy keeps its own cachedDb but
// getFirestore(app) returns the SAME underlying Firestore instance — a second
// settings() call throws "Firestore has already been initialized" and breaks
// every API route that touches the db. The fix swallows that specific error
// (the flag is already on) and re-throws any other error.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeApp } from 'firebase-admin/app';

// Fake admin credentials so getAdminApp() produces a non-null app.
const FAKE_CREDS = JSON.stringify({
  project_id: 'test-proj',
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
});

let dbSettingsSpy: ReturnType<typeof vi.fn>;
let dbMock: { settings: typeof dbSettingsSpy };

// The spy-based db mock is built in each test, but the firebase-admin/firestore
// mock must resolve getFirestore to the currently-installed db mock.  We hold
// a module-level reference that each test swaps out.
let currentDbMock: typeof dbMock | null = null;

vi.mock('server-only', () => ({}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  cert: vi.fn((creds: unknown) => creds),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => null),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => currentDbMock),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_CREDS;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  // Clean the global state that firebase-admin/app mocks might carry.
  currentDbMock = null;
  dbSettingsSpy = vi.fn();
  dbMock = { settings: dbSettingsSpy };
  currentDbMock = dbMock;
});

it('applies ignoreUndefinedProperties on the first call', async () => {
  // A fresh module copy: cachedDb is null, so the first call reaches
  // settings().  It must apply the option without throwing.
  const { getAdminDb } = await import('./admin');

  const db = getAdminDb();
  expect(db).toBe(dbMock);                         // returns the real instance
  expect(dbSettingsSpy).toHaveBeenCalledOnce();     // settings() called
  expect(dbSettingsSpy).toHaveBeenCalledWith({ ignoreUndefinedProperties: true });
});

it('does not throw when settings() was already applied by a duplicate module copy', async () => {
  // Simulate the duplication: the dbMock's settings() has already been called
  // (by "module copy A").  A second copy (this test's fresh import) calls
  // getAdminDb(), reaches getFirestore() → returns the SAME dbMock, and
  // settings() throws "already been initialized".  The fix must swallow it.
  dbSettingsSpy.mockImplementation(() => {
    throw new Error('Firestore has already been initialized. You can only call settings() once, and only before calling any other methods on a Firestore object.');
  });

  const { getAdminDb } = await import('./admin');

  // Must NOT throw — the idempotency fix catches the duplicate.
  const db = getAdminDb();
  expect(db).toBe(dbMock);
  expect(dbSettingsSpy).toHaveBeenCalledOnce();     // tried once, caught
});

it('initializes with a demo project id (no service account) when FIRESTORE_EMULATOR_HOST is set', async () => {
  // Emulator mode: the Firestore + Auth emulators do not need real
  // credentials, so getAdminApp() must initialize with a demo project id
  // instead of failing the SA parse. This proves the branch (not just the
  // text) so local development can run without FIREBASE_SERVICE_ACCOUNT.
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';

  const { getAdminApp } = await import('./admin');
  const app = getAdminApp();
  expect(app).toEqual({ name: 'test-app' });
  expect(initializeApp).toHaveBeenCalledWith({ projectId: 'demo-cook-with-freebuff' });
});

it('re-throws errors that are NOT the idempotent-duplicate (genuine failure)', async () => {
  // A legitimate settings failure — not the "already been initialized" case —
  // must propagate so a real misconfiguration isn't silently ignored.
  dbSettingsSpy.mockImplementation(() => {
    throw new Error('some other Firestore error');
  });

  const { getAdminDb } = await import('./admin');

  expect(() => getAdminDb()).toThrow('some other Firestore error');
});
