'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { CookScreen } from '@/components/CookScreen';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';
import { useCookingSession } from '@/lib/hooks/useCookingSession';

export default function CookPage() {
  // The API routes require a Bearer Firebase ID token; the voice-first
  // screens establish an anonymous session automatically (see useAuthSession)
  // and both data hooks receive the stable getToken — without it every call
  // 401s and the screen falsely claims "Authentication required".
  const auth = useAuthSession();
  const cook = useCookingSession({ getToken: auth.getToken });
  const voice = useVoiceSession({ getToken: auth.getToken });
  const [input, setInput] = useState('');
  const snap = cook.snapshot;

  // Keep the screen in sync with voice-driven changes (e.g. "done" spoken).
  useEffect(() => {
    if (voice.transcript.length > 0) {
      void cook.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript.length]);

  // Wait for the auth settle first, so the initial status call (which waits
  // for the session inside getToken) never 401s and the screen never flashes
  // a misleading "Authentication required".
  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your cooking session…</p>
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
            {auth.error ??
              cook.error ??
              'No active cooking session. Generate a validated recipe first, then come back to cook it step by step.'}
          </p>
          {auth.error ? (
            <button className={styles.secondaryBtn} onClick={auth.retry}>
              ↻ Retry sign-in
            </button>
          ) : null}
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
      voiceStatus={voice.status}
      onDone={() => void cook.done()}
      onRepeat={() => void cook.repeat()}
      onBack={() => void cook.back()}
      onResume={() => void cook.resume()}
      onDismissAlert={cook.dismissAlert}
      onSend={(text) => {
        void voice.send(text);
        setInput('');
      }}
    />
  );
}
