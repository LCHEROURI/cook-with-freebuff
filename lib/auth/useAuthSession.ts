'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useAuthSession — establish the anonymous Firebase session for the
// voice-first screens (no login UI) and expose a stable getToken() for the
// API hooks (useCookingSession, useVoiceSession).
//
//   1. Resolves the Firebase client auth (config-guarded — missing
//      NEXT_PUBLIC_FIREBASE_* env is an honest error, never a crash).
//   2. Subscribes to onAuthStateChanged. Signed in → ready. Signed out →
//      auto sign-in anonymously (per-visitor uid — see session.ts for why).
//   3. getToken() resolves the current ID token; if the anonymous session is
//      still settling it waits (bounded) for it — so the FIRST /api/cook
//      status call never 401s before auth exists, and the /cook screen never
//      flashes the misleading "Authentication required".
//   4. retry() re-runs the whole flow (e.g. after the operator enables
//      Anonymous sign-in in the Firebase console — no reload needed).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { getIdToken, onAuthStateChanged, type Auth, type User } from 'firebase/auth';
import { getClientAuth } from '@/lib/firebase/client';
import { authErrorMessage, ensureAnonSession } from './session';

export type AuthSessionState = 'loading' | 'ready' | 'error';

export interface UseAuthSessionResult {
  /** The signed-in Firebase user (anonymous), null until established. */
  user: User | null;
  state: AuthSessionState;
  /** Honest reason when auth could not be established (e.g. anon disabled). */
  error: string | null;
  /** Stable: resolves the current ID token, or null when unavailable. */
  getToken: () => Promise<string | null>;
  /** Re-run the whole flow (bumps the effect). */
  retry: () => void;
}

async function idToken(user: User): Promise<string | null> {
  try {
    return await getIdToken(user);
  } catch {
    return null;
  }
}

/** Bounded wait for the anonymous session to settle (early-exit on error). */
function waitForSession(
  auth: Auth,
  stateRef: { current: AuthSessionState },
): Promise<User | null> {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (stateRef.current === 'error') return Promise.resolve(null);
  return new Promise((resolveWait) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const u = auth.currentUser;
      const done = u !== null || stateRef.current === 'error' || Date.now() - started > 12_000;
      if (done) {
        clearInterval(iv);
        resolveWait(u);
      }
    }, 150);
  });
}

export function useAuthSession(): UseAuthSessionResult {
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<AuthSessionState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const authRef = useRef<Auth | null>(null);
  const stateRef = useRef<AuthSessionState>('loading');
  const pendingRef = useRef<Promise<User | null> | null>(null);

  useEffect(() => {
    const auth = getClientAuth();
    authRef.current = auth;
    if (!auth) {
      stateRef.current = 'error';
      setState('error');
      setError(authErrorMessage('config-missing'));
      setUser(null);
      return;
    }
    stateRef.current = 'loading';
    pendingRef.current = null;
    setState('loading');
    setError(null);

    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        if (u) {
          stateRef.current = 'ready';
          setState('ready');
          setUser(u);
          return;
        }
        // Signed out — establish the anonymous session (voice-first: no UI).
        void ensureAnonSession(auth).then((res) => {
          if (res.ok) {
            stateRef.current = 'ready';
            setState('ready');
            setUser(res.user);
          } else {
            stateRef.current = 'error';
            setState('error');
            setError(res.error);
          }
        });
      },
      (err) => {
        stateRef.current = 'error';
        setState('error');
        setError(authErrorMessage((err as { code?: string })?.code));
      },
    );
    return () => unsub();
  }, [attempt]);

  const getToken = useCallback(async (): Promise<string | null> => {
    const auth = authRef.current;
    if (!auth) return null;
    const user = await waitForSession(auth, stateRef);
    return user ? idToken(user) : null;
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { user, state, error, getToken, retry };
}
