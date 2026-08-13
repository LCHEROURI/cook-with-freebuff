'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { detectVoiceEngine } from '@/lib/voice/self-check';
import { playTimerChime, unlockAudioOnGesture } from '@/lib/audio/timer-chime';
import { formatPausedAgo, type GuideSnapshot } from '@/lib/domain/guide';

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// Live countdown for one active timer on the resume card — ticks every second
// from the server-reported endsAt (same shape CookScreen's timers use). While
// the session is paused the server freezes the countdown at the at-pause
// remainder (derived from pausedAt, so it survives reloads and polls), and
// the card just displays that frozen value — no client-side capture.
function ResumeTimer({ timer, paused, pausedAt }: { timer: { label: string; endsAt: number; remainingSeconds: number }; paused: boolean; pausedAt?: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, timer.endsAt - Date.now()));
  // Ticks the "paused 2m ago" caption while paused (the frozen remainder itself
  // must NOT tick — that comes from the server).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!paused) {
      setRemaining(Math.max(0, timer.endsAt - Date.now()));
      const id = window.setInterval(() => {
        setRemaining(Math.max(0, timer.endsAt - Date.now()));
      }, 1000);
      return () => window.clearInterval(id);
    }
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timer.endsAt, paused]);
  const shownMs = paused ? timer.remainingSeconds * 1000 : remaining;
  return (
    <span
      className={paused ? `${styles.resumeTimer} ${styles.resumeTimerPaused}` : styles.resumeTimer}
      role="timer"
      aria-label={
        paused
          ? `${timer.label}, paused at ${formatCountdown(shownMs)}, ${formatPausedAgo(pausedAt ?? nowMs, nowMs)}`
          : `${timer.label}, ${formatCountdown(shownMs)} remaining`
      }
    >
      {paused ? '⏸' : '⏱'} {timer.label} · {formatCountdown(shownMs)}
      {paused && pausedAt ? (
        <span className={styles.resumeTimerPausedAgo}>{formatPausedAgo(pausedAt, nowMs)}</span>
      ) : null}
    </span>
  );
}

const phaseLabel = (phase: string): string => {
  switch (phase) {
    case 'PAUSED':
      return 'Paused';
    case 'PREP_GUIDANCE':
      return 'Prep';
    case 'COOKING_GUIDANCE':
    case 'WAITING_FOR_TIMER':
      return 'Cooking';
    case 'PLATING':
      return 'Plating';
    case 'COMPLETED':
      return 'Done';
    case 'SAFETY_WARNING':
      return 'Safety';
    default:
      return phase;
  }
};

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

];

