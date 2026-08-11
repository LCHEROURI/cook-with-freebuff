'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '@/app/cook/page.module.css';
import { VoiceIndicator } from './VoiceIndicator';
import type { ActiveTimerInfo, GuideSnapshot } from '@/lib/server/guide-service';
import type { AgentTurn, VoiceStatus } from '@/lib/agent';

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
  /** The turn transcript — the agent's replies are shown on screen so the user SEES what the app understood and said, instead of only hearing it. */
  turns?: AgentTurn[];
  voiceStatus: VoiceStatus;
  onDone: () => void;
  onRepeat: () => void;
  onBack: () => void;
  onResume: () => void;
  onStartOver: () => void;
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
  turns,
  voiceStatus,
  onDone,
  onRepeat,
  onBack,
  onResume,
  onStartOver,
  onDismissAlert,
  onSend,
}: CookScreenProps) {
  const [input, setInput] = useState('');
  // Two-step confirm for Start over — archiving the session is irreversible
  // from the screen, so the first click arms the button, the second fires.
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);

  // The most recent turns the user can re-read — a bounded window keeps the
  // screen focused on the ONE current action, not a full chat log.
  const recentTurns = turns && turns.length > 0 ? turns.slice(-5) : [];
  const lastResponse = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1].response : null;

  const phaseLabel =
    snap.phase === 'PREP_GUIDANCE'
      ? 'Prep'
      : snap.phase === 'COOKING_GUIDANCE' || snap.phase === 'WAITING_FOR_TIMER'
        ? 'Cooking'
        : snap.phase === 'PLATING'
          ? 'Plating'
          : snap.phase === 'COMPLETED'
            ? 'Done'
            : snap.phase === 'SAFETY_WARNING'
              ? 'Safety'
              : snap.phase;

  const isPaused = snap.paused || snap.phase === 'PAUSED';
  const doneDisabled =
    snap.phase === 'PLATING' || snap.phase === 'COMPLETED' || snap.phase === 'WAITING_FOR_TIMER' || isPaused;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <Link href="/" className={styles.backLink} aria-label="Back to start">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
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
        <p className={styles.instruction}>
          {snap.instruction ??
            // No step instruction yet: the collecting phase has nothing to
            // DO yet, so instead of a dead "One moment…" tell the user how
            // to move forward.
            (snap.phase === 'COLLECTING_INGREDIENTS'
              ? 'Tell me what ingredients you have — say “done” when you are ready.'
              : 'One moment…')}
        </p>
        {snap.safetyNote && !snap.safetyGate && <p className={styles.safetyNote}>⚠ {snap.safetyNote}</p>}
      </section>

      {lastResponse && (
        <div className={styles.agentResponse} role="status" aria-live="polite">
          <span className={styles.agentResponseLabel}>Kitchen Agent</span>
          <span>{lastResponse}</span>
        </div>
      )}

      {recentTurns.length > 1 && (
        <section className={styles.transcript} role="log" aria-label="Conversation transcript" aria-live="polite">
          {recentTurns.map((turn, i) => (
            <div className={styles.transcriptTurn} key={`${i}-${turn.utterance}`}>
              <p className={styles.transcriptYou}>
                <span className={styles.transcriptLabel}>You</span>
                {turn.utterance}
              </p>
              <p className={styles.transcriptAgent}>
                <span className={styles.transcriptLabel}>Kitchen Agent</span>
                {turn.response}
              </p>
            </div>
          ))}
        </section>
      )}

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

      {snap.safetyGate && (
        <section className={styles.safetyGate} role="alertdialog" aria-label="Safety warning" aria-live="assertive">
          <p className={styles.safetyGateTitle}>⚠ Safety first</p>
          <p className={styles.safetyGateNote}>{snap.safetyGate.note}</p>
          <p className={styles.safetyGateHint}>The step is not marked done until you confirm you understand.</p>
          <button
            className={`${styles.control} ${styles.primary} ${styles.safetyGateConfirm}`}
            onClick={onDone}
            aria-label="I understand the safety warning, continue"
          >
            ✓ I understand — continue
          </button>
        </section>
      )}

      <section className={styles.controls}>
        {isPaused ? (
          <button className={`${styles.control} ${styles.primary}`} onClick={onResume} aria-label="Resume cooking">
            ▶ Resume
          </button>
        ) : snap.safetyGate ? (
          // During the safety gate the only action is the explicit confirmation
          // above — the step is not completed until it is acknowledged.
          <p className={styles.safetyGateWaiting}>Confirm the safety note to continue.</p>
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

      <button
        className={`${styles.startOver} ${confirmingStartOver ? styles.startOverArmed : ''}`}
        onClick={() => {
          if (!confirmingStartOver) {
            setConfirmingStartOver(true);
            return;
          }
          setConfirmingStartOver(false);
          onStartOver();
        }}
        onBlur={() => setConfirmingStartOver(false)}
        aria-label="Start over"
      >
        {confirmingStartOver ? '✓ Confirm — restart from step 1?' : '↺ Start over'}
      </button>

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
