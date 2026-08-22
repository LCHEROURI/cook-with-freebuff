// ─────────────────────────────────────────────────────────────────────────────
// AI types — shared between the provider boundary and concrete implementations
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Ingredient,
  Recipe,
  PrepStep,
  CookingStep,
} from '../domain/types';

/**
 * Structured request for recipe generation.
 */
export interface RecipeRequest {
  ingredientsAvailable: Ingredient[];
  servings?: number;
  maxTimeMinutes?: number;
  dietaryRestrictions: string[];
  allergies: string[];
  cuisinePreferences: string[];
  dislikedIngredients: string[];
  availableEquipment: string[];
  /** Optional free-text intent for this one recipe, such as “something comforting”. */
  craving?: string;
  skillLevel?: 'beginner' | 'intermediate' | 'advanced';
}

export interface MissingConfirmation {
  item: string;
  context: string;
}

export interface RecipeValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface RecipeValidationResult {
  valid: boolean;
  errors: RecipeValidationError[];
  warnings: RecipeValidationError[];
  missingConfirmations: MissingConfirmation[];
  correctedRecipe?: Recipe;
}

// ── Re-export domain types used by AI services for convenience ───────────────

export type { Ingredient, Recipe, PrepStep, CookingStep };
