# Recipe Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only recipe detail page at `/recipes/[id]` so a user can read a full saved recipe (ingredients, equipment, prep + cooking steps, safety notes) and Start cooking from it.

**Architecture:** One new `get_recipe` action on the existing `/api/cook` POST dispatch, cloned from the `delete_recipe` case (owner check returns 404 NOT_FOUND). A new client page at `app/recipes/[id]/page.tsx` reads via that action (never a client-side Firestore query) and mirrors the `/recipes` page's auth, loading, error, and signed-out states. Row titles on `/recipes` become links to the detail page.

**Tech Stack:** Next.js 15 App Router, React client components with controlled `useState`, Vitest + Testing Library + jsdom, Zod-validated repository reads, Firebase auth via `useAuthSession` + App Check headers.

## Global Constraints

- Reads go through `/api/cook` actions only — never a client-side Firestore query (repo rule).
- Every API route resolves the Firebase ID token server side via `resolveUserId`; the client never supplies the user id.
- A user must never read (or launch) another user's recipe — ownership enforced server side, 404 for non-owner.
- Components use controlled inputs with `useState`, not `react-hook-form`.
- Component test files use the `// @vitest-environment jsdom` pragma; the default environment is `node`.
- Response shape for errors: `{ success: false, error: { code, message, recoverable: false } }` with the matching HTTP status.
- Landing is PR-only under the required checks (validate, Codex P1 gate, smoke on pushes); Codex findings are resolved by fix + reply `Resolved ...` on the thread.
- Design source: `docs/specs/0003-recipe-detail-page.md`. Read-only page: no edit, delete, scale, print, or share in scope.

---

### Task 1: `get_recipe` action on `/api/cook`

**Files:**
- Modify: `app/api/cook/route.ts` — add `'get_recipe'` to the `ACTIONS` array (lines 28–34) and add a `case 'get_recipe'` in the switch.
- Test: `app/api/cook/route.test.ts` — add a `describe('get_recipe — reading one saved recipe')` block.

**Interfaces:**
- Consumes: `recipeId` (already parsed at route.ts line 57), `ctx.recipeStore.getRecipe(id: string): Promise<Recipe | null>` (from `buildProductionContext`), `Recipe` type from `@/lib/domain/types`.
- Produces: POST `/api/cook` with body `{ action: 'get_recipe', recipeId }` →
  - `200 { success: true, data: { recipe } }` where `recipe` is the full stored `Recipe` (Zod-validated at the repository layer), or
  - `400 { error: { code: 'INVALID_BODY', message: 'get_recipe requires a recipeId' } }`, or
  - `404 { error: { code: 'NOT_FOUND', message: 'Recipe not found' } }` for a missing or non-owned recipe.

- [ ] **Step 1: Write the failing route tests**

Append this block to `app/api/cook/route.test.ts` (uses the existing `post`, `makeRecipe`, `testContext`, `ctx`, `InMemoryRecipeStore` helpers already in the file):

