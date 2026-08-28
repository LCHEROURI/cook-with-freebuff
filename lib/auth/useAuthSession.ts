'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useAuthSession — the auth state for the Cook With Me screens.
//
//   state 'loading' → Firebase auth state still resolving (pages show a
//                     loading gate so they never flash unauthenticated UI)
//   state 'ready'   → resolved: `user` is either the signed-in user or null
//                     (pages decide: /cook redirects to /login when null)
//   state 'error'   → auth could not initialize (e.g. missing
//                     NEXT_PUBLIC_FIREBASE_* env) — `error` carries the reason
//
// signIn() → Google popup (see session.ts); throws the mapped message so the
// login page can display it inline. signOut() → Firebase sign-out.
// getToken() → the current ID token for the API Bearer header, null when
// signed out — /api/cook etc. 401 until a real session exists.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { getIdToken, onAuthStateChanged, type Auth, type User } from 'firebase/auth';
import { getClientAuth } from '@/lib/firebase/client';
import {
  authErrorMessage,
  SignInError,
  SIGN_IN_RETRY_HINT,
  SIGN_IN_STILL_BLOCKED,
  signInWithGoogle,
  signOutFirebase,
} from './session';

// One-reload-per-tab-session marker for the unauthorized-domain retry. It is
// deliberately NOT cleared until a real sign-in succeeds, so a domain that is
// still genuinely unauthorized shows the error after one reload instead of
// reload-looping forever.
const UNAUTHORIZED_DOMAIN_RELOADED = 'cook-freebuff:auth:unauthorized-domain-reloaded';

function hasReloadedForUnauthorizedDomain(): boolean {
  try {
    return typeof window !== 'undefined' && window.sessionStorage?.getItem(UNAUTHORIZED_DOMAIN_RELOADED) === '1';
  } catch {
    return false;
  }
}

function markReloadedForUnauthorizedDomain(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    window.sessionStorage?.setItem(UNAUTHORIZED_DOMAIN_RELOADED, '1');
    return true;
  } catch {
    // Storage unavailable (private mode / quota / blocked): we can't persist
    // the one-shot marker, so a reload would loop forever (the marker would
    // still read unset after navigation). Report the marker write failed so
    // the caller surfaces the blocked-domain error instead of reloading.
    return false;
  }
}

// URL flag the freshly loaded login page reads to auto-reopen the Google
// popup. The navigation is user-initiated (it happens inside the click
// handler), so the gesture carries over and the popup needs no second tap.
const RETRY_PARAM = 'retry';
const AUTH_SETTLE_TIMEOUT_MS = 10000;

/**
 * Navigate to /login?retry=1 (the page that consumes the flag) and return
 * whether it worked. Always targets the login route, never the current path:
 * this hook also drives sign-in from /status, and only /login auto-reopens the
 * popup on the flag — a /status?retry=1 navigation would silently stall.
 */
function navigateToRetry(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const url = new URL('/login', window.location.origin);
    url.searchParams.set(RETRY_PARAM, '1');
    window.location.replace(url.toString());
    return true;
  } catch {
    return false;
  }
}

function clearUnauthorizedDomainMarker(): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage?.removeItem(UNAUTHORIZED_DOMAIN_RELOADED);
  } catch {
    // Best effort.
  }
}

export type AuthSessionState = 'loading' | 'ready' | 'error';

export interface UseAuthSessionResult {
  /** The signed-in Firebase user, or null when signed out. */
  user: User | null;
  state: AuthSessionState;
  /** Honest reason when auth could not initialize. */
  error: string | null;
  /** One-shot hint shown after an unauthorized-domain reload (retry sign-in). */
  signInHint: string | null;
  /** Stable: resolves the current ID token, or null when signed out. */
  getToken: () => Promise<string | null>;
  /** Google sign-in. Rejects with the mapped message (login page displays it). */
  signIn: () => Promise<void>;
  /** Sign out. */
  signOut: () => Promise<void>;
}

