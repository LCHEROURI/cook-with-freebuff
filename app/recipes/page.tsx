'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /recipes — "My Recipes": the saved-recipe browser.
//
// Lists every generated recipe, newest first, with a text search, a protein
// category filter, and a sort control. Each row reuses the shared
// RecipeRowMeta line (servings · time · ingredients · diet · allergies) and
// has a one-tap Start button that launches a fresh session then hands off to
// /cook. Reads go through /api/cook's list_recipes (never a client-side
// Firestore query), and launching goes through the same launch action the
// /cook starter uses.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import RecipeRowMeta from '../cook/RecipeRowMeta';
import {
  availableCategories,
  filterAndSortRecipes,
  type RecipeSort,
  type RecipeSummary,
} from './recipe-filter';

export default function RecipesPage() {
  const router = useRouter();
  const auth = useAuthSession();

  const [recipes, setRecipes] = useState<{ status: 'loading' | 'ready' | 'error'; items: RecipeSummary[] }>({
    status: 'loading',
    items: [],
  });
  const [query, setQuery] = useState('');
  const [protein, setProtein] = useState('');
  const [sort, setSort] = useState<RecipeSort>('newest');
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // auth.getToken is a stable callback (reads the live session via a ref), so
  // this fetch never re-runs in a loop — it fires once when auth settles.
  const getToken = auth.getToken;
  const fetchRecipes = useCallback(async () => {
    try {
      const token = await getToken();
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
  }, [getToken]);

  useEffect(() => {
    if (auth.state !== 'ready' || !auth.user) return;
    void fetchRecipes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.state, auth.user, fetchRecipes]);

  // Protect the route: once auth settles with no user, go sign in.
  useEffect(() => {
    if (auth.state === 'ready' && !auth.user) {
      router.replace('/login');
    }
  }, [auth.state, auth.user, router]);

  // Launch a saved recipe, then hand off to /cook (which shows the active
  // session this launch just created).
  const handleStart = async (recipeId: string) => {
    if (startingId) return;
    setStartingId(recipeId);
    setStartError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
      setStartingId(null);
    }
  };

  // Delete a saved recipe: confirm-first (the row arms to Cancel/Delete before
  // the destructive call), then remove it locally so the list updates without
  // a refetch. Ownership is enforced server-side — this only sends the id.
  const handleDelete = async (recipeId: string) => {
    if (deletingId) return;
    setDeletingId(recipeId);
    setDeleteError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/cook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'delete_recipe', recipeId }),
      });
      const body = (await res.json()) as { success: boolean; error?: { message?: string } };
      if (!res.ok || !body.success) {
        setDeleteError(body.error?.message ?? `Could not delete recipe (${res.status})`);
        setConfirmingId(null);
        return;
      }
      setRecipes((prev) =>
        prev.status === 'ready'
          ? { ...prev, items: prev.items.filter((r) => r.recipeId !== recipeId) }
          : prev,
      );
      setConfirmingId(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete recipe.');
      setConfirmingId(null);
    } finally {
      setDeletingId(null);
    }
  };

  const categories = useMemo(() => availableCategories(recipes.items), [recipes.items]);
  const visible = useMemo(
    () => filterAndSortRecipes(recipes.items, { query, protein, sort }),
    [recipes.items, query, protein, sort],
  );

  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your recipes…</p>
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

  if (auth.error) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>My Recipes</h1>
          <p className={styles.emptyText}>{auth.error}</p>
          <Link href="/" className={styles.backLink}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  const hasRecipes = recipes.status === 'ready' && recipes.items.length > 0;
  const noMatches = recipes.status === 'ready' && recipes.items.length > 0 && visible.length === 0;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/" className={styles.backLink} aria-label="Back to start">
          ←
        </Link>
        <div className={styles.headerText}>
          <h1 className={styles.title}>My Recipes</h1>
          <p className={styles.subtitle}>
            Your saved recipes — search, filter by protein, and start cooking in one tap.
          </p>
        </div>
      </header>

      {startError && (
        <div className={styles.errorNote} role="alert">
          {startError}
        </div>
      )}

      {deleteError && (
        <div className={styles.errorNote} role="alert">
          {deleteError}
        </div>
      )}

      {hasRecipes && (
        <section className={styles.controls} aria-label="Search and filters">
          <div className={styles.controlsRow}>
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search recipes, diets or allergens…"
              aria-label="Search recipes"
            />
            <select
              className={styles.sort}
              value={sort}
              onChange={(e) => setSort(e.target.value as RecipeSort)}
              aria-label="Sort recipes"
            >
              <option value="newest">Newest first</option>
              <option value="quickest">Quickest first</option>
              <option value="title">Alphabetical</option>
            </select>
          </div>
          {categories.length > 0 && (
            <nav className={styles.chips} aria-label="Filter by protein">
              <button
                type="button"
                className={`${styles.chip} ${protein === '' ? styles.chipActive : ''}`}
                onClick={() => setProtein('')}
              >
                All
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`${styles.chip} ${protein === cat ? styles.chipActive : ''}`}
                  onClick={() => setProtein(protein === cat ? '' : cat)}
                >
                  {cat}
                </button>
              ))}
            </nav>
          )}
        </section>
      )}

      {recipes.status === 'ready' && recipes.items.length > 0 && (
        <p className={styles.count} aria-live="polite">
          {visible.length === recipes.items.length
            ? `${recipes.items.length} ${recipes.items.length === 1 ? 'recipe' : 'recipes'}`
            : `${visible.length} of ${recipes.items.length} recipes`}
        </p>
      )}

      {recipes.status === 'loading' && <p className={styles.centered}>Loading your recipes…</p>}

      {recipes.status === 'error' && (
        <section className={styles.empty}>
          <p className={styles.emptyText}>Could not load your recipes.</p>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => {
              setRecipes({ status: 'loading', items: [] });
              void fetchRecipes();
            }}
          >
            Try again
          </button>
        </section>
      )}

      {recipes.status === 'ready' && recipes.items.length === 0 && (
        <section className={styles.empty}>
          <p className={styles.emptyText}>You have no saved recipes yet.</p>
          <Link href="/cook" className={styles.primaryBtn}>
            Create your first recipe
          </Link>
        </section>
      )}

      {noMatches && (
        <section className={styles.empty}>
          <p className={styles.emptyText}>No recipes match your search.</p>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => {
              setQuery('');
              setProtein('');
            }}
          >
            Clear filters
          </button>
        </section>
      )}

      {recipes.status === 'ready' && visible.length > 0 && (
        <ul className={styles.list}>
          {visible.map((r) => (
            <li key={r.recipeId} className={styles.card}>
              <div className={styles.cardInfo}>
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
                <RecipeRowMeta
                  servings={r.servings}
                  totalMinutes={r.totalMinutes}
                  ingredientCount={r.ingredientCount}
                  preferences={r.preferences}
                />
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.startBtn}
                  onClick={() => void handleStart(r.recipeId)}
                  disabled={startingId !== null || deletingId !== null}
                  aria-label={`Start cooking ${r.title}`}
                >
                  {startingId === r.recipeId ? 'Starting…' : '▶ Start'}
                </button>
                {confirmingId === r.recipeId ? (
                  <>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={() => setConfirmingId(null)}
                      disabled={deletingId !== null}
                      aria-label={`Cancel delete ${r.title}`}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.deleteConfirmBtn}
                      onClick={() => void handleDelete(r.recipeId)}
                      disabled={deletingId !== null}
                      aria-label={`Confirm delete ${r.title}`}
                    >
                      {deletingId === r.recipeId ? 'Deleting…' : 'Delete'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={() => setConfirmingId(r.recipeId)}
                    disabled={startingId !== null || deletingId !== null}
                    aria-label={`Delete ${r.title}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link href="/cook" className={styles.newRecipeLink}>
        ＋ New recipe
      </Link>
    </main>
  );
}
