'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';

export default function LoginPage() {
  const router = useRouter();
  const auth = useAuthSession();
  const [busy, setBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const autoRetryRef = useRef(false);
  // signIn is stable (a useCallback([]) in the hook), so onSignIn is stable too.
  const signIn = auth.signIn;

  const onSignIn = useCallback(async (fromAutoRetry = false) => {
    setBusy(true);
    setSignInError(null);
    try {
      await signIn();
      // onAuthStateChanged flips the user — the redirect effect above runs.
    } catch (e) {
      const code = (e as { code?: string })?.code;
      // The post-reload auto-retry has no surviving user gesture, so the
      // browser can block the popup (auth/popup-blocked). In that case keep
      // the "tap to retry" hint and do NOT surface a scary "Sign-in was
      // cancelled" error — the user just taps the button once. A genuine
      // still-blocked domain still surfaces its distinct message.
      if (fromAutoRetry && (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request')) {
        return;
      }
      setSignInError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }, [signIn]);

  // Already signed in? Go cook.
  useEffect(() => {
    if (auth.state === 'ready' && auth.user) {
      router.replace('/cook');
    }
  }, [auth.state, auth.user, router]);

  // Auto-retry the popup after the unauthorized-domain reload. The reload was
  // a user-initiated navigation, so the browser still allows the popup — no
  // second tap needed. It fires once (ref-guarded), only when ?retry=1 is
  // present and auth has settled, and it clears the flag from the URL so a
  // later manual reload never re-triggers it.
  useEffect(() => {
    if (autoRetryRef.current) return;
    if (typeof window === 'undefined') return;
    if (auth.state !== 'ready') return;
    if (new URLSearchParams(window.location.search).get('retry') !== '1') return;
    autoRetryRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('retry');
    window.history.replaceState(null, '', url.toString());
    void onSignIn(true);
  }, [auth.state, onSignIn]);

  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.loading}>Loading…</p>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <h1 className={styles.title}>Cook With Me</h1>
        <p className={styles.subtitle}>Your voice-first cooking companion</p>

        {auth.error && <p className={styles.error} role="alert">{auth.error}</p>}
        {signInError && <p className={styles.error} role="alert">{signInError}</p>}
        {auth.signInHint && <p className={styles.hint} role="status">{auth.signInHint}</p>}

        <button
          className={styles.googleBtn}
          onClick={() => void onSignIn()}
          disabled={busy || auth.state === 'error'}
          aria-label="Sign in with Google"
        >
          <span className={styles.googleIcon} aria-hidden="true">G</span>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </button>

        <p className={styles.note}>
          Sign in with the Google account you use for your kitchen. Your
          sessions, pantry and grocery list are private to this account.
        </p>

        <Link href="/" className={styles.backLink}>
          ← Back to start
        </Link>
      </section>
    </main>
  );
}
