// ─────────────────────────────────────────────────────────────────────────────
// Firebase App Check (client) — browser-safe init + token helpers.
//
// App Check proves this is the real app (not a bot replaying requests) to the
// backend, which verifies the token before doing Gemini-quota work. Only
// NEXT_PUBLIC_* values live here — never server-only secrets.
//
// The reCAPTCHA v3 site key is the one knob; when it's absent (not provisioned
// yet) every helper no-ops and the app behaves exactly as before, so enabling
// App Check can't break an existing deploy mid-rollout.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeAppCheck, ReCaptchaV3Provider, getToken, type AppCheck } from 'firebase/app-check';
import { getFirebaseApp } from './client';

let initialized = false;
let cachedAppCheck: AppCheck | null = null;

/**
 * Lazily initialize App Check with reCAPTCHA v3. Returns null (and caches that
 * answer) when the site key is missing or initialization fails, so a
 * misconfigured key degrades to "no App Check" instead of throwing at runtime.
 */
export function getClientAppCheck(): AppCheck | null {
  if (initialized) return cachedAppCheck;
  initialized = true;

  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY;
  if (!siteKey) return null;

  const app = getFirebaseApp();
  if (!app) return null;

  try {
    // Local dev / CI: the debug provider skips reCAPTCHA and prints a token to
    // the console that is registered in the Firebase console once.
    if (process.env.NEXT_PUBLIC_APP_CHECK_DEBUG === '1') {
      (globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    cachedAppCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    return cachedAppCheck;
  } catch {
    return null;
  }
}

/**
 * The current App Check token, or null when App Check isn't available.
 * Pass forceRefresh for the single-use (consumed) one-shot routes, where a
 * cached token would already be marked consumed on the server.
 */
export async function getAppCheckToken(forceRefresh = false): Promise<string | null> {
  const appCheck = getClientAppCheck();
  if (!appCheck) return null;
  try {
    const { token } = await getToken(appCheck, forceRefresh);
    return token;
  } catch {
    return null;
  }
}

/** Headers to attach to API requests: { 'x-firebase-appcheck': token } or {}. */
export async function appCheckHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const token = await getAppCheckToken(forceRefresh);
  return token ? { 'x-firebase-appcheck': token } : {};
}