```ts
describe('get_recipe — reading one saved recipe', () => {
  it('returns 400 without a recipeId', async () => {
    const res = await post({ action: 'get_recipe' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('returns the owner\u2019s full recipe', async () => {
    const store = ctx.recipeStore as InMemoryRecipeStore;
    await store.createRecipe(makeRecipe());

    const res = await post({ action: 'get_recipe', recipeId: 'recipe-1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.recipe.title).toBe('Chicken Rice');
    expect(body.data.recipe.ingredients).toEqual(makeRecipe().ingredients);
    expect(body.data.recipe.prepSteps).toEqual(makeRecipe().prepSteps);
    expect(body.data.recipe.cookingSteps).toEqual(makeRecipe().cookingSteps);
    expect(body.data.recipe.safetyNotes).toEqual(['Hot oil']);
  });

  it('refuses to read another user\u2019s recipe (ownership is enforced)', async () => {
    const store = ctx.recipeStore as InMemoryRecipeStore;
    await store.createRecipe({ ...makeRecipe(), id: 'recipe-other', userId: 'user-2' });

    const res = await post({ action: 'get_recipe', recipeId: 'recipe-other' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // The other user's recipe survives untouched.
    expect(await store.getRecipe('recipe-other')).not.toBeNull();
  });

  it('returns 404 when the recipe does not exist', async () => {
    const res = await post({ action: 'get_recipe', recipeId: 'missing-recipe' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run: `npx vitest run app/api/cook/route.test.ts -t "get_recipe"`

Expected: FAIL — the tests fall through to the default action handling because `get_recipe` is not in `ACTIONS`, so the requests are treated as `status` and the assertions fail.

- [ ] **Step 3: Implement the `get_recipe` case**

In `app/api/cook/route.ts`, add `'get_recipe'` to the `ACTIONS` array:

```ts
const ACTIONS = [
  'launch', 'status', 'done', 'repeat', 'back', 'pause', 'resume', 'timers',
  'start_over', 'substitute', 'apply_substitution', 'correct', 'recover', 'clear_recovery',
  'create_recipe', 'list_recipes', 'get_recipe', 'delete_recipe',
] as const;
```

Add this case to the switch (next to `delete_recipe`, mirroring it exactly):

```ts
case 'get_recipe': {
  // Read one saved recipe in full — the detail page's read. Ownership is
  // verified HERE (never trust the id alone): a user must only ever read
  // their own recipe, the same rule delete_recipe and launchCookWithMe
  // enforce.
  if (!recipeId) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'get_recipe requires a recipeId', recoverable: false } },
      { status: 400 },
    );
  }
  const recipeStore = ctx.recipeStore;
  if (!recipeStore) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAVAILABLE', message: 'Recipe store not available', recoverable: false } },
      { status: 500 },
    );
  }
  const recipe = await recipeStore.getRecipe(recipeId);
  if (!recipe || recipe.userId !== userId) {
    return NextResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Recipe not found', recoverable: false } },
      { status: 404 },
    );
  }
  return NextResponse.json({ success: true, data: { recipe } });
}
```

Also update the `ACTIONS` doc comment at the top of the file (lines 4–6) to include `get_recipe`.

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `npx vitest run app/api/cook/route.test.ts`

Expected: PASS — all existing tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add app/api/cook/route.ts app/api/cook/route.test.ts
git commit -m "feat(api): add the get_recipe read to /api/cook (spec 0003)"
```

---

### Task 2: Recipe detail page `/recipes/[id]`

**Files:**
- Create: `app/recipes/[id]/page.tsx`
- Create: `app/recipes/[id]/page.module.css`
- Create: `app/recipes/[id]/page.test.tsx`

**Interfaces:**
- Consumes: POST `/api/cook` `{ action: 'get_recipe', recipeId }` (Task 1), `useAuthSession` from `@/lib/auth/useAuthSession`, `appCheckHeaders` from `@/lib/firebase/app-check`, `RecipeRowMeta` from `../../cook/RecipeRowMeta` (props: `servings`, `totalMinutes`, `ingredientCount`, `preferences?`), `Recipe` type from `@/lib/domain/types`.
- Produces: the `/recipes/[id]` route. Start posts `{ action: 'launch', recipeId }` and calls `router.push('/cook')` on success. `useParams<{ id: string }>().id` is the recipe id.

- [ ] **Step 1: Write the failing page test**

