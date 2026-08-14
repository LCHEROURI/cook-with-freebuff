// ─────────────────────────────────────────────────────────────────────────────
// App Check (server) — verify client attestation before quota-bearing work.
//
// The browser proves it is the real app via a Firebase App Check token, sent
// in the X-Firebase-AppCheck header. This module verifies that token with the
// Admin SDK before a Gemini-quota route (/api/cook, /api/voice/token, …) does
// any model work, so a stolen API key or a bot replaying requests cannot burn
// the Gemini quota.
//
// Rollout model (safe by default):
//   - Emulators (FIRESTORE_EMULATOR_HOST set): App Check cannot attest, so
//     the gate always passes — local dev is unaffected.
//   - APP_CHECK_ENFORCED unset ("monitor" mode): a present token is verified
//     and a bad one is logged, but nothing is blocked. This is the default so
//     turning App Check on can't break an existing deploy mid-rollout.
//   - APP_CHECK_ENFORCED=1 ("enforced" mode): a missing or invalid token is
//     rejected with 403. Flip this on only after the client is sending tokens.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

import { NextResponse } from 'next/server';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAdminApp } from './admin';
import { logWarn } from './logger';

export type AppCheckVerdict =
  | { ok: true; reason?: 'emulator' | 'verified' }
  | { ok: false; reason: 'missing-token' | 'invalid-token' | 'app-mismatch' | 'unconfigured' };

/** Whether App Check is enforced (403 on a missing/invalid token). */
export function appCheckEnforced(): boolean {
  const value = process.env.APP_CHECK_ENFORCED;
  return value === '1' || value === 'true';
}

function isEmulator(): boolean {
  return !!process.env.FIRESTORE_EMULATOR_HOST;
}

/**
 * Verify a client App Check token.
 *
 * Never throws — a verification failure is a verdict, not an exception, so a
 * misconfigured App Check can't crash the route it guards.
 */
export async function verifyAppCheckToken(token: string | null): Promise<AppCheckVerdict> {
  if (isEmulator()) return { ok: true, reason: 'emulator' };

  const enforced = appCheckEnforced();
  if (!token) {
    return enforced ? { ok: false, reason: 'missing-token' } : { ok: true };
  }

  const app = getAdminApp();
  if (!app) {
    return enforced ? { ok: false, reason: 'unconfigured' } : { ok: true };
  }

  try {
    const { appId } = await getAppCheck(app).verifyToken(token);
    const expected = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
    if (expected && appId !== expected) {
      logWarn('app-check.app-mismatch', { appId, expected });
      return { ok: false, reason: 'app-mismatch' };
    }
    return { ok: true, reason: 'verified' };
  } catch (e) {
    logWarn('app-check.verify-failed', {
      message: e instanceof Error ? e.message.slice(0, 200) : String(e),
      enforced,
    });
    // Monitor mode: log the failure but don't block an unprovisioned rollout.
    return enforced ? { ok: false, reason: 'invalid-token' } : { ok: true };
  }
}

/**
 * Route gate. Returns a 403 NextResponse when App Check blocks the request,
 * or null when the request may proceed. Call early in every quota-bearing
 * route, before any model work.
 */
export async function gateAppCheck(req: Request): Promise<NextResponse | null> {
  const token = req.headers.get('x-firebase-appcheck');
  const verdict = await verifyAppCheckToken(token);
  if (verdict.ok) return null;

  const message =
    verdict.reason === 'missing-token'
      ? 'App Check token missing'
      : verdict.reason === 'app-mismatch'
        ? 'App Check token is for a different app'
        : 'App Check attestation failed';

  return NextResponse.json(
    { success: false, error: { code: 'APP_CHECK_FAILED', message, recoverable: false } },
    { status: 403 },
  );
}
