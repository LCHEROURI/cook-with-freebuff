// ─────────────────────────────────────────────────────────────────────────────
// Auth-session logic (client-only, pure and unit-testable).
//
// Cook With Me now has a real login page: the browser signs in with Google
// (the owner's provider in the shared Firebase project) and the API routes
// (/api/cook, /api/agent, /api/tools) receive a real Bearer ID token.
//
// This module holds the pure parts — the error-code → honest-copy mapping and
// the sign-in / sign-out wrappers — so they can be unit-tested without React.
// useAuthSession.ts is the thin hook that drives them.
// ─────────────────────────────────────────────────────────────────────────────

import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth';

export const AUTH_CONFIG_MISSING =
  'Firebase client configuration is missing (NEXT_PUBLIC_FIREBASE_* env).';
export const SIGN_IN_CANCELLED = 'Sign-in was cancelled.';
export const SIGN_IN_BLOCKED =
  'Sign-in is blocked — this site is not in the project\u2019s authorized domains. Add it in Firebase → Authentication → Settings → Authorized domains.';
export const SIGN_IN_STILL_BLOCKED =
  'Still blocked after a refresh — this site is not in the project\u2019s authorized domains. Add it in Firebase → Authentication → Settings → Authorized domains, then reload the page.';
export const PROVIDER_DISABLED =
  'Google sign-in is not enabled in this Firebase project — enable Authentication → Sign-in method → Google, then reload.';
export const SIGN_IN_FAILED = 'Could not sign in. Please try again.';
export const SIGN_IN_RETRY_HINT =
  'Refreshed your sign-in session — tap Continue with Google to retry.';

/**
 * An Error that keeps the Firebase auth error code alongside the mapped
 * message, so callers can branch on the specific failure (the login page's
 * unauthorized-domain retry does) instead of string-matching the copy.
 */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Map a Firebase auth error code (or our synthetic codes) to honest copy. */
export function authErrorMessage(code?: string): string {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/popup-blocked':
      return SIGN_IN_CANCELLED;
    case 'auth/unauthorized-domain':
      return SIGN_IN_BLOCKED;
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation':
      return PROVIDER_DISABLED;
    case 'config-missing':
      return AUTH_CONFIG_MISSING;
    default:
      return SIGN_IN_FAILED;
  }
}

/** Sign in with a Google popup. Throws an Error with the mapped message. */
export async function signInWithGoogle(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    throw new SignInError(authErrorMessage(code), code);
  }
}

/** Sign out. Never throws — best effort. */
export async function signOutFirebase(auth: Auth): Promise<void> {
  try {
    await firebaseSignOut(auth);
  } catch {
    // Sign-out failure is not actionable; the next page load re-checks state.
  }
}
