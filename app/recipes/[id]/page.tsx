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
import { VoiceInputButton } from '@/components/VoiceInputButton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import RecipeRowMeta from '../../cook/RecipeRowMeta';
import { scaleRecipe } from '../recipe-scaler';
import { parseServings } from '../servings-parser';
import { formatIngredientQuantityPrefix, formatIngredientNameSuffix } from '@/lib/recipe/format';
import { RecipeReadAloudButton, RecipeReadAll } from './RecipeReadAloudButton';
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

/**
 * Compose the read-aloud text for a step: the model's spoken instruction
 * (numbers already written as words) plus its time, temperature/heat, and
 * safety note, so read-aloud mirrors what a helper would say.
 */
type ReadableStep = {
  spokenInstruction: string;
  estimatedSeconds?: number;
  timerSeconds?: number;
  temperature?: number;
  temperatureUnit?: 'C' | 'F';
  heatLevel?: string;
  safetyNote?: string;
};

const stepReadText = (step: ReadableStep): string => {
  const parts = [step.spokenInstruction];
  if (step.estimatedSeconds != null) parts.push(`Time ${formatSeconds(step.estimatedSeconds)}.`);
  if (step.timerSeconds != null) parts.push(`Timer ${formatSeconds(step.timerSeconds)}.`);
  if (step.temperature != null) parts.push(`${step.temperature} degrees ${step.temperatureUnit ?? 'C'}.`);
  if (step.heatLevel) parts.push(step.heatLevel);
  if (step.safetyNote) parts.push(step.safetyNote);
  return parts.join(' ');
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
  // null = render the stored recipe as-is (factor 1). Setting it to a
  // different 1–24 count produces the scaled display copy below.
  const [targetServings, setTargetServings] = useState<number | null>(null);

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
      setTargetServings(null);
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
          <Button asChild variant="ghost" className="text-[#7aa2f7] hover:text-[#7aa2f7]">
            <Link href="/">← Back to start</Link>
          </Button>
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
            <Button asChild className="mt-3 bg-[#2f6f4f] text-white hover:bg-[#3a8a5f] hover:text-white">
              <Link href="/recipes">← Back to my recipes</Link>
            </Button>
          ) : (
            <Button type="button" className="mt-3 bg-[#2f6f4f] text-white hover:bg-[#3a8a5f] hover:text-white" onClick={() => void fetchRecipe()}>
              Try again
            </Button>
          )}
        </section>
      </main>
    );
  }

  const { recipe } = state;
  const preferences = recipe.preferences ?? { servings: recipe.servings, allergies: [], dietaryRestrictions: [] };
  const servings = targetServings ?? recipe.servings;
  const scaled = targetServings !== null && targetServings !== recipe.servings;
  // Display copy: only ingredient quantities and the serving count change;
  // the stored recipe (and the Start handoff) always stay the base.
  const displayRecipe = scaled ? scaleRecipe(recipe, servings) : recipe;
  const decrementServings = () => setTargetServings(Math.max(1, (targetServings ?? recipe.servings) - 1));
  const incrementServings = () => setTargetServings(Math.min(24, (targetServings ?? recipe.servings) + 1));
  const readAllTexts = [
    ...displayRecipe.prepSteps.map(stepReadText),
    ...displayRecipe.cookingSteps.map(stepReadText),
    // Recipe-level safety notes live outside the step lists but are still
    // spoken safety output (spec 0004 §Safety warnings), so Read all speaks
    // them too, not only per-step notes.
    ...displayRecipe.safetyNotes.map((note) => `Safety note: ${note}`),
  ];

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 text-[#7aa2f7] hover:bg-white/10 hover:text-[#7aa2f7]">
          <Link href="/recipes" aria-label="Back to my recipes">←</Link>
        </Button>
        <div className={styles.headerText}>
          <h1 className={styles.title}>{recipe.title}</h1>
          <RecipeRowMeta
            servings={recipe.servings}
            totalMinutes={recipe.totalMinutes}
            ingredientCount={recipe.ingredients.length}
            preferences={preferences}
          />
          <div className={styles.scaler}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 border-[#333] bg-[#222] text-[#e8e8e8] hover:bg-[#2c2c2c] hover:text-[#e8e8e8]"
              onClick={decrementServings}
              disabled={servings <= 1}
              aria-label="Decrease servings"
            >
              −
            </Button>
            <span className={styles.servingsLabel}>
              {servings} {servings === 1 ? 'serving' : 'servings'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 border-[#333] bg-[#222] text-[#e8e8e8] hover:bg-[#2c2c2c] hover:text-[#e8e8e8]"
              onClick={incrementServings}
              disabled={servings >= 24}
              aria-label="Increase servings"
            >
              +
            </Button>
            <VoiceInputButton
              aria-label="Speak servings"
              onTranscript={(text) => {
                const n = parseServings(text);
                if (n !== null) setTargetServings(n);
              }}
            />
          </div>
          {scaled && (
            <p className={styles.scaleCaption}>
              Scaled from {recipe.servings} to {servings} {servings === 1 ? 'serving' : 'servings'}
            </p>
          )}
        </div>
      </header>

      {/* The recipe's own model-derived tags and allergens — separate from
          preferences (what the user asked for), and present even on older
          recipes that have no preferences (spec 0003 Q1). `allergens` are what
          the recipe CONTAINS, so they are labelled "contains X"; the "no X"
          wording belongs to preferences.allergies (rendered by RecipeRowMeta),
          which is what the user asked to avoid. */}
      {(recipe.dietaryTags.length > 0 || recipe.allergens.length > 0) && (
        <div className={styles.tags} aria-label="Dietary tags and allergens">
          {recipe.dietaryTags.map((tag) => (
            <Badge key={tag} variant="outline" className="rounded-full border-[#333] bg-[#222] text-[#9ecbff]">{tag}</Badge>
          ))}
          {recipe.allergens.map((a) => (
            <Badge key={a} variant="outline" className="rounded-full border-[#5a2a2a] bg-[#3a1d1d] text-[#ffb4b4]">contains {a}</Badge>
          ))}
        </div>
      )}

      {startError && (
        <div className={styles.errorNote} role="alert">
          {startError}
        </div>
      )}

      <Button
        type="button"
        className="mb-6 w-full min-h-12 bg-[#2f6f4f] text-white hover:bg-[#3a8a5f] hover:text-white"
        onClick={() => void handleStart()}
        disabled={starting}
      >
        {starting ? 'Starting…' : '▶ Start cooking'}
      </Button>

      <section className={styles.section} aria-label="Ingredients">
        <h2 className={styles.sectionTitle}>Ingredients</h2>
        <ul className={styles.list}>
          {displayRecipe.ingredients.map((ing) => (
            <li key={ing.id} className={styles.ingredient}>
              <span className={styles.quantity}>{formatIngredientQuantityPrefix(ing)}</span>
              <span className={styles.name}>{formatIngredientNameSuffix(ing)}</span>
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
                <RecipeReadAloudButton
                  phase="prep"
                  stepNumber={step.stepNumber}
                  text={stepReadText(step)}
                />
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
                    <Badge variant="outline" className="rounded-full border-[#333] bg-[#222] text-[#9ecbff]">{formatSeconds(step.estimatedSeconds)}</Badge>
                  )}
                  {step.timerSeconds != null && (
                    <Badge variant="outline" className="rounded-full border-[#333] bg-[#222] text-[#9ecbff]">⏱ {formatSeconds(step.timerSeconds)}</Badge>
                  )}
                  {step.temperature != null && (
                    <Badge variant="outline" className="rounded-full border-[#333] bg-[#222] text-[#9ecbff]">{step.temperature}&deg;{step.temperatureUnit ?? 'C'}</Badge>
                  )}
                  {step.heatLevel && <Badge variant="outline" className="rounded-full border-[#333] bg-[#222] text-[#9ecbff]">{step.heatLevel}</Badge>}
                </span>
                {step.safetyNote && <p className={styles.safetyNote}>⚠ {step.safetyNote}</p>}
                <RecipeReadAloudButton
                  phase="cooking"
                  stepNumber={step.stepNumber}
                  text={stepReadText(step)}
                />
              </li>
            ))}
          </ol>
        </section>
      )}

      {readAllTexts.length > 0 && <RecipeReadAll texts={readAllTexts} />}

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
