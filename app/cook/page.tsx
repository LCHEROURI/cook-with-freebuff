'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { CookScreen } from '@/components/CookScreen';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';
import { useCookingSession } from '@/lib/hooks/useCookingSession';

export default function CookPage() {
  const cook = useCookingSession();
  const voice = useVoiceSession();
  const [input, setInput] = useState('');
  const snap = cook.snapshot;

  // Keep the screen in sync with voice-driven changes (e.g. "done" spoken).
  useEffect(() => {
    if (voice.transcript.length > 0) {
      void cook.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript.length]);

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
