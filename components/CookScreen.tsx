'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '@/app/cook/page.module.css';
import { formatIngredientQuantityPrefix, formatIngredientNameSuffix } from '@/lib/recipe/format';
import { VoiceIndicator } from './VoiceIndicator';
import { formatPausedAgo, type ActiveTimerInfo, type GuideSnapshot } from '@/lib/domain/guide';
import type { AgentTurn, VoiceStatus } from '@/lib/agent';

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function TimerDisplay({ timer, paused, pausedAt }: { timer: ActiveTimerInfo; paused: boolean; pausedAt?: number }) {
  const [remaining, setRemaining] = useState(timer.remainingSeconds);
  // Ticks the "paused 2m ago" caption while paused (the frozen remainder itself
  // must NOT tick — that comes from the server).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    // While paused the server freezes the countdown at the at-pause remainder
    // (derived from pausedAt) — /cook must agree with the card and NOT tick
    // the local countdown toward zero, or the screen would show a shrinking
    // timer the server says is frozen.
    if (paused) {
      setRemaining(timer.remainingSeconds);
      const id = window.setInterval(() => setNowMs(Date.now()), 1000);
      return () => window.clearInterval(id);
    }
    setRemaining(timer.remainingSeconds);
    const id = window.setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [timer.endsAt, timer.remainingSeconds, paused]);
  return (
    <div
      className={paused ? `${styles.timer} ${styles.timerPaused}` : styles.timer}
      role="timer"
      aria-label={
        paused
          ? `${timer.label}, paused at ${formatCountdown(timer.remainingSeconds)}, ${formatPausedAgo(pausedAt ?? nowMs, nowMs)}`
          : `${timer.label}, ${formatCountdown(remaining)} remaining`
      }
    >
      <span className={styles.timerLabel}>{timer.label}</span>
      <span className={styles.timerRight}>
        <span className={styles.timerCount}>
          {paused ? '⏸ ' : ''}
          {formatCountdown(paused ? timer.remainingSeconds : remaining)}
        </span>
        {paused && pausedAt ? (
          <span className={styles.timerPausedAgo}>{formatPausedAgo(pausedAt, nowMs)}</span>
        ) : null}
      </span>
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
  /** Real microphone → speech-to-text (Web Speech API). When unsupported the
   *  mic button renders disabled and the text input stays the fallback. */
  micSupported?: boolean;
  micListening?: boolean;
  micInterim?: string;
  /** Live speech energy — true while the user is actually speaking, so the
   *  status dot can widen into a solid recording bar ("hearing you") instead
   *  of the waiting pulse. */
  micHearing?: boolean;
  /** True while the model's spoken reply is playing: the mic is muted, so
   *  the status line must say so instead of inviting speech into a dead mic. */
  micReplying?: boolean;
  /** Which voice engine the mic uses — surfaced as a small badge so a
   *  session that silently landed on the Web Speech fallback is visible at a
   *  glance instead of behaving differently without saying why. */
  voiceEngine?: 'gemini-live' | 'web-speech' | 'none';
  micError?: string | null;
  onMicToggle: () => void;
  onMicErrorClear?: () => void;
  /** Returns a diagnostics blob for the active mic (engine, session state,
   *  errors, browser capabilities) — surfaced as a one-click "copy voice
   *  details" so mic problems can be shared without console access. */
  onCopyDiagnostics?: () => string;
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
  micSupported = false,
  micListening = false,
  micInterim = '',
  micHearing = false,
  micReplying = false,
  voiceEngine = 'none',
  micError,
  onMicToggle,
  onMicErrorClear,
  onCopyDiagnostics,
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
  const [copiedDetails, setCopiedDetails] = useState(false);

  const copyMicDiagnostics = async () => {
    if (!onCopyDiagnostics) return;
    const text = onCopyDiagnostics();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (older browsers, non-secure context) —
      // fall back to a hidden textarea + execCommand.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        // execCommand missing (jsdom, some webviews) — nothing more to try.
      }
      ta.remove();
    }
    setCopiedDetails(true);
    window.setTimeout(() => setCopiedDetails(false), 2000);
  };

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
            <TimerDisplay key={t.timerId} timer={t} paused={isPaused} pausedAt={snap.pausedAt} />
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
            ? snap.availableIngredients.map((ing) => (
                <li key={ing.id} className={styles.ingredientRow}>
                  <span className={styles.quantity}>{formatIngredientQuantityPrefix(ing)}</span>
                  <span className={styles.name}>{formatIngredientNameSuffix(ing)}</span>
                </li>
              ))
            : snap.recipe?.ingredients.map((ing) => (
                <li key={ing.id} className={styles.ingredientRow}>
                  <span className={styles.quantity}>{formatIngredientQuantityPrefix(ing)}</span>
                  <span className={styles.name}>{formatIngredientNameSuffix(ing)}</span>
                </li>
              )) ?? <li>No ingredients listed.</li>}
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
        <button
          type="button"
          className={`${styles.micBtn} ${micListening ? styles.micListening : ''}`}
          onClick={onMicToggle}
          disabled={!micSupported}
          aria-label={micListening ? 'Stop listening' : 'Speak a command'}
          aria-pressed={micListening}
          title={
            micSupported
              ? micListening
                ? 'Tap to stop listening'
                : 'Tap, speak, then I send it'
              : 'Microphone not supported in this browser — type instead'
          }
        >
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
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </button>
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
      {voiceEngine !== 'none' && (
        <span
          className={`${styles.voiceEngineBadge} ${voiceEngine === 'gemini-live' ? styles.voiceEngineBadgeLive : styles.voiceEngineBadgeFallback}`}
          data-engine={voiceEngine}
        >
          {voiceEngine === 'gemini-live' ? '⚡ Gemini Live' : '🔄 Web Speech'}
        </span>
      )}
      {micListening && (
        <p
          className={styles.micStatus}
          role="status"
          aria-live="polite"
          data-hearing={micHearing ? 'true' : 'false'}
          data-replying={micReplying ? 'true' : 'false'}
        >
          <span
            className={
              micReplying
                ? styles.micStatusDotReplying
                : micHearing
                  ? styles.micStatusDotHearing
                  : styles.micStatusDot
            }
            aria-hidden="true"
          />
          <span>
            🎙{' '}
            {micReplying
              ? 'Reply playing — mic paused'
              : micHearing
                ? 'Hearing you…'
                : micInterim || 'Listening… speak now'}
          </span>
          <span className={styles.micStatusHint}>· tap to stop</span>
        </p>
      )}
      {micError && (
        <div className={styles.micError} role="alert">
          <span>{micError}</span>
          {onMicErrorClear && (
            <button className={styles.alertClose} onClick={onMicErrorClear} aria-label="Dismiss microphone error">
              ×
            </button>
          )}
        </div>
      )}
      {onCopyDiagnostics && (micListening || micError) && (
        <button
          type="button"
          className={styles.voiceDiagBtn}
          onClick={() => void copyMicDiagnostics()}
          aria-label="Copy voice session details"
        >
          {copiedDetails ? '✓ copied voice details' : 'ⓘ copy voice details'}
        </button>
      )}
    </main>
  );
}
