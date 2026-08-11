'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { CookScreen } from '@/components/CookScreen';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';
import { useCookingSession } from '@/lib/hooks/useCookingSession';

export default function CookPage() {
  const router = useRouter();
  // The API routes require a Bearer Firebase ID token. Real sign-in happens
  // on /login; /cook is protected — signed-out visitors are sent there.
  const auth = useAuthSession();
  const cook = useCookingSession({ getToken: auth.getToken });
  const voice = useVoiceSession({ getToken: auth.getToken });
  const [input, setInput] = useState('');
  const snap = cook.snapshot;

  // Protect the route: once auth settles with no user, go sign in.
  useEffect(() => {
    if (auth.state === 'ready' && !auth.user) {
      router.replace('/login');
    }
  }, [auth.state, auth.user, router]);

  // Keep the screen in sync with voice-driven changes (e.g. "done" spoken).
  useEffect(() => {
    if (voice.transcript.length > 0) {
      void cook.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript.length]);

  // Wait for the auth settle first, so the screen never flashes content for
  // a signed-out visitor before the redirect to /login fires.
  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your cooking session…</p>
      </main>
    );
  }

  if (auth.state === 'ready' && !auth.user) {
    // Redirecting to the login page — never render cooking UI signed out.
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Signing you in…</p>
      </main>
    );
  }

  if (auth.error) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>Cook With Me</h1>
          <p className={styles.emptyText}>{auth.error}</p>
          <Link href="/" className={styles.primaryBtn}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  if (cook.loading && !snap) {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your cooking session…</p>
      </main>
    );
  }

  if (!snap || !snap.found) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>Cook With Me</h1>
          <p className={styles.emptyText}>
            {cook.error ??
              'No active cooking session. Generate a validated recipe first, then come back to cook it step by step.'}
          </p>
          <Link href="/" className={styles.primaryBtn}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  return (
    <CookScreen
      snapshot={snap}
      error={cook.error}
      alert={cook.alert}
      // The turn transcript, surfaced on screen — without this the user only
      // HEARS responses and the screen can look stuck at "One moment…" even
      // though the agent answered. The last reply is shown large; older turns
      // are re-readable in the scrollable transcript.
      turns={voice.transcript}
      voiceStatus={voice.status}
      onDone={() => void cook.done()}
      onRepeat={() => void cook.repeat()}
      onBack={() => void cook.back()}
      onResume={() => void cook.resume()}
      onStartOver={() => void cook.startOver()}
      onDismissAlert={cook.dismissAlert}
      onSend={(text) => {
        void voice.send(text);
        setInput('');
      }}
    />
  );
}
