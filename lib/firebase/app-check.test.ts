// ============================================================================
// lib/firebase/app-check.test.ts — lock the client App Check helpers.
//
// The helpers must no-op cleanly when App Check isn't provisioned (site key
// missing), so enabling App Check can never break an existing deploy
// mid-rollout — and attach the token header once it is.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));

const FAKE_APP_CHECK = { name: 'fake-app-check' };

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(() => FAKE_APP_CHECK),
  ReCaptchaV3Provider: vi.fn(),
  getToken,
}));

vi.mock('./client', () => ({
  getFirebaseApp: vi.fn(() => ({ name: 'test-app' })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY;
  delete process.env.NEXT_PUBLIC_APP_CHECK_DEBUG;
});

describe('getClientAppCheck', () => {
  it('returns null when the site key is not configured', async () => {
    const { getClientAppCheck } = await import('./app-check');
    expect(getClientAppCheck()).toBeNull();
  });

  it('returns null when initialization fails', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = 'site-key';
    const { initializeAppCheck } = await import('firebase/app-check');
    (initializeAppCheck as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    const { getClientAppCheck } = await import('./app-check');
    expect(getClientAppCheck()).toBeNull();
  });

  it('initializes App Check with the reCAPTCHA v3 provider', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = 'site-key';
    const appCheckSdk = await import('firebase/app-check');
    const { getClientAppCheck } = await import('./app-check');

    expect(getClientAppCheck()).toBe(FAKE_APP_CHECK);
    expect(appCheckSdk.initializeAppCheck).toHaveBeenCalledWith(
      { name: 'test-app' },
      expect.objectContaining({ isTokenAutoRefreshEnabled: true }),
    );
    expect(appCheckSdk.ReCaptchaV3Provider).toHaveBeenCalledWith('site-key');
  });
});

describe('getAppCheckToken / appCheckHeaders', () => {
  it('returns null / {} when App Check is not configured', async () => {
    const { getAppCheckToken, appCheckHeaders } = await import('./app-check');
    await expect(getAppCheckToken()).resolves.toBeNull();
    await expect(appCheckHeaders()).resolves.toEqual({});
  });

  it('returns the token and the header when configured', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = 'site-key';
    getToken.mockResolvedValue({ token: 'ac-token' });
    const { getAppCheckToken, appCheckHeaders } = await import('./app-check');

    await expect(getAppCheckToken()).resolves.toBe('ac-token');
    await expect(appCheckHeaders()).resolves.toEqual({ 'x-firebase-appcheck': 'ac-token' });
  });

  it('returns null when the token fetch fails (graceful degradation)', async () => {
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = 'site-key';
    getToken.mockRejectedValue(new Error('app-check/fetch-status-error'));
    const { getAppCheckToken, appCheckHeaders } = await import('./app-check');

    await expect(getAppCheckToken()).resolves.toBeNull();
    await expect(appCheckHeaders()).resolves.toEqual({});
  });
});