Create `app/recipes/[id]/page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecipeDetailPage from './page';
import type { Recipe } from '@/lib/domain/types';

const RECIPE: Recipe = {
  id: 'recipe-1',
  userId: 'user-1',
  title: 'Chicken Rice',
  description: 'Simple one-pan dinner',
  servings: 2,
  estimatedPrepMinutes: 10,
  estimatedCookMinutes: 25,
  totalMinutes: 35,
  ingredients: [
    { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', preparation: 'diced', optional: false },
    { id: 'i2', name: 'salt', quantity: null, unit: null, optional: true },
  ],
  equipment: ['pan', 'knife'],
  prepSteps: [
    { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
  ],
  cookingSteps: [
    { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, temperature: 180, temperatureUnit: 'C', heatLevel: 'medium-high', ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil' },
  ],
  dietaryTags: [],
  allergens: [],
  safetyNotes: ['Hot oil \u2014 keep children away'],
  generatedAt: 1000,
  updatedAt: 1000,
};

const push = vi.fn();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useParams: () => ({ id: 'recipe-1' }),
}));
vi.mock('@/lib/auth/useAuthSession', () => ({ useAuthSession: vi.fn() }));
vi.mock('@/lib/firebase/app-check', () => ({ appCheckHeaders: vi.fn(async () => ({})) }));

import { useAuthSession } from '@/lib/auth/useAuthSession';

const mockAuth = useAuthSession as ReturnType<typeof vi.fn>;
const base = { state: 'ready', user: { uid: 'user-1' }, getToken: async () => 'token', error: null };

function mockFetch({ notFound = false, fail = false } = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
    if (body.action === 'launch') {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.action === 'get_recipe') {
      if (notFound) {
        return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Recipe not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (fail) {
        return new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false }), { status: 500, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
});

describe('app/recipes/[id]/page.tsx · rendered behavior', () => {
  it('shows the loading gate while auth settles', () => {
    mockAuth.mockReturnValue({ ...base, state: 'loading' });
    render(<RecipeDetailPage />);
    expect(screen.getByText(/loading recipe/i)).toBeTruthy();
  });

  it('renders every section of the full recipe', async () => {
    const fetchMock = mockFetch();
    render(<RecipeDetailPage />);

    expect(await screen.findByText('Chicken Rice')).toBeTruthy();
    expect(screen.getByText(/2 servings/)).toBeTruthy();
    // ingredients: quantity + unit + name + prep + optional marker
    expect(screen.getByText('4 pieces')).toBeTruthy();
    expect(screen.getByText(/chicken thighs, diced/)).toBeTruthy();
    expect(screen.getByText(/salt \(optional\)/)).toBeTruthy();
    // equipment
    expect(screen.getByText('pan')).toBeTruthy();
    expect(screen.getByText('knife')).toBeTruthy();
    // prep step
    expect(screen.getByText('Dice the onion')).toBeTruthy();
    // cooking step: instruction, estimated time, timer, temperature, heat
    expect(screen.getByText(/sear the chicken 4 minutes/i)).toBeTruthy();
    expect(screen.getByText('4m 0s')).toBeTruthy();
    expect(screen.getByText('\u23f1 4m 0s')).toBeTruthy();
    expect(screen.getByText('180\u00b0C')).toBeTruthy();
    expect(screen.getByText('medium-high')).toBeTruthy();
    // step safety note and top-level safety note (distinct text)
    expect(screen.getByText('\u26a0 Hot oil')).toBeTruthy();
    expect(screen.getByText('\u26a0 Hot oil \u2014 keep children away')).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cook',
      expect.objectContaining({ body: JSON.stringify({ action: 'get_recipe', recipeId: 'recipe-1' }) }),
    );
  });

  it('starts cooking: posts launch and hands off to /cook', async () => {
    const fetchMock = mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    fireEvent.click(screen.getByRole('button', { name: /start cooking/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/cook'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cook',
      expect.objectContaining({ body: JSON.stringify({ action: 'launch', recipeId: 'recipe-1' }) }),
    );
  });

  it('shows Recipe not found with a back link when the server 404s', async () => {
    mockFetch({ notFound: true });
    render(<RecipeDetailPage />);
    expect(await screen.findByText('Recipe not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to my recipes/i })).toBeTruthy();
  });

  it('shows an error with working retry when the fetch fails', async () => {
    mockFetch({ fail: true });
    render(<RecipeDetailPage />);
    expect(await screen.findByText(/could not load this recipe/i)).toBeTruthy();

    mockFetch();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Chicken Rice')).toBeTruthy();
  });

  it('redirects to /login when signed out', () => {
    mockAuth.mockReturnValue({ ...base, user: null });
    render(<RecipeDetailPage />);
    expect(replace).toHaveBeenCalledWith('/login');
  });
});
```

- [ ] **Step 2: Run the page test to verify it fails**

Run: `npx vitest run app/recipes/[id]/page.test.tsx`

Expected: FAIL — the module `./page` does not exist yet.

- [ ] **Step 3: Implement the page**

Create `app/recipes/[id]/page.tsx`:

