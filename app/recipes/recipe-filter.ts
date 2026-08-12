// ─────────────────────────────────────────────────────────────────────────────
// app/recipes/recipe-filter.ts — pure search / filter / sort for the recipes page.
//
// Kept free of React so the logic is unit-testable in isolation. The page owns
// the fetch and the UI; this module owns the decision of which recipes match
// and in what order.
// ─────────────────────────────────────────────────────────────────────────────

/** Lightweight recipe summary, as returned by /api/cook's list_recipes. */
export interface RecipeSummary {
  recipeId: string;
  title: string;
  servings: number;
  totalMinutes: number;
  ingredientCount: number;
  proteinCategories: string[];
  /** What the recipe was built for — optional for pre-feature recipes. */
  preferences?: {
    servings: number | null;
    allergies: string[];
    dietaryRestrictions: string[];
  };
  updatedAt: number;
}

export type RecipeSort = 'newest' | 'quickest' | 'title';

export interface RecipeFilterOptions {
  /** Free-text search, matched against title, protein, diet and allergies. */
  query: string;
  /** Exact protein category to keep ('' = all). */
  protein: string;
  sort: RecipeSort;
}

/**
 * Filter `items` by the text query and protein category, then sort.
 * The text query is case-insensitive and matches the title plus the recipe's
 * protein categories, dietary restrictions and allergies, so "chicken",
 * "vegetarian" or "peanuts" all find their recipes.
 */
export function filterAndSortRecipes(
  items: RecipeSummary[],
  opts: RecipeFilterOptions,
): RecipeSummary[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = items.filter((r) => {
    if (opts.protein && !r.proteinCategories.includes(opts.protein)) return false;
    if (!q) return true;
    const haystack = [
      r.title,
      ...r.proteinCategories,
      ...(r.preferences?.dietaryRestrictions ?? []),
      ...(r.preferences?.allergies ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });

  const sorted = [...filtered];
  if (opts.sort === 'quickest') {
    sorted.sort((a, b) => a.totalMinutes - b.totalMinutes);
  } else if (opts.sort === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    // newest: the API already sorts updatedAt desc; re-assert so the contract
    // holds regardless of the upstream ordering.
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
}

/** The distinct protein categories across a list, sorted for stable chips. */
export function availableCategories(items: RecipeSummary[]): string[] {
  return [...new Set(items.flatMap((r) => r.proteinCategories))].sort();
}
