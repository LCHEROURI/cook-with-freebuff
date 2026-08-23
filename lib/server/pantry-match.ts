// ─────────────────────────────────────────────────────────────────────────────
// Pantry-recipe matching engine — pure domain logic, testable without API.
//
// Takes a recipe's ingredients and the user's pantry items and returns a
// deterministic match assessment. Used by "What Can I Make?" (all recipes),
// "Recipe Gap Check" (single recipe), and "Expiring Soon" (expiry-weighted).
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient, PantryItem } from '../domain/types';
import type { PantryItemView } from './pantry-service';

// ── Match result types ──────────────────────────────────────────────────────

export type IngredientMatchStatus =
  | 'matched'       // confident, non-expired pantry item found
  | 'missing'       // no pantry item matches
  | 'expired'       // matching pantry item exists but is expired
  | 'stale'         // matching pantry item is older than 30 days
  | 'uncertain';    // matching pantry item has low confidence

export interface IngredientMatchDetail {
  name: string;
  status: IngredientMatchStatus;
  pantryItemId?: string;
}

export interface RecipePantryMatch {
  recipeId: string;
  title: string;
  servings: number;
  totalMinutes: number;
  ingredientCount: number;
  matchPercent: number;
  matchedCount: number;
  missingCount: number;
  expiredCount: number;
  staleCount: number;
  uncertainCount: number;
  expiringSoonCount: number;
  /** Matched ingredient names whose pantry item is expiring within 2 days. */
  expiringSoonIngredients: string[];
  /** All ingredient names are present — quantities are NOT verified. */
  allIngredientsFound: boolean;
}

