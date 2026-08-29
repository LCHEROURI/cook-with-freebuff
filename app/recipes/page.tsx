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
import { appCheckHeaders } from '@/lib/firebase/app-check';
import { VoiceInputButton } from '@/components/VoiceInputButton';
import { appendTranscript } from '@/lib/domain/fieldUI';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(await appCheckHeaders()) },
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
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(await appCheckHeaders()) },
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
          <Button asChild variant="ghost">
            <Link href="/">← Back to start</Link>
          </Button>
        </section>
      </main>
    );
  }

  const hasRecipes = recipes.status === 'ready' && recipes.items.length > 0;
  const noMatches = recipes.status === 'ready' && recipes.items.length > 0 && visible.length === 0;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Button asChild variant="ghost" size="icon" className="h-11 w-11">
          <Link href="/" aria-label="Back to start">←</Link>
        </Button>
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
            <Input
              className="flex-1 bg-surface"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search recipes, diets or allergens…"
              aria-label="Search recipes"
            />
            <VoiceInputButton
              aria-label="Speak recipes search"
              onTranscript={(text) => setQuery(appendTranscript(query, text, undefined))}
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
              <Button
                type="button"
                size="sm"
                variant={protein === '' ? 'default' : 'outline'}
                className="min-h-9 rounded-full px-4"
                onClick={() => setProtein('')}
              >
                All
              </Button>
              {categories.map((cat) => (
                <Button
                  key={cat}
                  type="button"
                  size="sm"
                  variant={protein === cat ? 'default' : 'outline'}
                  className="min-h-9 rounded-full px-4"
                  onClick={() => setProtein(protein === cat ? '' : cat)}
                >
                  {cat}
                </Button>
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
          <Button
            type="button"
            onClick={() => {
              setRecipes({ status: 'loading', items: [] });
              void fetchRecipes();
            }}
          >
            Try again
          </Button>
        </section>
      )}

      {recipes.status === 'ready' && recipes.items.length === 0 && (
        <section className={styles.empty}>
          <p className={styles.emptyText}>You have no saved recipes yet.</p>
          <Button asChild>
            <Link href="/cook">Create your first recipe</Link>
          </Button>
        </section>
      )}

      {noMatches && (
        <section className={styles.empty}>
          <p className={styles.emptyText}>No recipes match your search.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setQuery('');
              setProtein('');
            }}
          >
            Clear filters
          </Button>
        </section>
      )}

      {recipes.status === 'ready' && visible.length > 0 && (
        <ul className={styles.list}>
          {visible.map((r) => (
            <li key={r.recipeId} className={styles.card}>
              <div className={styles.cardInfo}>
                <div className={styles.cardName}>
                  <Link href={`/recipes/${r.recipeId}`} aria-label={`Open recipe ${r.title}`}>
                    {r.title}
                  </Link>
                  {r.proteinCategories.length > 0 && (
                    <span className={styles.badges}>
                      {r.proteinCategories.map((cat) => (
                        <Badge
                          key={cat}
                          variant="outline"
                          className="rounded-full border-[var(--color-mauve-subtle-border)] bg-[var(--color-mauve-subtle)] text-[var(--color-mauve-subtle-text)]"
                        >
                          {cat}
                        </Badge>
                      ))}
                    </span>
                  )}
                </div>
                <RecipeRowMeta
                  servings={r.servings}
                  totalMinutes={r.totalMinutes}
                  ingredientCount={r.ingredientCount}
                  preferences={r.preferences}
                />
              </div>
              <div className={styles.actions}>
                <Button
                  type="button"
                  size="sm"
                  className="min-h-10"
                  onClick={() => void handleStart(r.recipeId)}
                  disabled={startingId !== null || deletingId !== null}
                  aria-label={`Start cooking ${r.title}`}
                >
                  {startingId === r.recipeId ? 'Starting…' : '▶ Start'}
                </Button>
                {confirmingId === r.recipeId ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-10"
                      onClick={() => setConfirmingId(null)}
                      disabled={deletingId !== null}
                      aria-label={`Cancel delete ${r.title}`}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="min-h-10"
                      onClick={() => void handleDelete(r.recipeId)}
                      disabled={deletingId !== null}
                      aria-label={`Confirm delete ${r.title}`}
                    >
                      {deletingId === r.recipeId ? 'Deleting…' : 'Delete'}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10 border-[var(--color-danger-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
                    onClick={() => setConfirmingId(r.recipeId)}
                    disabled={startingId !== null || deletingId !== null}
                    aria-label={`Delete ${r.title}`}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Button asChild variant="ghost" className="mt-2 w-fit text-[var(--color-accent-subtle-text)] hover:text-[var(--color-accent-subtle-text)]">
        <Link href="/cook">＋ New recipe</Link>
      </Button>
    </main>
  );
}
