'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '@/app/cook/page.module.css';
import { VoiceIndicator } from './VoiceIndicator';
import type { ActiveTimerInfo, GuideSnapshot } from '@/lib/server/guide-service';
import type { VoiceStatus } from '@/lib/agent';

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function TimerDisplay({ timer }: { timer: ActiveTimerInfo }) {
  const [remaining, setRemaining] = useState(timer.remainingSeconds);
  useEffect(() => {
    setRemaining(timer.remainingSeconds);
    const id = window.setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [timer.endsAt, timer.remainingSeconds]);
  return (
    <div className={styles.timer} role="timer" aria-label={`${timer.label}, ${formatCountdown(remaining)} remaining`}>
      <span className={styles.timerLabel}>{timer.label}</span>
      <span className={styles.timerCount}>{formatCountdown(remaining)}</span>
    </div>
  );
}

export interface CookScreenProps {
  snapshot: GuideSnapshot;
  error?: string | null;
  alert?: string | null;
  voiceStatus: VoiceStatus;
  onDone: () => void;
  onRepeat: () => void;
  onBack: () => void;
  onResume: () => void;
  onDismissAlert: () => void;
  onSend: (text: string) => void;
}

/**
 * The "Cook With Me" screen — exactly ONE action at a time, large type,
 * large controls, strong contrast. Pure presentational: all data comes in
 * via props so it renders deterministically in tests (no effects, no fetch).
 */
export function CookScreen({
  snapshot: snap,
  error,
  alert,
  voiceStatus,
  onDone,
  onRepeat,
  onBack,
  onResume,
  onDismissAlert,
  onSend,
}: CookScreenProps) {
  const [input, setInput] = useState('');

  const phaseLabel =
    snap.phase === 'PREP_GUIDANCE'
      ? 'Prep'
      : snap.phase === 'COOKING_GUIDANCE' || snap.phase === 'WAITING_FOR_TIMER'
        ? 'Cooking'
        : snap.phase === 'PLATING'
          ? 'Plating'
          : snap.phase === 'COMPLETED'
            ? 'Done'
            : snap.phase;

  const isPaused = snap.paused || snap.phase === 'PAUSED';
  const doneDisabled =
    snap.phase === 'PLATING' || snap.phase === 'COMPLETED' || snap.phase === 'WAITING_FOR_TIMER' || isPaused;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <Link href="/" className={styles.backLink} aria-label="Back to start">
            ←
          </Link>
          <h1 className={styles.recipeTitle}>{snap.recipeTitle ?? 'Cooking'}</h1>
          <VoiceIndicator status={voiceStatus} />
        </div>
        <div className={styles.phaseRow}>
          <span className={`${styles.phaseChip} ${styles[`phase-${snap.phase}`] ?? ''}`} aria-label={`Phase: ${phaseLabel}`}>
            {phaseLabel}
          </span>
          {snap.stepNumber !== undefined && snap.totalSteps !== undefined && (
            <span className={styles.stepCount}>
              Step {snap.stepNumber} of {snap.totalSteps}
            </span>
          )}
        </div>
      </header>

      {alert && (
        <div className={styles.alert} role="alert" aria-live="assertive">
          <span>{alert}</span>
          <button className={styles.alertClose} onClick={onDismissAlert} aria-label="Dismiss alert">
            ×
          </button>
        </div>
      )}

      {error && !isPaused && (
        <div className={styles.errorNote} role="alert">
          {error}
        </div>
      )}

      <section className={styles.action} aria-live="polite" aria-atomic="true">
        <p className={styles.instruction}>{snap.instruction ?? 'One moment…'}</p>
        {snap.safetyNote && <p className={styles.safetyNote}>⚠ {snap.safetyNote}</p>}
      </section>

      {snap.activeTimers.length > 0 && (
        <section className={styles.timers}>
          {snap.activeTimers.map((t) => (
            <TimerDisplay key={t.timerId} timer={t} />
          ))}
        </section>
      )}

      {snap.phase === 'COMPLETED' && (
        <section className={styles.completed}>
          <p className={styles.completedText}>🎉 Enjoy your meal!</p>
        </section>
      )}

      <section className={styles.controls}>
        {isPaused ? (
          <button className={`${styles.control} ${styles.primary}`} onClick={onResume} aria-label="Resume cooking">
            ▶ Resume
          </button>
        ) : (
          <>
            <button className={styles.control} onClick={onBack} aria-label="Previous step" disabled={snap.stepNumber === 1}>
              ◀ Previous
            </button>
            <button className={styles.control} onClick={onRepeat} aria-label="Repeat this step">
              🔁 Repeat
            </button>
            <button
              className={`${styles.control} ${styles.primary}`}
              onClick={onDone}
              aria-label="Done with this step"
              disabled={doneDisabled}
            >
              ✅ Done
            </button>
          </>
        )}
      </section>

      <details className={styles.details}>
        <summary>Ingredients</summary>
        <ul className={styles.list}>
          {snap.availableIngredients.length > 0
            ? snap.availableIngredients.map((ing) => <li key={ing.id}>{ing.name}</li>)
            : snap.recipe?.ingredients.map((ing) => <li key={ing.id}>{ing.name}</li>) ?? <li>No ingredients listed.</li>}
        </ul>
      </details>

      {snap.recipe && (
        <details className={styles.details}>
          <summary>Full recipe</summary>
          <ol className={styles.list}>
            {[...(snap.recipe.prepSteps ?? []), ...(snap.recipe.cookingSteps ?? [])].map((s) => (
              <li key={s.stepNumber}>{s.instruction}</li>
            ))}
          </ol>
        </details>
      )}

      <form
        className={styles.voiceForm}
        onSubmit={(e) => {
          e.preventDefault();
          onSend(input);
          setInput('');
        }}
      >
        <input
          className={styles.voiceInput}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say it: “done”, “repeat”, “go back”…"
          aria-label="Speak or type a command"
        />
        <button className={styles.sendBtn} type="submit">
          Send
        </button>
      </form>
    </main>
  );
}