```tsx
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
                  <span className={styles.badge}>{formatSeconds(step.estimatedSeconds)}</span>
                  {step.timerSeconds != null && (
                    <span className={styles.badge}>&#9200; {formatSeconds(step.timerSeconds)}</span>
                  )}
                  {step.temperature != null && (
                    <span className={styles.badge}>{step.temperature}&deg;{step.temperatureUnit ?? 'C'}</span>
                  )}
                  {step.heatLevel && <span className={styles.badge}>{step.heatLevel}</span>}
                </span>
                {step.safetyNote && <p className={styles.safetyNote}>&#9888; {step.safetyNote}</p>}
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
              <li key={note} className={styles.safetyNote}>&#9888; {note}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
```

Create `app/recipes/[id]/page.module.css` (dark theme matching the other pages):

```css
.main {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  min-height: 100vh;
  background: #121212;
  color: #e8e8e8;
}

.centered {
  text-align: center;
  color: #aaa;
  padding: 48px 0;
}

.header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.backLink {
  color: #7aa2f7;
  text-decoration: none;
  font-size: 18px;
  line-height: 1.4;
}

.headerText {
  flex: 1;
}

.title {
  font-size: 26px;
  margin: 0 0 6px;
}

.errorNote {
  background: #3a1d1d;
  color: #ffb4b4;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.startBtn {
  display: block;
  width: 100%;
  padding: 12px;
  font-size: 16px;
  font-weight: 600;
  border: none;
  border-radius: 10px;
  background: #2f6f4f;
  color: #fff;
  cursor: pointer;
  margin-bottom: 24px;
}

.startBtn:disabled {
  opacity: 0.6;
  cursor: default;
}

.section {
  margin-bottom: 24px;
}

.sectionTitle {
  font-size: 18px;
  margin: 0 0 10px;
  color: #cfd8ff;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.ingredient,
.equipment {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #2a2a2a;
}

.quantity {
  color: #9ecbff;
  min-width: 90px;
}

.name {
  color: #e8e8e8;
}

.steps {
  padding-left: 20px;
  margin: 0;
}

.step {
  margin-bottom: 14px;
}

.stepText {
  margin: 0 0 4px;
}

.stepMeta {
  color: #aaa;
  font-size: 13px;
}

.badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.badge {
  background: #222;
  color: #9ecbff;
  border: 1px solid #333;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}

.safetyNote {
  color: #ffcf7d;
  font-size: 13px;
  margin: 4px 0 0;
}

.empty {
  text-align: center;
  padding: 48px 0;
}

.emptyText {
  color: #aaa;
}

.primaryBtn {
  display: inline-block;
  margin-top: 12px;
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  background: #2f6f4f;
  color: #fff;
  cursor: pointer;
  text-decoration: none;
  font-size: 14px;
}
```

- [ ] **Step 4: Run the page test to verify it passes**

Run: `npx vitest run app/recipes/[id]/page.test.tsx`

Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/[id]/page.tsx app/recipes/[id]/page.module.css app/recipes/[id]/page.test.tsx
git commit -m "feat(recipes): add the read-only recipe detail page (spec 0003)"
```

---

### Task 3: Entry point — row titles on `/recipes` become links

**Files:**
- Modify: `app/recipes/page.tsx` — the row title block (the `<p className={styles.cardName}>` in the `visible.map` render, around lines 203–215).
- Test: `app/recipes/page.test.tsx` — add a link-assertion test.

**Interfaces:**
- Consumes: `RecipeSummary.recipeId` and `RecipeSummary.title` from `./recipe-filter` (already used by the page), `Link` from `next/link` (already imported).
- Produces: each row title is an anchor with `href="/recipes/<recipeId>"`; the existing Start and Delete buttons are untouched.

- [ ] **Step 1: Write the failing list test**

Append this test to `app/recipes/page.test.tsx` (the file already has `render`, `screen`, `fireEvent`, `waitFor`, `push`, and the `RECIPES` fixture):

```tsx
it('links each row title to its detail page and keeps Start working', async () => {
  render(<RecipesPage />);

  const chickenLink = await screen.findByRole('link', { name: /open recipe simple chicken and rice/i });
  expect(chickenLink.getAttribute('href')).toBe('/recipes/chicken-rice');
  const beefLink = screen.getByRole('link', { name: /open recipe beef stew/i });
  expect(beefLink.getAttribute('href')).toBe('/recipes/beef-stew');

  // Start still posts launch and hands off to /cook.
  fireEvent.click(screen.getAllByRole('button', { name: /start cooking/i })[0]);
  await waitFor(() => expect(push).toHaveBeenCalledWith('/cook'));
});
```

- [ ] **Step 2: Run the list test to verify it fails**

Run: `npx vitest run app/recipes/page.test.tsx`

Expected: FAIL — the title is a `<p>`, so no link with the `open recipe ...` accessible name exists.

- [ ] **Step 3: Implement the title link**

In `app/recipes/page.tsx`, replace the title block:

```tsx
<p className={styles.cardName}>
  {r.title}
  {r.proteinCategories.length > 0 && (
    <span className={styles.badges}>
      {r.proteinCategories.map((cat) => (
        <span key={cat} className={styles.badge}>
          {cat}
        </span>
      ))}
    </span>
  )}
