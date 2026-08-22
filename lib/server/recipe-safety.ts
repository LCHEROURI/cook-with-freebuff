import type { RecipeRequest } from '../ai/types';
import type { DietaryProfile, Recipe } from '../domain/types';
import {
  validateRecipe,
  type RecipeSafetyDecision,
  type RecipeValidationContext,
} from '../recipe/validate';
import { mergeSafetyAllergies } from './kitchen-context';

export function evaluateGeneratedRecipeSafety(
  recipe: Recipe,
  request: RecipeRequest,
): RecipeSafetyDecision {
  return validateRecipe(recipe, {
    availableIngredients: request.ingredientsAvailable.map((ingredient) => ingredient.name),
    availableEquipment: request.availableEquipment,
    allergies: request.allergies,
    dietaryRestrictions: request.dietaryRestrictions,
  });
}

export function evaluateStoredRecipeSafety(
  recipe: Recipe,
  profile: DietaryProfile,
  resourceContext: Pick<
    RecipeValidationContext,
    'availableIngredients' | 'availableEquipment'
  > = {},
): RecipeSafetyDecision {
  return validateRecipe(recipe, {
    ...resourceContext,
    allergies: mergeSafetyAllergies(
      profile.allergies,
      recipe.preferences?.allergies ?? [],
    ),
    dietaryRestrictions: mergeSafetyAllergies(
      profile.dietaryRestrictions,
      recipe.preferences?.dietaryRestrictions ?? [],
    ),
  });
}
