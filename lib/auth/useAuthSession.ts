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

function markReloadedForUnauthorizedDomain(): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage?.setItem(UNAUTHORIZED_DOMAIN_RELOADED, '1');
  } catch {
    // Storage unavailable (private mode) — the worst case is a retry reload.
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
    if (!auth) {
      setState('error');
      setError(authErrorMessage('config-missing'));
      settleRef.current.resolve();
      return;
    }
    const unsub = onAuthStateChanged(
      auth,
      (u) => {
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
        setState('error');
        setError(authErrorMessage((err as { code?: string })?.code));
        settleRef.current?.resolve();
      },
    );
    return () => unsub();
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
      if (
        e instanceof SignInError &&
        e.code === 'auth/unauthorized-domain' &&
        !hasReloadedForUnauthorizedDomain()
      ) {
        // The SDK caches its origin check in memory: a tab that once failed
        // with auth/unauthorized-domain keeps failing on every retry — even
        // after the domain is authorized server-side — until the page reloads
        // and a fresh SDK re-fetches the authorized-domains list. Reload once
        // per tab session, then show the retry hint on the fresh page. (We
        // cannot auto-open the popup after the reload: browsers block a popup
        // that is not inside a user gesture.)
        markReloadedForUnauthorizedDomain();
        try {
          window.location.reload();
          return; // the reload re-runs the flow — never reject
        } catch {
          // reload unavailable — fall through to surface the mapped error
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
