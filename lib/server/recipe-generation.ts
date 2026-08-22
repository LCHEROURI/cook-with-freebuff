import { createHash } from 'node:crypto';
import type { RecipeRequest } from '../ai/types';
import { recipeRequestSchema } from '../domain/schemas';
import type { DietaryProfile, Ingredient } from '../domain/types';
import { mergeSafetyAllergies } from './kitchen-context';

function mergePreferences(primary: string[], secondary: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...primary, ...secondary]) {
    const value = raw.trim().replace(/\s+/g, ' ');
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Resolve the exact server-trusted request that will be sent to the model. */
export function effectiveRecipeRequest(
  request: RecipeRequest,
  profile: DietaryProfile,
): RecipeRequest {
  return recipeRequestSchema.parse({
    ...request,
    servings: request.servings ?? profile.defaultServings,
    allergies: mergeSafetyAllergies(profile.allergies ?? [], request.allergies),
    dietaryRestrictions: mergeSafetyAllergies(
      profile.dietaryRestrictions ?? [],
      request.dietaryRestrictions,
    ),
    dislikedIngredients: mergePreferences(
      profile.dislikedIngredients ?? [],
      request.dislikedIngredients,
    ),
    cuisinePreferences: request.cuisinePreferences.length > 0
      ? mergePreferences(request.cuisinePreferences, [])
      : mergePreferences(profile.preferredCuisines ?? [], []),
    availableEquipment: mergePreferences(
      profile.preferredEquipment ?? [],
      request.availableEquipment,
    ),
  });
}

function canonicalStrings(values: string[]): string[] {
  return values
    .map((value) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
    .sort();
}

function canonicalIngredients(ingredients: Ingredient[]) {
  return ingredients
    .map((ingredient) => ({
      id: ingredient.id,
      name: ingredient.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase(),
      quantity: ingredient.quantity,
      unit: ingredient.unit?.trim().toLocaleLowerCase() ?? null,
      optional: ingredient.optional,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Stable server-side identity for the complete effective generation request. */
export function hashEffectiveRecipeRequest(request: RecipeRequest): string {
  const canonical = {
    ingredientsAvailable: canonicalIngredients(request.ingredientsAvailable),
    servings: request.servings ?? null,
    maxTimeMinutes: request.maxTimeMinutes ?? null,
    dietaryRestrictions: canonicalStrings(request.dietaryRestrictions),
    allergies: canonicalStrings(request.allergies),
    cuisinePreferences: canonicalStrings(request.cuisinePreferences),
    dislikedIngredients: canonicalStrings(request.dislikedIngredients),
    availableEquipment: canonicalStrings(request.availableEquipment),
    craving: request.craving?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? null,
    skillLevel: request.skillLevel ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface EffectiveSafetyContext {
  allergies: string[];
  dietaryRestrictions: string[];
}

/** Dedicated identity for the effective hard constraints, independent of prompt identity. */
export function hashEffectiveSafetyContext(context: EffectiveSafetyContext): string {
  return createHash('sha256').update(JSON.stringify({
    allergies: canonicalStrings(context.allergies),
    dietaryRestrictions: canonicalStrings(context.dietaryRestrictions),
  })).digest('hex');
}

export function recipeGenerationMarkerId(userId: string, correlationId: string): string {
  return `recipe-generation:${userId}:${correlationId}`;
}
