// ─────────────────────────────────────────────────────────────────────────────
// Ingredient display formatting
//
// Shared by the recipe detail page and the cooking screen's Ingredients
// disclosure so both render quantities identically. Kept free of React so the
// logic is unit-testable in isolation (same pattern as recipe-scaler.ts).
// Unknown quantities are explicitly null — nothing is invented on display.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient } from '../domain/types';

/**
 * Format a quantity for display: whole numbers stay whole, and the quarter
 * steps render as ¼/½/¾ (spec 0003 D3). Scaling already rounds to the nearest
 * ¼, so this only ever sees {0, 0.25, 0.5, 0.75} fractions.
 */
export function formatIngredientQuantity(q: number): string {
  const whole = Math.floor(q);
  const frac = Math.round((q - whole) * 4) / 4;
  const fraction = frac === 0.25 ? '¼' : frac === 0.5 ? '½' : frac === 0.75 ? '¾' : '';
  return whole === 0 ? (fraction || '0') : `${whole}${fraction}`;
}

/**
 * The quantity prefix for an ingredient line: "4 pieces" when both are known,
 * "4" when only the quantity is known, and "" when the quantity is unknown
 * (null — never invented).
 */
export function formatIngredientQuantityPrefix(ing: Ingredient): string {
  if (ing.quantity == null) return '';
  return ing.unit ? `${formatIngredientQuantity(ing.quantity)} ${ing.unit}` : formatIngredientQuantity(ing.quantity);
}

/**
 * The name suffix for an ingredient line: "chicken thighs, diced" with a
 * preparation, plus an "(optional)" marker when the ingredient is skippable.
 */
export function formatIngredientNameSuffix(ing: Ingredient): string {
  return `${ing.name}${ing.preparation ? `, ${ing.preparation}` : ''}${ing.optional ? ' (optional)' : ''}`;
}
