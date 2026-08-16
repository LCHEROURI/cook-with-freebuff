// ─────────────────────────────────────────────────────────────────────────────
// app/recipes/recipe-scaler.ts — pure servings scaling for the detail page.
//
// Kept free of React so the logic is unit-testable in isolation. The page owns
// the fetch and the stepper UI; this module owns the decision of which
// quantities change and by how much.
//
// Distinct from lib/recipe/transform.ts's scaleRecipe (the server-side K3
// resize tool): that one uses 2-decimal rounding and touches updatedAt; this
// one produces a display copy with cooking-friendly rounding and no mutation.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient, Recipe } from '@/lib/domain/types';

/**
 * Units whose amount never scales with servings: a pinch stays a pinch no
 * matter how many people you cook for. Matched case-insensitively.
 */
const PASSTHROUGH_UNITS = new Set(['pinch', 'dash', 'to taste', 'as needed', 'handful']);

/**
 * Round a scaled quantity for display: nearest 1/4 below 10, whole numbers at
 * 10 and above (spec 0003 D3). Whole numbers stay whole either way.
 */
function roundScaled(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 4) / 4;
}

/**
 * Scale one ingredient line by `factor`. Null quantities and exempt units pass
 * through untouched; optional ingredients still scale (optional means
 * skippable, not quantityless). The stored value is never mutated — a fresh
 * ingredient object is returned.
 */
function scaleIngredient(ing: Ingredient, factor: number): Ingredient {
  const unit = ing.unit?.trim().toLowerCase();
  if (ing.quantity === null || (unit && PASSTHROUGH_UNITS.has(unit))) {
    return ing;
  }
  return { ...ing, quantity: roundScaled(ing.quantity * factor) };
}

/**
 * Scale a recipe's ingredient quantities to a new serving count.
 *
 * Pure: returns a display copy of the recipe with scaled quantities and the
 * new serving count; the stored recipe and its ingredients are never mutated,
 * and nothing but quantities and servings changes (timers, temperatures, heat
 * levels, safety notes, total minutes, and step structure all stay as stored —
 * spec 0003 D1, D2).
 *
 * Guards (D2, D5): a recipe whose `servings` is 0 or missing falls back to
 * factor 1 (no scaling, no divide-by-zero); a zero, negative, or non-integer
 * `targetServings` throws — the stepper bounds are 1–24, so anything else is
 * a programming error.
 */
export function scaleRecipe(recipe: Recipe, targetServings: number): Recipe {
  if (!Number.isInteger(targetServings) || targetServings <= 0) {
    throw new Error('targetServings must be a positive integer');
  }
  const factor = recipe.servings > 0 ? targetServings / recipe.servings : 1;
  return {
    ...recipe,
    servings: targetServings,
    ingredients: recipe.ingredients.map((ing) => scaleIngredient(ing, factor)),
  };
}
