'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /recipes/[id] — read a saved recipe in full.
//
// The "My Recipes" browser (app/recipes/page.tsx) lists lightweight summaries
// and can only launch; this page is the reader: click a row title, see the
// whole generated recipe (ingredients with prep, equipment, prep + cooking
// steps with timers/temperatures/safety notes), and Start cooking from it.
// Reads go through /api/cook's get_recipe (never a client-side Firestore
// query); launching uses the same launch action the list rows use.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { appCheckHeaders } from '@/lib/firebase/app-check';
import RecipeRowMeta from '../../cook/RecipeRowMeta';
import type { Recipe } from '@/lib/domain/types';

type RecipeState =
  | { status: 'loading' }
  | { status: 'ready'; recipe: Recipe }
  | { status: 'error'; message: string };

const formatSeconds = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
};

export default function RecipeDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const recipeId = params.id;
  const auth = useAuthSession();
  const getToken = auth.getToken;

  const [state, setState] = useState<RecipeState>({ status: 'loading' });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const fetchRecipe = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const token = await getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(await appCheckHeaders()) },
        body: JSON.stringify({ action: 'get_recipe', recipeId }),
      });
      const body = (await res.json()) as { success: boolean; data?: { recipe: Recipe }; error?: { code?: string; message?: string } };
      if (res.status === 404 || body.error?.code === 'NOT_FOUND') {
        // Missing or not owned — the server returns the same NOT_FOUND.
        setState({ status: 'error', message: 'Recipe not found' });
        return;
      }
      if (!res.ok || !body.success || !body.data) {
        setState({ status: 'error', message: `Could not load this recipe (${res.status}).` });
        return;
      }
      setState({ status: 'ready', recipe: body.data.recipe });
    } catch {
      setState({ status: 'error', message: 'Could not load this recipe.' });
    }
  }, [getToken, recipeId]);

  useEffect(() => {
    if (auth.state !== 'ready' || !auth.user) return;
    void fetchRecipe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.state, auth.user, fetchRecipe]);

  // Protect the route: once auth settles with no user, go sign in.
  useEffect(() => {
    if (auth.state === 'ready' && !auth.user) {
      router.replace('/login');
    }
  }, [auth.state, auth.user, router]);

  // Start cooking, then hand off to /cook (which shows the active session
  // this launch just created) — the same handoff the /recipes rows use.
  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(await appCheckHeaders()) },
        body: JSON.stringify({ action: 'launch', recipeId }),
      });
      const body = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !body.success) {
        setStartError(body.error?.message ?? `Could not start cooking (${res.status})`);
        return;
      }
      router.push('/cook');
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Could not start cooking.');
    } finally {
      setStarting(false);
    }
  };

  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading recipe…</p>
      </main>
    );
  }

  if (auth.state === 'ready' && !auth.user) {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Signing you in…</p>
      </main>
    );
  }

  // Auth initialization failed (e.g. missing client config): neither effect
  // fetches or redirects, so render the actionable error instead of the
  // infinite loading state — the same branch /recipes and /kitchen render.
  if (auth.error) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>Could not load this recipe</h1>
          <p className={styles.emptyText}>{auth.error}</p>
          <Link href="/" className={styles.primaryBtn}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  if (state.status === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading recipe…</p>
      </main>
    );
  }

  if (state.status === 'error') {
    const notFound = state.message === 'Recipe not found';
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>{notFound ? 'Recipe not found' : 'Could not load this recipe'}</h1>
          <p className={styles.emptyText}>
            {notFound ? 'This recipe does not exist or is not yours to view.' : state.message}
          </p>
          {notFound ? (
            <Link href="/recipes" className={styles.primaryBtn}>
              ← Back to my recipes
            </Link>
          ) : (
            <button type="button" className={styles.primaryBtn} onClick={() => void fetchRecipe()}>
              Try again
            </button>
          )}
        </section>
      </main>
    );
  }

  const { recipe } = state;
  const preferences = recipe.preferences ?? { servings: recipe.servings, allergies: [], dietaryRestrictions: [] };

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/recipes" className={styles.backLink} aria-label="Back to my recipes">
          ←
        </Link>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{recipe.title}</h1>
          <RecipeRowMeta
            servings={recipe.servings}
            totalMinutes={recipe.totalMinutes}
            ingredientCount={recipe.ingredients.length}
            preferences={preferences}
          />
        </div>
      </header>

      {/* The recipe's own model-derived tags and allergens — separate from
          preferences (what the user asked for), and present even on older
          recipes that have no preferences (spec 0003 Q1). */}
      {(recipe.dietaryTags.length > 0 || recipe.allergens.length > 0) && (
        <div className={styles.tags} aria-label="Dietary tags and allergens">
          {recipe.dietaryTags.map((tag) => (
            <span key={tag} className={styles.badge}>{tag}</span>
          ))}
          {recipe.allergens.map((a) => (
            <span key={a} className={styles.allergenBadge}>no {a}</span>
          ))}
        </div>
      )}

      {startError && (
        <div className={styles.errorNote} role="alert">
          {startError}
        </div>
      )}

      <button type="button" className={styles.startBtn} onClick={() => void handleStart()} disabled={starting}>
        {starting ? 'Starting…' : '▶ Start cooking'}
      </button>

      <section className={styles.section} aria-label="Ingredients">
        <h2 className={styles.sectionTitle}>Ingredients</h2>
        <ul className={styles.list}>
          {recipe.ingredients.map((ing) => (
            <li key={ing.id} className={styles.ingredient}>
              <span className={styles.quantity}>
                {ing.quantity != null && ing.unit ? `${ing.quantity} ${ing.unit}` : ing.quantity != null ? String(ing.quantity) : ''}
              </span>
              <span className={styles.name}>
                {ing.name}
                {ing.preparation ? `, ${ing.preparation}` : ''}
                {ing.optional ? ' (optional)' : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {recipe.equipment.length > 0 && (
        <section className={styles.section} aria-label="Equipment">
          <h2 className={styles.sectionTitle}>Equipment</h2>
          <ul className={styles.list}>
            {recipe.equipment.map((eq) => (
              <li key={eq} className={styles.equipment}>{eq}</li>
            ))}
          </ul>
        </section>
      )}

      {recipe.prepSteps.length > 0 && (
        <section className={styles.section} aria-label="Prep steps">
          <h2 className={styles.sectionTitle}>Prep</h2>
          <ol className={styles.steps}>
            {recipe.prepSteps.map((step) => (
              <li key={step.id} className={styles.step}>
                <p className={styles.stepText}>{step.instruction}</p>
                <span className={styles.stepMeta}>{formatSeconds(step.estimatedSeconds)}</span>
                {(step.ingredientsUsed.length > 0 || step.equipmentUsed.length > 0) && (
                  <p className={styles.stepContext}>uses: {[...step.ingredientsUsed, ...step.equipmentUsed].join(', ')}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.cookingSteps.length > 0 && (
        <section className={styles.section} aria-label="Cooking steps">
          <h2 className={styles.sectionTitle}>Cooking</h2>
          <ol className={styles.steps}>
            {recipe.cookingSteps.map((step) => (
              <li key={step.id} className={styles.step}>
                <p className={styles.stepText}>{step.instruction}</p>
                <span className={styles.badges}>
                  {step.estimatedSeconds != null && (
                    <span className={styles.badge}>{formatSeconds(step.estimatedSeconds)}</span>
                  )}
                  {step.timerSeconds != null && (
                    <span className={styles.badge}>⏱ {formatSeconds(step.timerSeconds)}</span>
                  )}
                  {step.temperature != null && (
                    <span className={styles.badge}>{step.temperature}&deg;{step.temperatureUnit ?? 'C'}</span>
                  )}
                  {step.heatLevel && <span className={styles.badge}>{step.heatLevel}</span>}
                </span>
                {step.safetyNote && <p className={styles.safetyNote}>⚠ {step.safetyNote}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {recipe.safetyNotes.length > 0 && (
        <section className={styles.section} aria-label="Safety notes">
          <h2 className={styles.sectionTitle}>Safety notes</h2>
          <ul className={styles.list}>
            {recipe.safetyNotes.map((note) => (
              <li key={note} className={styles.safetyNote}>⚠ {note}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
