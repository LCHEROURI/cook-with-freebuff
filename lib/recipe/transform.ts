// ─────────────────────────────────────────────────────────────────────────────
// Pure recipe transforms
//
// Deterministic, side-effect-free operations on structured recipes. Used by the
// K3 recipe tools (resize_recipe, replace_ingredient). Business logic lives
// here, not in the tool handlers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Recipe } from '../domain/types';

function roundQuantity(value: number): number {
  // Keep 2 decimal places max; strip trailing zeros where sensible.
  return Math.round(value * 100) / 100;
}

/**
 * Resize a recipe to a new serving count by scaling ingredient quantities.
 * Unknown quantities (null) stay null — never invented.
 * Timing, equipment, and step structure are unchanged.
 */
export function scaleRecipe(recipe: Recipe, servings: number): Recipe {
  if (servings <= 0 || !Number.isInteger(servings)) {
    throw new Error('Servings must be a positive integer');
  }
  const ratio = servings / recipe.servings;
  return {
    ...recipe,
    servings,
    ingredients: recipe.ingredients.map((ing) => ({
      ...ing,
      quantity: ing.quantity === null ? null : roundQuantity(ing.quantity * ratio),
    })),
    updatedAt: Date.now(),
  };
}

/**
 * Replace one ingredient with another throughout the recipe: the ingredient
 * entry, plus every prep/cooking step's ingredientsUsed reference.
 * Case-insensitive on the source name. Returns a new recipe (immutable).
 */
export function replaceIngredientInRecipe(
  recipe: Recipe,
  fromName: string,
  toName: string,
): Recipe {
  const from = fromName.toLowerCase().trim();
  const swap = (name: string) => (name.toLowerCase().trim() === from ? toName : name);

  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ing) =>
      ing.name.toLowerCase().trim() === from ? { ...ing, name: toName } : ing,
    ),
    prepSteps: recipe.prepSteps.map((step) => ({
      ...step,
      ingredientsUsed: step.ingredientsUsed.map(swap),
    })),
    cookingSteps: recipe.cookingSteps.map((step) => ({
      ...step,
      ingredientsUsed: step.ingredientsUsed.map(swap),
    })),
    updatedAt: Date.now(),
  };
}