// ─────────────────────────────────────────────────────────────────────────────
// Anonymous-auth session logic (client-only, pure and unit-testable).
//
// The Cook With Me screens are voice-first / screen-light: there is no login
// UI. The browser establishes an ANONYMOUS Firebase session so /api/cook,
// /api/agent and /api/tools receive a real Bearer ID token. Anonymous is the
// correct identity model here because each visitor gets their OWN uid —
// Firestore rules are uid-scoped, so no visitor can ever touch another
// user's (or the owner's) data. A custom-token auto-auth route would hand
// every visitor the OWNER uid and expose the shared project — never do that.
//
// This module holds the pure parts (error mapping + the sign-in attempt) so
// they can be unit-tested without React; useAuthSession.ts is the thin hook.
// ─────────────────────────────────────────────────────────────────────────────

import { signInAnonymously, type Auth, type User } from 'firebase/auth';

export const AUTH_CONFIG_MISSING =
  'Firebase client configuration is missing (NEXT_PUBLIC_FIREBASE_* env).';
export const ANON_DISABLED =
  'Anonymous sign-in is not enabled in this Firebase project — enable Authentication → Sign-in method → Anonymous, then reload.';
export const SIGN_IN_FAILED = 'Could not sign in to the cooking session.';

/** Map a Firebase auth error code (or our synthetic codes) to honest copy. */
export function authErrorMessage(code?: string): string {
  switch (code) {
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation':
      return ANON_DISABLED;
    case 'config-missing':
      return AUTH_CONFIG_MISSING;
    default:
      return SIGN_IN_FAILED;
  }
}

export type AnonResult = { ok: true; user: User } | { ok: false; error: string };

/**
 * Attempt the anonymous sign-in. Never throws: a disabled provider, network
 * failure, or config problem is returned as { ok: false, error } with the
 * human-readable reason so the UI can surface it (the hook sets state, pages
 * render the message, and a Retry re-runs the whole effect).
 */
export async function ensureAnonSession(auth: Auth): Promise<AnonResult> {
  try {
    const cred = await signInAnonymously(auth);
    return { ok: true, user: cred.user };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return { ok: false, error: authErrorMessage(code) };
  }
}