export default function HomePage() {
  const auth = useAuthSession();
  const [snap, setSnap] = useState<GuideSnapshot | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [toggling, setToggling] = useState(false);
  const voiceEngine = detectVoiceEngine();

  // The chime is gesture-gated by the browser's AudioContext policy: it stays
  // suspended until the first interaction, so playTimerChime can only ever
  // sound after the user has engaged with the page.
  useEffect(() => unlockAudioOnGesture(), []);

  // Chime once per finished timer, keyed by the server's unique timerId —
  // never by message text, so two same-labeled timers finishing in separate
  // polls each chime. A completed timer is detached server-side, so an id can
  // never legitimately fire twice.
  const chimedTimerIds = useRef<Set<string>>(new Set());
  const [alertTimerIds, setAlertTimerIds] = useState<string[]>([]);
  useEffect(() => {
    const fresh = alertTimerIds.filter((id) => !chimedTimerIds.current.has(id));
    if (fresh.length > 0) {
      playTimerChime();
      for (const id of fresh) chimedTimerIds.current.add(id);
    }
  }, [alertTimerIds]);

  // The resume card needs the active session's current step + timers. Reads
  // come through the same /api/cook 'timers' action /cook's own hook polls
  // (never a client-side Firestore read): a finished timer surfaces an alert
  // AND the returned snapshot recovers the session to the next step. The
  // server is idempotent — a completed timer is detached, so later polls
  // can't re-alert on it. Gated on auth settle exactly like /recipes so a
  // signed-out visitor never fires a tokenless request.
  const getToken = auth.getToken;
  const fetchStatus = useCallback(async () => {
    if (auth.state !== 'ready' || !auth.user) return;
    const token = await getToken();
    if (!token) return;
    try {
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'timers' }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: { alerts?: { message: string; timerId: string }[]; snapshot?: GuideSnapshot };
      };
      const snapshot = body.data?.snapshot;
      if (res.ok && body.success && snapshot && snapshot.found) {
        if (body.data?.alerts && body.data.alerts.length > 0) {
          setAlert(body.data.alerts.map((a) => a.message).join(' '));
          setAlertTimerIds(body.data.alerts.map((a) => a.timerId));
        }
        setSnap(snapshot);
      } else {
        setSnap(null);
      }
    } catch {
      setSnap(null);
    } finally {
      setChecked(true);
    }
  }, [auth.state, auth.user, getToken]);

  useEffect(() => {
    if (auth.state !== 'ready' || !auth.user) return;
    void fetchStatus();
    // Keep the resume card fresh and finished-timer alerts timely (timer
    // countdowns use their own 1s tick, but the step and alerts come from the
    // server — 10s keeps an alert at most ~10s late without hammering the
    // endpoint).
    const id = window.setInterval(() => void fetchStatus(), 10000);
    return () => window.clearInterval(id);
  }, [auth.state, auth.user, fetchStatus]);

  // The server's state machine only accepts a pause from these phases — offer
  // the button there (and for the resume side when already paused), never in
  // PLATING / RECIPE_READY / collection phases where the server would reject
  // the transition.
  const CAN_PAUSE: ReadonlySet<string> = new Set(['PREP_GUIDANCE', 'COOKING_GUIDANCE', 'WAITING_FOR_TIMER']);
  const canPause = !!snap && (snap.paused || CAN_PAUSE.has(snap.phase));

  // Pause/resume straight from the card — no need to open /cook. Same
  // /api/cook action the page itself uses, and the response snapshot
  // replaces the card's state (server is the single source of truth).
  const togglePause = useCallback(async () => {
    if (!snap) return;
    const token = await getToken();
    if (!token) return;
    setToggling(true);
    try {
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: snap.paused ? 'resume' : 'pause' }),
      });
      const body = (await res.json()) as { success: boolean; data?: GuideSnapshot };
      if (res.ok && body.success && body.data) setSnap(body.data);
    } catch {
      // Keep the card as-is; the button re-enables and the user can retry.
    } finally {
      setToggling(false);
    }
  }, [snap, getToken]);

  const cta = auth.state === 'loading' ? null : auth.user ? (
    <div className={styles.ctaRow}>
      <Link href="/cook" className={styles.primaryBtn}>👨‍🍳 Start cooking</Link>
      <Link href="/recipes" className={styles.secondaryBtn}>📖 My recipes</Link>
      <Link href="/kitchen" className={styles.secondaryBtn}>🧺 My kitchen</Link>
    </div>
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
        <p className={styles.heroMotif} aria-hidden="true">
          <span className={styles.herb1}>🌿</span>
          <span className={styles.herb2}>🌱</span>
          <span className={styles.herb3}>🌿</span>
        </p>
        <p className={styles.subtitle}>
          A voice-first cooking companion that guides you step by step — from
          “what do I have?” to a plated dinner.
        </p>
        {cta && <div className={styles.heroCta}>{cta}</div>}
      </section>

      {checked && auth.user && snap && (
        <section className={styles.resume} aria-label="Resume cooking">
          {alert && (
            <div className={styles.resumeAlert} role="status">
              <span>{alert}</span>
              <button className={styles.resumeAlertDismiss} onClick={() => setAlert(null)} aria-label="Dismiss alert">
                ✕
              </button>
            </div>
          )}
          <div className={styles.resumeHeader}>
            <span className={styles.resumeEyebrow}>{snap.paused ? 'Paused' : 'In progress'}</span>
            <span className={styles.resumeVoice} data-engine={voiceEngine}>
              {voiceEngine === 'gemini-live' ? '⚡ Gemini Live' : voiceEngine === 'web-speech' ? '🔄 Web Speech' : '🎙️ Voice off'}
            </span>
          </div>
          <h2 className={styles.resumeTitle}>{snap.recipeTitle ?? 'Your cooking session'}</h2>
          <p className={styles.resumeStep}>
            {phaseLabel(snap.phase)}
            {snap.stepNumber && snap.totalSteps ? ` · step ${snap.stepNumber} of ${snap.totalSteps}` : ''}
          </p>
          {snap.instruction && <p className={styles.resumeInstruction}>{snap.instruction}</p>}
          {snap.activeTimers.length > 0 && (
            <div className={styles.resumeTimers}>
              {snap.activeTimers.map((t) => (
                <ResumeTimer key={t.timerId} timer={t} paused={snap.paused ?? false} pausedAt={snap.pausedAt} />
              ))}
            </div>
          )}
          <div className={styles.resumeActions}>
            {canPause && (
              <button
                className={styles.resumeQuickBtn}
                onClick={() => void togglePause()}
                disabled={toggling}
                aria-label={snap.paused ? 'Resume the session' : 'Pause the session'}
              >
                {snap.paused ? '▶ Resume' : '⏸ Pause'}
              </button>
            )}
            <Link href="/cook" className={styles.resumeBtn}>
              {snap.paused ? 'Open session' : 'Resume cooking →'}
            </Link>
          </div>
        </section>
      )}

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
        <p className={styles.footerLink}>
          <Link href="/status">Kitchen status</Link>
        </p>
      </footer>
    </main>
  );
}
