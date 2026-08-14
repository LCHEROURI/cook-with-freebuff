// ============================================================================
// lib/server/app-check.test.ts — lock the App Check rollout semantics.
//
// The gate must be safe by default: monitor mode (APP_CHECK_ENFORCED unset)
// verifies a present token but never blocks, emulator mode always passes, and
// enforced mode rejects a missing/invalid/mismatched token with 403. These
// tests pin each branch so the enforcement flag can be flipped without a
// surprise mid-rollout outage.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyToken = vi.fn();

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
  getFirestore: vi.fn(() => null),
}));

vi.mock('firebase-admin/app-check', () => ({
  getAppCheck: vi.fn(() => ({ verifyToken })),
}));

vi.mock('next/server', () => ({
  NextResponse: { json: vi.fn((body: unknown, init?: { status?: number }) => ({ body, init })) },
}));

const FAKE_CREDS = JSON.stringify({
  project_id: 'test-proj',
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_CREDS;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.APP_CHECK_ENFORCED;
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID = 'test-app-id';
});

describe('verifyAppCheckToken', () => {
  it('always passes in emulator mode, even when enforcement is on', async () => {
    process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    process.env.APP_CHECK_ENFORCED = '1';
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken(null)).resolves.toEqual({ ok: true, reason: 'emulator' });
    await expect(verifyAppCheckToken('anything')).resolves.toEqual({ ok: true, reason: 'emulator' });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('rejects a missing token when enforced', async () => {
    process.env.APP_CHECK_ENFORCED = '1';
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken(null)).resolves.toEqual({ ok: false, reason: 'missing-token' });
  });

  it('passes a missing token in monitor mode (enforcement off)', async () => {
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken(null)).resolves.toEqual({ ok: true });
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('verifies a valid token and reports the app id', async () => {
    process.env.APP_CHECK_ENFORCED = '1';
    verifyToken.mockResolvedValue({ appId: 'test-app-id' });
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken('good-token')).resolves.toEqual({ ok: true, reason: 'verified' });
    expect(verifyToken).toHaveBeenCalledWith('good-token');
  });

  it('rejects a token minted for a different app', async () => {
    process.env.APP_CHECK_ENFORCED = '1';
    verifyToken.mockResolvedValue({ appId: 'other-app-id' });
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken('good-token')).resolves.toEqual({ ok: false, reason: 'app-mismatch' });
  });

  it('rejects an invalid token when enforced', async () => {
    process.env.APP_CHECK_ENFORCED = '1';
    verifyToken.mockRejectedValue(new Error('app-check/argument-error'));
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken('bad-token')).resolves.toEqual({ ok: false, reason: 'invalid-token' });
  });

  it('passes an invalid token in monitor mode (logs, never blocks)', async () => {
    verifyToken.mockRejectedValue(new Error('app-check/argument-error'));
    const { verifyAppCheckToken } = await import('./app-check');

    await expect(verifyAppCheckToken('bad-token')).resolves.toEqual({ ok: true });
  });
});

describe('appCheckEnforced', () => {
  it('reads the enforcement flag', async () => {
    const { appCheckEnforced } = await import('./app-check');

    delete process.env.APP_CHECK_ENFORCED;
    expect(appCheckEnforced()).toBe(false);

    process.env.APP_CHECK_ENFORCED = '1';
    expect(appCheckEnforced()).toBe(true);

    process.env.APP_CHECK_ENFORCED = 'true';
    expect(appCheckEnforced()).toBe(true);
  });
});

describe('gateAppCheck', () => {
  it('returns null when the request passes', async () => {
    const { gateAppCheck } = await import('./app-check');
    const req = new Request('http://test/api/cook', { method: 'POST' });

    await expect(gateAppCheck(req)).resolves.toBeNull();
  });

  it('returns a 403 with APP_CHECK_FAILED when blocked', async () => {
    process.env.APP_CHECK_ENFORCED = '1';
    const { gateAppCheck } = await import('./app-check');
    const req = new Request('http://test/api/cook', { method: 'POST' });

    const res = await gateAppCheck(req);
    expect(res).not.toBeNull();
    const body = (res as unknown as { body: { error: { code: string } } }).body;
    expect(body.error.code).toBe('APP_CHECK_FAILED');
  });
});