export interface PantryMatchOptions {
  /** Confidence threshold below which a match is considered uncertain. */
  confidenceThreshold?: number;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeIngredientName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * For a single recipe ingredient, find the best-matching pantry item.
 * Returns the match status and the pantry item id if found.
 */
function matchOneIngredient(
  ingredient: Ingredient,
  pantryItems: PantryItemView[],
  opts: Required<PantryMatchOptions>,
): IngredientMatchDetail {
  const normalizedName = normalizeIngredientName(ingredient.name);

  // Find candidate pantry items by normalized name.
  const candidates = pantryItems.filter(
    (p) => normalizeIngredientName(p.name) === normalizedName,
  );

  if (candidates.length === 0) {
    return { name: ingredient.name, status: 'missing' };
  }

  // Prefer the freshest (most recently confirmed) non-expired item.
  const best = candidates.reduce((a, b) =>
    a.lastConfirmedAt > b.lastConfirmedAt ? a : b,
  );

  if (best.expired) {
    return { name: ingredient.name, status: 'expired', pantryItemId: best.id };
  }

  if (best.stale) {
    return { name: ingredient.name, status: 'stale', pantryItemId: best.id };
  }

  if (best.confidence < opts.confidenceThreshold) {
    return { name: ingredient.name, status: 'uncertain', pantryItemId: best.id };
  }

  return { name: ingredient.name, status: 'matched', pantryItemId: best.id };
}

/**
 * Match a single recipe against the user's pantry.
 * Returns a full match assessment with counts and status per ingredient.
 */
export function matchRecipeToPantry(
  ingredients: Ingredient[],
  pantryItems: PantryItemView[],
  opts: PantryMatchOptions = {},
): { details: IngredientMatchDetail[]; match: RecipePantryMatch } {
  const options: Required<PantryMatchOptions> = {
    confidenceThreshold: opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  };

  const details = ingredients.map((ingredient) =>
    matchOneIngredient(ingredient, pantryItems, options),
  );

  const matchedCount = details.filter((d) => d.status === 'matched').length;
  const missingCount = details.filter((d) => d.status === 'missing').length;
  const expiredCount = details.filter((d) => d.status === 'expired').length;
  const staleCount = details.filter((d) => d.status === 'stale').length;
  const uncertainCount = details.filter((d) => d.status === 'uncertain').length;

  // Expiring-soon: matched items whose pantry item is expiring within 2 days.
  const expiringSoonIngredients: string[] = [];
  const expiringSoonCount = details.filter((d) => {
    if (d.status !== 'matched') return false;
    const pantryItem = pantryItems.find((p) => p.id === d.pantryItemId);
    if (pantryItem?.expiresSoon) {
      expiringSoonIngredients.push(d.name);
      return true;
    }
    return false;
  }).length;

  // A recipe has all ingredients found when every ingredient exists in the
  // pantry (no missing, no expired — stale and uncertain still count because
  // the user can confirm them). Note: quantities are NOT compared — "1 egg in
  // pantry" matches a "6 eggs" recipe ingredient.
  const allIngredientsFound = missingCount === 0 && expiredCount === 0;
  const total = ingredients.length || 1; // avoid division by zero
  const matchPercent = Math.round((matchedCount / total) * 100);

  return {
    details,
    match: {
      recipeId: '',
      title: '',
      servings: 0,
      totalMinutes: 0,
      ingredientCount: total,
      matchPercent,
      matchedCount,
      missingCount,
      expiredCount,
      staleCount,
      uncertainCount,
      expiringSoonCount,
      expiringSoonIngredients,
      allIngredientsFound,
    },
  };
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Lexicographic comparator for recipe-pantry matches.
 *
 * Each tier is only evaluated when all previous tiers are tied.
 * This guarantees the priority order without relying on numerical magnitudes:
 *
 *   1. All ingredients found first
 *   2. Fewer missing ingredients
 *   3. More expiring-soon items used
 *   4. Higher match percentage
 *   5. Higher matched-ingredient count
 *   6. Title (deterministic tie-breaker)
 */
function compareRecipeMatches(a: RecipePantryMatch, b: RecipePantryMatch): number {
  // Tier 1: all ingredients found.
  if (a.allIngredientsFound !== b.allIngredientsFound) {
    return a.allIngredientsFound ? -1 : 1;
  }

  // Tier 2: fewer missing ingredients.
  if (a.missingCount !== b.missingCount) {
    return a.missingCount - b.missingCount;
  }

  // Tier 3: more expiring-soon items used.
  if (a.expiringSoonCount !== b.expiringSoonCount) {
    return b.expiringSoonCount - a.expiringSoonCount;
  }

  // Tier 4: higher match percentage.
  if (a.matchPercent !== b.matchPercent) {
    return b.matchPercent - a.matchPercent;
  }

  // Tier 5: higher matched count.
  if (a.matchedCount !== b.matchedCount) {
    return b.matchedCount - a.matchedCount;
  }

  // Tier 6: title.
  const titleCmp = a.title.localeCompare(b.title);
  if (titleCmp !== 0) return titleCmp;

  // Tier 7: recipe ID (final deterministic tie-breaker).
  return a.recipeId.localeCompare(b.recipeId);
}

/**
 * Rank an array of recipe-pantry matches using the lexicographic comparator.
 */
export function rankRecipeMatches<T extends RecipePantryMatch>(
  matches: T[],
): T[] {
  return [...matches].sort(compareRecipeMatches);
}

// Re-export the shared client-safe ranking helper.
export { rankExpiringSoonMatches } from "../pantry-match-ranking";


// ── Grocery Needs aggregation (Candidate D) ──────────────────────────────

export interface GroceryNeed {
  /** Normalized ingredient name. */
  name: string;
  /** Number of distinct safe recipes that need this ingredient. */
  recipeCount: number;
  /** IDs of those recipes. */
  recipeIds: string[];
  /** True when at least one contributing detail is expired (needs replacement). */
  needsReplacement: boolean;
}

/**
 * Aggregate missing and expired ingredient details across multiple recipes
 * into a deduplicated, sorted list of grocery needs.
 *
 * Only ingredients with status "missing" or "expired" are included.
 * Stale, uncertain, and matched ingredients are excluded because they
 * require confirmation or are already available.
 *
 * recipeCount and recipeIds track distinct recipes only — duplicate
 * ingredient rows within a single recipe do not inflate the count.
 */
export function aggregateGroceryNeeds(
  detailsByRecipe: Array<{
    recipeId: string;
    details: IngredientMatchDetail[];
  }>,
): GroceryNeed[] {
  // Accumulate by normalized ingredient name.
  const byName = new Map<string, {
    recipeIds: Set<string>;
    hasExpired: boolean;
  }>();

  for (const { recipeId, details } of detailsByRecipe) {
    const seen = new Set<string>(); // per-recipe dedup
    for (const d of details) {
      if (d.status !== 'missing' && d.status !== 'expired') continue;
      const key = normalizeIngredientName(d.name);
      if (seen.has(key)) continue; // same ingredient twice in one recipe → count once
      seen.add(key);

      let entry = byName.get(key);
      if (!entry) {
        entry = { recipeIds: new Set(), hasExpired: false };
        byName.set(key, entry);
      }
      entry.recipeIds.add(recipeId);
      if (d.status === 'expired') entry.hasExpired = true;
    }
  }

  // Convert to sorted array.
  const needs: GroceryNeed[] = [];
  for (const [name, entry] of byName) {
    needs.push({
      name,
      recipeCount: entry.recipeIds.size,
      recipeIds: [...entry.recipeIds],
      needsReplacement: entry.hasExpired,
    });
  }

  // Sort: higher recipeCount first, then alphabetical name.
  needs.sort((a, b) => {
    if (a.recipeCount !== b.recipeCount) return b.recipeCount - a.recipeCount;
    return a.name.localeCompare(b.name);
  });

  return needs;
}
