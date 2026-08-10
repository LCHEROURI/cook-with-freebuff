'use client';

import { useState } from 'react';
import styles from './page.module.css';
import { VoiceIndicator } from '@/components/VoiceIndicator';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';

export default function HomePage() {
  const [mode, setMode] = useState<'idle' | 'quick' | 'cook'>('idle');
  const [input, setInput] = useState('');
  const voice = useVoiceSession();

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
        <section className={styles.voicePanel}>
          <VoiceIndicator status={voice.status} />
          <div className={styles.transcript}>
            {voice.transcript.map((turn, i) => (
              <div key={i} className={styles.turn}>
                <p className={styles.userLine}>You: {turn.utterance}</p>
                <p className={styles.agentLine}>{turn.response}</p>
              </div>
            ))}
            {voice.transcript.length === 0 && (
              <p className={styles.hint}>
                Try: &ldquo;I have some chicken thighs, three tomatoes and rice.&rdquo;
              </p>
            )}
          </div>
          <form
            className={styles.voiceForm}
            onSubmit={(e) => {
              e.preventDefault();
              void voice.send(input);
              setInput('');
            }}
          >
            <input
              className={styles.voiceInput}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Say it, or type it…"
              aria-label="Speak or type a message"
            />
            <button className={styles.sendBtn} type="submit">
              Send
            </button>
          </form>
          <button className={styles.backBtn} onClick={() => setMode('idle')}>
            ← Back
          </button>
        </section>
      )}
    </main>
  );
}