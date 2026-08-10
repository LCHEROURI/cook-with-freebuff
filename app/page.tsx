'use client';

import { useState } from 'react';
import styles from './page.module.css';

export default function HomePage() {
  const [mode, setMode] = useState<'idle' | 'quick' | 'cook'>('idle');

  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <h1 className={styles.title}>Kitchen Agent</h1>
        <p className={styles.subtitle}>
          Voice-first intelligent cooking companion
        </p>
      </section>

      {mode === 'idle' && (
        <section className={styles.choices}>
          <button
            className={styles.card}
            onClick={() => setMode('quick')}
          >
            <span className={styles.cardIcon}>📝</span>
            <span className={styles.cardLabel}>Quick Recipe</span>
            <span className={styles.cardDesc}>
              Tell me what you have — I&apos;ll generate a recipe
            </span>
          </button>

          <button
            className={styles.card}
            onClick={() => setMode('cook')}
          >
            <span className={styles.cardIcon}>👨‍🍳</span>
            <span className={styles.cardLabel}>Cook With Me</span>
            <span className={styles.cardDesc}>
              Step-by-step guided cooking with voice
            </span>
          </button>
        </section>
      )}

      {mode === 'quick' && (
        <section className={styles.placeholder}>
          <p>Quick Recipe — coming in K4</p>
          <button className={styles.backBtn} onClick={() => setMode('idle')}>
            ← Back
          </button>
        </section>
      )}

      {mode === 'cook' && (
        <section className={styles.placeholder}>
          <p>Cook With Me — coming in K6</p>
          <button className={styles.backBtn} onClick={() => setMode('idle')}>
            ← Back
          </button>
        </section>
      )}
    </main>
  );
}