'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { detectVoiceEngine } from '@/lib/voice/self-check';
import { appCheckHeaders } from '@/lib/firebase/app-check';
import { playTimerChime, unlockAudioOnGesture } from '@/lib/audio/timer-chime';
import { formatPausedAgo, type GuideSnapshot } from '@/lib/domain/guide';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(await appCheckHeaders()) },
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(await appCheckHeaders()) },
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
      <Button asChild size="lg" className="min-h-12 px-8 text-base font-semibold shadow-sm">
        <Link href="/cook">👨‍🍳 Start cooking</Link>
      </Button>
      <Button asChild size="lg" variant="outline" className="min-h-12 border-2 px-6 text-base font-semibold text-brand hover:text-brand-hover">
        <Link href="/recipes">📖 My recipes</Link>
      </Button>
      <Button asChild size="lg" variant="outline" className="min-h-12 border-2 px-6 text-base font-semibold text-brand hover:text-brand-hover">
        <Link href="/kitchen">🧺 My kitchen</Link>
      </Button>
    </div>
  ) : (
    <Button asChild size="lg" className="min-h-12 px-8 text-base font-semibold shadow-sm">
      <Link href="/login">Sign in to start</Link>
    </Button>
  );

  return (
    <main className={styles.main}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Cook With Me</span>
        {auth.user ? (
          <Button variant="outline" onClick={() => void auth.signOut()} className="min-h-11 text-sm">
            Sign out
          </Button>
        ) : (
          <Button asChild variant="ghost" className="min-h-11 text-sm font-semibold text-brand hover:text-brand-hover">
            <Link href="/login">Sign in</Link>
          </Button>
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
        <Card
          aria-label="Resume cooking"
          className="w-full max-w-[640px] gap-2 rounded-l-none border-l-[3px] border-l-accent p-5 shadow-sm"
        >
          {alert && (
            <div className={styles.resumeAlert} role="status">
              <span>{alert}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setAlert(null)}
                aria-label="Dismiss alert"
              >
                ✕
              </Button>
            </div>
          )}
          <div className={styles.resumeHeader}>
            <span className="font-display text-xs font-semibold uppercase tracking-wider text-accent">
              {snap.paused ? 'Paused' : 'In progress'}
            </span>
            <Badge
              variant="outline"
              className={
                voiceEngine === 'gemini-live'
                  ? 'text-brand'
                  : voiceEngine === 'web-speech'
                    ? 'text-accent'
                    : 'text-muted-foreground'
              }
            >
              {voiceEngine === 'gemini-live' ? '⚡ Gemini Live' : voiceEngine === 'web-speech' ? '🔄 Web Speech' : '🎙️ Voice off'}
            </Badge>
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
              <Button
                variant="secondary"
                onClick={() => void togglePause()}
                disabled={toggling}
                aria-label={snap.paused ? 'Resume the session' : 'Pause the session'}
                className="min-h-12 text-base font-semibold"
              >
                {snap.paused ? '▶ Resume' : '⏸ Pause'}
              </Button>
            )}
            <Button asChild className="min-h-12 bg-accent text-accent-foreground text-base font-semibold shadow-sm hover:bg-accent-hover">
              <Link href="/cook">{snap.paused ? 'Open session' : 'Resume cooking →'}</Link>
            </Button>
          </div>
        </Card>
      )}

      <section className={styles.quickStart} aria-labelledby="quick-start-title">
        <div className={styles.quickStartIntro}>
          <Badge variant="outline">Your kitchen, at a glance</Badge>
          <h2 id="quick-start-title" className={styles.quickStartTitle}>Everything you need before the first chop.</h2>
          <p className={styles.quickStartText}>Start with what you have, revisit a saved recipe, or keep your pantry organized while Cook With Me handles the next step.</p>
        </div>
        <div className={styles.quickStartGrid}>
          <Button asChild variant="outline" className={styles.quickStartCard}>
            <Link href="/cook">
              <span className={styles.quickStartIcon} aria-hidden="true">👨‍🍳</span>
              <span><strong>Cook from ingredients</strong><small>Tell me what you have</small></span>
              <span aria-hidden="true">→</span>
            </Link>
          </Button>
          <Button asChild variant="outline" className={styles.quickStartCard}>
            <Link href="/recipes">
              <span className={styles.quickStartIcon} aria-hidden="true">📖</span>
              <span><strong>Open your recipes</strong><small>Pick up a saved favorite</small></span>
              <span aria-hidden="true">→</span>
            </Link>
          </Button>
          <Button asChild variant="outline" className={styles.quickStartCard}>
            <Link href="/kitchen">
              <span className={styles.quickStartIcon} aria-hidden="true">🧺</span>
              <span><strong>Check your kitchen</strong><small>Pantry and grocery list</small></span>
              <span aria-hidden="true">→</span>
            </Link>
          </Button>
        </div>
      </section>

      <section className={styles.features} aria-label="Features">
        {FEATURES.map((f, i) => (
          <Card
            key={f.title}
            className={cn(
              'gap-1.5 rounded-l-none border-l-[3px] p-6 shadow-xs hover:border-border-strong hover:shadow-sm',
              i === 0 ? 'border-l-mauve' : i === 1 ? 'border-l-brand' : 'border-l-accent',
            )}
          >
            <span className="text-[1.6rem]" aria-hidden="true">{f.icon}</span>
            <h2 className="font-display text-lg font-semibold">{f.title}</h2>
            <p className="text-sm leading-relaxed text-text-secondary">{f.text}</p>
          </Card>
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
