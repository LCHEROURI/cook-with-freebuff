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
import { authErrorMessage, signInWithGoogle, signOutFirebase } from './session';

export type AuthSessionState = 'loading' | 'ready' | 'error';

export interface UseAuthSessionResult {
  /** The signed-in Firebase user, or null when signed out. */
  user: User | null;
  state: AuthSessionState;
  /** Honest reason when auth could not initialize. */
  error: string | null;
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
    await signInWithGoogle(auth);
    // onAuthStateChanged flips state to 'ready' with the user automatically.
  }, []);

  const signOut = useCallback(async () => {
    const auth = authRef.current;
    if (auth) await signOutFirebase(auth);
  }, []);

  return { user, state, error, getToken, signIn, signOut };
}
