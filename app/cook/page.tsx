'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import ConstraintDetails from './ConstraintDetails';
import RecipeRowMeta from './RecipeRowMeta';
import { CookScreen } from '@/components/CookScreen';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';
import { useVoiceInput } from '@/lib/hooks/useVoiceInput';
import { useGeminiLive, shouldAutoFallbackToWebSpeech } from '@/lib/hooks/useGeminiLive';
import { useLiveDictation } from '@/lib/hooks/useLiveDictation';
import { useCookingSession } from '@/lib/hooks/useCookingSession';

export default function CookPage() {
  const router = useRouter();
  // The API routes require a Bearer Firebase ID token. Real sign-in happens
  // on /login; /cook is protected — signed-out visitors are sent there.
  const auth = useAuthSession();
  const cook = useCookingSession({ getToken: auth.getToken });
  const voice = useVoiceSession({ getToken: auth.getToken });
  // Real microphone → speech-to-text at the edge; the final transcript flows
  // through the SAME voice.send() path as typed text (the backend is untouched).
  const voiceInput = useVoiceInput({
    onFinal: (text) => {
      void voice.send(text);
    },
  });
  // First-party voice (Gemini Live) when the browser can do Web Audio; the
  // Web Speech mic stays as the fallback. Live receives the current session
  // context so its system instruction matches what the orchestrator would see.
  // The recipe STARTER has its own dictation mic (Gemini Live, no tools):
  // speaking the ingredient brain-dump fills the starter input for review,
  // before anything is created. Typed input stays the fallback.
  const dictation = useLiveDictation({
    getToken: auth.getToken,
    onFinal: (text) =>
      setStarter((s) => ({
        ...s,
        prompt: s.prompt.trim() ? `${s.prompt.trim()} ${text.trim()}` : text.trim(),
      })),
  });
  const live = useGeminiLive({
    getToken: auth.getToken,
    systemContext: {
      currentPhase: cook.snapshot?.phase,
      currentStep:
        cook.snapshot?.stepNumber && cook.snapshot?.totalSteps
          ? `${cook.snapshot.phase.toLowerCase().replace(/_/g, ' ')} step ${cook.snapshot.stepNumber} of ${cook.snapshot.totalSteps}`
          : undefined,
      activeTimerIds: cook.snapshot?.activeTimers.map((t) => t.timerId),
    },
  });
  const [input, setInput] = useState('');
  const snap = cook.snapshot;
  // Prefer Gemini Live, but fall through to Web Speech when it errors out
  // (e.g. token endpoint unavailable) instead of leaving the mic dead.
  const useLiveMic = live.available && live.status !== 'ERROR';

  // Auto-fallback on the SAME tap: when the user tapped the Gemini mic and it
  // hard-fails (missing key, blocked WebSocket, connect timeout), start the
  // Web Speech fallback immediately and keep the failure reason visible.
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const geminiTapRef = useRef(false);
  const fellBackRef = useRef(false);

  // Which voice engine the mic uses — surfaced as a small on-screen badge (and
  // logged once per load) so a session that landed on the Web Speech fallback
  // is diagnosable at a glance instead of silently behaving differently.
  const voiceEngine: 'gemini-live' | 'web-speech' | 'none' = useLiveMic
    ? 'gemini-live'
    : voiceInput.supported
      ? 'web-speech'
      : 'none';

  useEffect(() => {
    console.info(`[voice] engine: ${voiceEngine}`);
  }, [voiceEngine]);

  // Hard-fail to the Web Speech fallback faster: a Gemini tap that fails
  // (missing key, blocked WebSocket, connect timeout) immediately continues
  // into the built-in fallback on the SAME tap, and the reason stays visible
  // in the error banner instead of a silent drop. Guarded so it fires once
  // per manual tap and never for mid-session drops.
  useEffect(() => {
    if (
      !shouldAutoFallbackToWebSpeech({
        geminiTapped: geminiTapRef.current,
        alreadyFellBack: fellBackRef.current,
        liveStatus: live.status,
        liveMode: live.mode,
        webSpeechSupported: voiceInput.supported,
      })
    ) {
      return;
    }
    geminiTapRef.current = false;
    fellBackRef.current = true;
    setFallbackNotice(live.error ?? 'Gemini Live could not start — using the built-in speech fallback instead.');
    void voiceInput.toggle();
  }, [live.status, live.mode, live.error, voiceInput]);

  // Recipe-starter state (the "start from scratch" stage): the user tells us
  // what they have, the agent generates + validates a recipe, then "Start
  // cooking" launches it. Before this the empty state was a dead end — the
  // only path into a session was an already-existing recipeId.
  const [starter, setStarter] = useState<{
    prompt: string;
    creating: boolean;
    error: string | null;
    ready: {
      recipeId: string;
      title: string;
      servings: number;
      confirmations: string[];
      preferences: { servings: number | null; allergies: string[]; dietaryRestrictions: string[] };
    } | null;
    starting: boolean;
  }>({ prompt: '', creating: false, error: null, ready: null, starting: false });

  // "Your recipes": the owner's generated recipes, reusable with one tap on
  // the starter. Only shown when there ARE recipes — a fresh user sees the
  // creation form alone, not an empty box.
  interface RecipeSummary {
    recipeId: string;
    title: string;
    servings: number;
    totalMinutes: number;
    ingredientCount: number;
    // What the recipe was built for. Optional so a stale deployed API (before
    // this field shipped) never crashes the row render.
    preferences?: {
      servings: number | null;
      allergies: string[];
      dietaryRestrictions: string[];
    };
    updatedAt: number;
  }
  const [recipes, setRecipes] = useState<{ status: 'loading' | 'ready' | 'error'; items: RecipeSummary[] }>({
    status: 'loading',
    items: [],
  });
  const [startingId, setStartingId] = useState<string | null>(null);

  const fetchRecipes = useCallback(async () => {
    try {
      const token = await auth.getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'list_recipes' }),
      });
      const body = (await res.json()) as { success: boolean; data?: { recipes: RecipeSummary[] } };
      if (!res.ok || !body.success || !body.data) {
        setRecipes({ status: 'error', items: [] });
        return;
      }
      setRecipes({ status: 'ready', items: body.data.recipes });
    } catch {
      setRecipes({ status: 'error', items: [] });
    }
  }, [auth]);

  // Fetch the list whenever the starter (no active session) is on screen.
  useEffect(() => {
    if (cook.loading || snap?.found) return;
    void fetchRecipes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cook.loading, snap?.found, fetchRecipes]);

  const handleCreateRecipe = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || starter.creating || starter.starting) return;
    setStarter({ prompt: trimmed, creating: true, error: null, ready: null, starting: false });
    try {
      const token = await auth.getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'create_recipe', prompt: trimmed }),
      });
      const body = (await res.json()) as {
        success: boolean;
        data?: {
          recipeId: string;
          title: string;
          servings: number;
          preferences: { servings: number | null; allergies: string[]; dietaryRestrictions: string[] };
          validation: { valid: boolean; errors: string[]; confirmations: string[] };
        };
        error?: { message?: string };
      };
      if (!res.ok || !body.success || !body.data) {
        setStarter({ prompt: trimmed, creating: false, error: body.error?.message ?? `Could not create the recipe (${res.status})`, ready: null, starting: false });
        return;
      }
      const { validation } = body.data;
      if (!validation.valid) {
        setStarter({
          prompt: trimmed,
          creating: false,
          error: `The recipe needs a few fixes before it is ready: ${validation.errors.join(' ')}`,
          ready: null,
          starting: false,
        });
        return;
      }
      setStarter({
        prompt: trimmed,
        creating: false,
        error: null,
        ready: {
          recipeId: body.data.recipeId,
          title: body.data.title,
          servings: body.data.servings,
          confirmations: validation.confirmations,
          preferences: body.data.preferences,
        },
        starting: false,
      });
      // Keep "Your recipes" current — the just-created recipe is now reusable.
      void fetchRecipes();
    } catch (e) {
      setStarter({
        prompt: trimmed,
        creating: false,
        error: e instanceof Error ? e.message : 'Could not create the recipe.',
        ready: null,
        starting: false,
      });
    }
  };

  const handleStartCooking = async () => {
    if (!starter.ready || starter.starting) return;
    setStarter((s) => ({ ...s, starting: true }));
    await cook.launch(starter.ready.recipeId);
    // cook.launch swaps the snapshot — the CookScreen takes over from here.
  };

  // One-tap relaunch of a saved recipe from the "Your recipes" list.
  const handleStartSavedRecipe = async (recipeId: string) => {
    if (startingId) return;
    setStartingId(recipeId);
    await cook.launch(recipeId);
    setStartingId(null);
  };

  // Protect the route: once auth settles with no user, go sign in.
  useEffect(() => {
    if (auth.state === 'ready' && !auth.user) {
      router.replace('/login');
    }
  }, [auth.state, auth.user, router]);

  // Keep the screen in sync with voice-driven changes (e.g. "done" spoken) —
  // whether the turn came through /api/agent (typed/Web Speech) or the Live
  // session (tool-driven state changes like pantry adds / step completion).
  useEffect(() => {
    if (voice.transcript.length > 0 || live.turns.length > 0) {
      void cook.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript.length, live.turns.length]);

  // While the mic is live, the indicator must honestly say LISTENING (the
  // recognition is capturing, not yet processing an utterance).
  useEffect(() => {
    if (voiceInput.listening) {
      voice.setStatus('LISTENING');
    }
  }, [voiceInput.listening, voice.setStatus]);

  // Live-mode caption: no interim transcripts come from the Live API, so the
  // caption reflects the honest capture/thinking state instead. When the
  // watchdog fires (listening but nothing heard for a while), the caption
  // says so instead of a frozen "Listening…" that looks stuck. The "tap to
  // stop" hint is rendered by the status line itself, so it is not repeated
  // here.
  const liveCaption =
    live.mode === 'live'
      ? live.awaiting
        ? 'Say something…'
        : live.status === 'LISTENING'
          ? 'Listening…'
          : live.status === 'THINKING'
            ? 'One moment…'
            : ''
      : '';
  const liveVoiceStatus = live.mode !== 'off' ? (live.status === 'IDLE' ? 'LISTENING' : live.status) : voice.status;

  // Wait for the auth settle first, so the screen never flashes content for
  // a signed-out visitor before the redirect to /login fires.
  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your cooking session…</p>
      </main>
    );
  }

  if (auth.state === 'ready' && !auth.user) {
    // Redirecting to the login page — never render cooking UI signed out.
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Signing you in…</p>
      </main>
    );
  }

  if (auth.error) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>Cook With Me</h1>
          <p className={styles.emptyText}>{auth.error}</p>
          <Link href="/" className={styles.primaryBtn}>
            ← Back to start
          </Link>
        </section>
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
            {cook.error ??
              "Let's cook. Tell me what you have (e.g. chicken, rice and onion) and I'll create a validated recipe — then we start cooking, step by step."}
          </p>
          <form
            className={styles.starterForm}
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateRecipe(starter.prompt);
            }}
          >
            <div className={styles.starterMicRow}>
              <input
                className={styles.starterInput}
                value={starter.prompt}
                onChange={(e) => setStarter((s) => ({ ...s, prompt: e.target.value }))}
                placeholder="e.g. chicken, rice and onion — for 4, no peanuts, vegetarian"
                aria-label="What do you have to cook with?"
                autoFocus
                disabled={starter.creating || starter.starting}
              />
              <button
                type="button"
                className={`${styles.micBtn} ${dictation.listening ? styles.micListening : ''}`}
                onClick={dictation.toggle}
                disabled={!dictation.available || starter.creating || starter.starting}
                aria-label={dictation.listening ? 'Stop listening' : 'Speak your ingredients'}
                aria-pressed={dictation.listening}
                title={
                  dictation.available
                    ? dictation.listening
                      ? 'Tap to stop listening'
                      : 'Tap, speak your ingredients — they land in the input for review'
                    : 'Live voice not supported in this browser — type instead'
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
            </div>
            <button
              type="submit"
              className={styles.starterBtn}
              disabled={starter.creating || starter.starting || starter.prompt.trim().length === 0}
            >
              {starter.creating ? 'Creating…' : '✨ Create my recipe'}
            </button>
            {dictation.listening && (
              <p
                className={styles.micStatus}
                role="status"
                aria-live="polite"
                data-hearing={dictation.hearing ? 'true' : 'false'}
              >
                <span
                  className={dictation.hearing ? styles.micStatusDotHearing : styles.micStatusDot}
                  aria-hidden="true"
                />
                <span>🎙 {dictation.hearing ? 'Hearing you…' : 'Listening… speak your ingredients'}</span>
              </p>
            )}
            {dictation.error && (
              <div className={styles.micError} role="alert">
                <span>{dictation.error}</span>
                <button className={styles.alertClose} onClick={dictation.clearError} aria-label="Dismiss microphone error">
                  ×
                </button>
              </div>
            )}
          </form>
          {dictation.available && (
            <span
              className={`${styles.voiceEngineBadge} ${styles.voiceEngineBadgeLive}`}
              data-engine="gemini-live"
            >
              ⚡ Gemini Live
            </span>
          )}
          {starter.error && (
            <p className={styles.starterError} role="alert">
              {starter.error}
            </p>
          )}
          {starter.ready && (
            <div className={styles.starterReady}>
              <p className={styles.starterReadyText}>
                <strong>{starter.ready.title}</strong>
                {starter.ready.servings > 1 ? ` · ${starter.ready.servings} servings` : ''}
                {starter.ready.preferences.dietaryRestrictions.length > 0
                  ? ` · ${starter.ready.preferences.dietaryRestrictions.join(', ')}`
                  : ''}
                {starter.ready.preferences.allergies.length > 0
                  ? ` · no ${starter.ready.preferences.allergies.join(', no ')}`
                  : ''}
                {starter.ready.confirmations.length > 0
                  ? ` · you will also need: ${starter.ready.confirmations.join(', ')}`
                  : ''}
              </p>
              <ConstraintDetails preferences={starter.ready.preferences} />
              <button
                className={styles.primaryBtn}
                onClick={() => void handleStartCooking()}
                disabled={starter.starting}
                aria-label="Start cooking the created recipe"
              >
                {starter.starting ? 'Starting…' : '▶ Start cooking'}
              </button>
            </div>
          )}
          {recipes.status === 'ready' && recipes.items.length > 0 && (
            <section className={styles.recipesSection} aria-label="Your recipes">
              <h2 className={styles.recipesTitle}>Your recipes</h2>
              <ul className={styles.recipesList}>
                {recipes.items.map((r) => (
                  <li key={r.recipeId} className={styles.recipeCard}>
                    <div className={styles.recipeInfo}>
                      <p className={styles.recipeName}>{r.title}</p>
                      <RecipeRowMeta
                        servings={r.servings}
                        totalMinutes={r.totalMinutes}
                        ingredientCount={r.ingredientCount}
                        preferences={r.preferences}
                      />
                    </div>
                    <button
                      type="button"
                      className={styles.recipeStart}
                      onClick={() => void handleStartSavedRecipe(r.recipeId)}
                      disabled={startingId !== null}
                      aria-label={`Start cooking ${r.title}`}
                    >
                      {startingId === r.recipeId ? 'Starting…' : '▶ Start cooking'}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Link href="/" className={styles.backLink}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  // One-click "copy voice details": whatever the active mic engine (Gemini
  // Live or the Web Speech fallback), the blob carries the hook + client
  // session state plus browser capabilities, so a dropped mic can be shared
  // for diagnosis without console access. Both engines are included — the
  // fallback state matters even when the user is on Gemini.
  const copyMicDiagnostics = useCallback(() => {
    return JSON.stringify(
      {
        active: useLiveMic ? 'gemini-live' : 'web-speech',
        capturedAt: new Date().toISOString(),
        gemini: live.getDiagnostics(),
        webSpeech: {
          supported: voiceInput.supported,
          listening: voiceInput.listening,
          interim: voiceInput.interim,
          error: voiceInput.error ?? null,
        },
      },
      null,
      2,
    );
  }, [useLiveMic, live, voiceInput]);

  return (
    <CookScreen
      snapshot={snap}
      error={cook.error}
      alert={cook.alert}
      // The turn transcript, surfaced on screen — without this the user only
      // HEARS responses and the screen can look stuck at "One moment…" even
      // though the agent answered. The last reply is shown large; older turns
      // are re-readable in the scrollable transcript.
      turns={[...voice.transcript, ...live.turns]}
      voiceStatus={liveVoiceStatus}
      micSupported={useLiveMic ? true : voiceInput.supported}
      micListening={useLiveMic ? live.mode !== 'off' : voiceInput.listening}
      micInterim={useLiveMic ? liveCaption : voiceInput.interim}
      micHearing={useLiveMic ? live.hearing : false}
      voiceEngine={voiceEngine}
      micError={useLiveMic ? live.error : (fallbackNotice ?? voiceInput.error)}
      onMicToggle={
        useLiveMic
          ? () => {
              // A fresh manual tap re-arms the one-shot auto-fallback.
              geminiTapRef.current = true;
              fellBackRef.current = false;
              setFallbackNotice(null);
              void live.toggle();
            }
          : voiceInput.toggle
      }
      onMicErrorClear={
        useLiveMic
          ? live.clearError
          : () => {
              voiceInput.clearError();
              setFallbackNotice(null);
            }
      }
      onCopyDiagnostics={copyMicDiagnostics}
      onDone={() => void cook.done()}
      onRepeat={() => void cook.repeat()}
      onBack={() => void cook.back()}
      onResume={() => void cook.resume()}
      onStartOver={() => void cook.startOver()}
      onDismissAlert={cook.dismissAlert}
      onSend={(text) => {
        // While a Live session is open, typed input flows into the SAME
        // realtime conversation; otherwise it uses the /api/agent path.
        if (live.mode === 'live') live.sendText(text);
        else void voice.send(text);
        setInput('');
      }}
    />
  );
}
