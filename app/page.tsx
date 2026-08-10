'use client';

import Link from 'next/link';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';

const FEATURES = [
  {
    icon: '🎙️',
    title: 'Voice-first',
    text: 'Say “done”, “repeat”, “go back” — or type it. One action at a time, hands free while you cook.',
  },
  {
    icon: '👨‍🍳',
    title: 'Step-by-step guidance',
    text: 'Prep and cooking steps with timers, plating and an explicit safety gate on every risky step.',
  },
  {
    icon: '🧺',
    title: 'Pantry intelligence',
    text: 'Tell it what you have; it tracks the pantry, flags expiring items and builds your grocery list.',
  },
  {
    icon: '🍲',
    title: 'Leftovers, handled',
    text: 'Finished a meal? It logs the leftovers and suggests what to cook next from what is actually in the kitchen.',
  },
];

export default function HomePage() {
  const auth = useAuthSession();

  const cta = auth.state === 'loading' ? null : auth.user ? (
    <Link href="/cook" className={styles.primaryBtn}>👨‍🍳 Start cooking</Link>
  ) : (
    <Link href="/login" className={styles.primaryBtn}>Sign in to start</Link>
  );

  return (
    <main className={styles.main}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Cook With Me</span>
        {auth.user ? (
          <button className={styles.signOutBtn} onClick={() => void auth.signOut()} aria-label="Sign out">
            Sign out
          </button>
        ) : (
          <Link href="/login" className={styles.signInLink}>Sign in</Link>
        )}
      </header>

      <section className={styles.hero}>
        <h1 className={styles.title}>Cook With Me</h1>
        <p className={styles.subtitle}>
          A voice-first cooking companion that guides you step by step — from
          “what do I have?” to a plated dinner.
        </p>
        {cta && <div className={styles.heroCta}>{cta}</div>}
      </section>

      <section className={styles.features} aria-label="Features">
        {FEATURES.map((f) => (
          <article key={f.title} className={styles.featureCard}>
            <span className={styles.featureIcon} aria-hidden="true">{f.icon}</span>
            <h2 className={styles.featureTitle}>{f.title}</h2>
            <p className={styles.featureText}>{f.text}</p>
          </article>
        ))}
      </section>

      <footer className={styles.footer}>
        <p>Cook With Me · sign in with Google to start</p>
      </footer>
    </main>
  );
}