export function useAuthSession(): UseAuthSessionResult {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<AuthSessionState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [signInHint, setSignInHint] = useState<string | null>(null);

  const authRef = useRef<Auth | null>(null);
  // Resolves once auth has settled (ready or error). getToken() awaits it so
  // the first API calls never fire while the SDK is still restoring the
  // session from IndexedDB — that race 401'd every signed-in page load.
  const settleRef = useRef<{ promise: Promise<void>; resolve: () => void } | undefined>(undefined);

  useEffect(() => {
    let resolveSettle!: () => void;
    settleRef.current = {
      promise: new Promise<void>((resolve) => {
        resolveSettle = resolve;
      }),
      resolve: () => resolveSettle(),
    };
    // A previous tab-session reload for auth/unauthorized-domain: surface the
    // retry hint on the reloaded page. The marker stays until a real sign-in
    // clears it, so a still-unauthorized domain can never reload-loop.
    if (hasReloadedForUnauthorizedDomain()) {
      setSignInHint(SIGN_IN_RETRY_HINT);
    }
    const auth = getClientAuth();
    authRef.current = auth;
    let settled = false;
    const settleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setState('error');
      setError('Sign in is taking too long. Check your connection and try again.');
      settleRef.current?.resolve();
    }, AUTH_SETTLE_TIMEOUT_MS);
    if (!auth) {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      setState('error');
      setError(authErrorMessage('config-missing'));
      settleRef.current.resolve();
      return;
    }
    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        setUser(u);
        setState('ready');
        if (u) {
          // A successful sign-in clears the one-shot reload marker + hint so a
          // later /login visit never shows a stale retry message.
          clearUnauthorizedDomainMarker();
          setSignInHint(null);
        }
        settleRef.current?.resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        setState('error');
        setError(authErrorMessage((err as { code?: string })?.code));
        settleRef.current?.resolve();
      },
    );
    return () => {
      clearTimeout(settleTimer);
      unsub();
    };
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    const auth = authRef.current;
    if (!auth) return null;
    // Never read currentUser mid-restore: the SDK populates it asynchronously
    // from IndexedDB, so a tokenless first fetch would 401. Wait for the
    // settle first — every data hook funnels through this one choke point.
    await settleRef.current?.promise;
    const current = auth.currentUser;
    if (!current) return null;
    try {
      return await getIdToken(current);
    } catch {
      return null;
    }
  }, []);

  const signIn = useCallback(async () => {
    const auth = authRef.current;
    if (!auth) throw new Error(authErrorMessage('config-missing'));
    try {
      await signInWithGoogle(auth);
    } catch (e) {
      if (e instanceof SignInError && e.code === 'auth/unauthorized-domain') {
        // The SDK caches its origin check in memory: a tab that once failed
        // with auth/unauthorized-domain keeps failing on every retry until the
        // page reloads and a fresh SDK re-fetches the authorized-domains list.
        if (hasReloadedForUnauthorizedDomain()) {
          // We already refreshed once this tab session and it is STILL
          // blocked: the domain is genuinely missing, not a stale cache. Say
          // so distinctly (and drop the now-stale "tap to retry" hint) instead
          // of re-showing the same generic message.
          setSignInHint(null);
          throw new SignInError(SIGN_IN_STILL_BLOCKED, e.code);
        }
        // First failure: navigate once, but only when the one-shot marker
        // actually persisted. If storage is unavailable the marker would still
        // read unset after the navigation, so we'd loop forever — fall through
        // to the generic blocked-domain error instead.
        if (markReloadedForUnauthorizedDomain() && navigateToRetry()) {
          // The ?retry=1 navigation is user-initiated (we are still inside the
          // click handler), so the freshly loaded page re-opens the popup
          // without a second tap. Never reject: the navigation re-runs the
          // flow, and the still-blocked message handles a genuinely-missing
          // domain on the next attempt.
          return;
        }
      }
      throw e;
    }
    // onAuthStateChanged flips state to 'ready' with the user automatically.
  }, []);

  const signOut = useCallback(async () => {
    const auth = authRef.current;
    if (auth) await signOutFirebase(auth);
  }, []);

  return { user, state, error, signInHint, getToken, signIn, signOut };
}
