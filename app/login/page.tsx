'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';

export default function LoginPage() {
  const router = useRouter();
  const auth = useAuthSession();
  const [busy, setBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Already signed in? Go cook.
  useEffect(() => {
    if (auth.state === 'ready' && auth.user) {
      router.replace('/cook');
    }
  }, [auth.state, auth.user, router]);

  const onSignIn = async () => {
    setBusy(true);
    setSignInError(null);
    try {
      await auth.signIn();
      // onAuthStateChanged flips the user — the redirect effect above runs.
    } catch (e) {
      setSignInError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

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