</p>
```

with:

```tsx
<div className={styles.cardName}>
  <Link href={`/recipes/${r.recipeId}`} aria-label={`Open recipe ${r.title}`}>
    {r.title}
  </Link>
  {r.proteinCategories.length > 0 && (
    <span className={styles.badges}>
      {r.proteinCategories.map((cat) => (
        <span key={cat} className={styles.badge}>
          {cat}
        </span>
      ))}
    </span>
  )}
</div>
```

If `.cardName` has a `display` style that breaks the inline link (check `app/recipes/page.module.css`), keep the div as the block and let the anchor inherit.

- [ ] **Step 4: Run the list tests to verify they pass**

Run: `npx vitest run app/recipes/page.test.tsx`

Expected: PASS — the new link test plus all existing tests (Start, Delete, filters, states).

- [ ] **Step 5: Commit**

```bash
git add app/recipes/page.tsx app/recipes/page.test.tsx
git commit -m "feat(recipes): link row titles to the recipe detail page (spec 0003)"
```

---

### Task 4: Full validation and landing

**Files:** none new — this task validates and lands Tasks 1–3.

**Interfaces:**
- Consumes: all of Tasks 1–3 on the feature branch.
- Produces: a merged PR whose deploy's verify:live passes.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`

Expected: PASS — every test file, including the new route, page, and list tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: clean (`tsc --noEmit`, no output).

- [ ] **Step 3: Land through the branch + PR path**

```bash
git checkout -b feat/recipe-detail-page
git push -u origin feat/recipe-detail-page
gh pr create --base main --head feat/recipe-detail-page \
  --title "feat(recipes): read-only recipe detail page at /recipes/[id] (spec 0003)" \
  --body "Implements docs/specs/0003: get_recipe action, the detail page, and row-title links. Route + page + list tests, full suite green, typecheck clean."
gh pr merge --auto --squash --delete-branch
```

- [ ] **Step 4: Handle the Codex gate**

If the Codex bot reviews and leaves findings, fix each and reply `Resolved ...` on its thread (the repo's resolution convention). If the bot skips (no review within the wait window and the nudge is inert), certify with `gh variable set CODEX_GATE_BOT_SKIPPED_PRS --body "<PR number>"`, push an empty synchronize commit, and delete the variable after merge.

- [ ] **Step 5: Watch the deploy verify**

Confirm the merged head's pipeline runs green through Deploy Firebase App Hosting and Verify deployed app (verify:live) with `RESULT: PASS`, then sync local `main` to `origin/main`.

---

## Self-review notes

- **Spec coverage (docs/specs/0003):** Task 1 implements the API design (section 1, all four route behaviors); Task 2 implements the page (section 2: states, layout sections, Start handoff) and its tests (section 4); Task 3 implements the entry point (section 3); Task 4 runs the full suite + typecheck and lands (section 4). Scope boundaries hold: no edit/delete/scale/print/share anywhere.
- **Placeholder scan:** every code step contains the full content; no TBD/TODO/`add appropriate ...`/`similar to ...` patterns.
- **Type consistency:** `Recipe`, `RecipeSummary`, and `RecipeRowMeta` props are used exactly as defined in `lib/domain/types.ts`, `app/recipes/recipe-filter.ts`, and `app/cook/RecipeRowMeta.tsx`. `recipeStore.getRecipe` returns `Recipe | null`, checked with the owner guard. The page's `formatSeconds`, `fetchRecipe`, and `handleStart` names are used consistently across the test and the component.
