'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import ConstraintDetails from './ConstraintDetails';
import { CookScreen } from '@/components/CookScreen';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { useVoiceSession } from '@/lib/hooks/useVoiceSession';
import { useCookingSession } from '@/lib/hooks/useCookingSession';

export default function CookPage() {
  const router = useRouter();
  // The API routes require a Bearer Firebase ID token. Real sign-in happens
  // on /login; /cook is protected — signed-out visitors are sent there.
  const auth = useAuthSession();
  const cook = useCookingSession({ getToken: auth.getToken });
  const voice = useVoiceSession({ getToken: auth.getToken });
  const [input, setInput] = useState('');
  const snap = cook.snapshot;

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

  // Keep the screen in sync with voice-driven changes (e.g. "done" spoken).
  useEffect(() => {
    if (voice.transcript.length > 0) {
      void cook.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.transcript.length]);

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
              type="submit"
              className={styles.starterBtn}
              disabled={starter.creating || starter.starting || starter.prompt.trim().length === 0}
            >
              {starter.creating ? 'Creating…' : '✨ Create my recipe'}
            </button>
          </form>
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
                      <p className={styles.recipeMeta}>
                        {r.servings > 1 ? `${r.servings} servings · ` : ''}
                        {r.totalMinutes} min · {r.ingredientCount} ingredients
                        {r.preferences?.dietaryRestrictions?.length
                          ? ` · ${r.preferences.dietaryRestrictions.join(', ')}`
                          : ''}
                        {r.preferences?.allergies?.length
                          ? ` · no ${r.preferences.allergies.join(', no ')}`
                          : ''}
                      </p>
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

  return (
    <CookScreen
      snapshot={snap}
      error={cook.error}
      alert={cook.alert}
      // The turn transcript, surfaced on screen — without this the user only
      // HEARS responses and the screen can look stuck at "One moment…" even
      // though the agent answered. The last reply is shown large; older turns
      // are re-readable in the scrollable transcript.
      turns={voice.transcript}
      voiceStatus={voice.status}
      onDone={() => void cook.done()}
      onRepeat={() => void cook.repeat()}
      onBack={() => void cook.back()}
      onResume={() => void cook.resume()}
      onStartOver={() => void cook.startOver()}
      onDismissAlert={cook.dismissAlert}
      onSend={(text) => {
        void voice.send(text);
        setInput('');
      }}
    />
  );
}
