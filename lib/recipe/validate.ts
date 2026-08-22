// ─────────────────────────────────────────────────────────────────────────────
// Recipe validation engine (deterministic)
//
// validateRecipe is the source of truth for the K4 validation checks. It runs
// every time, independent of any AI model — an AI validator may add semantic
// findings, but these checks always gate the pipeline:
//
//   1. schema validity        6. logical order
//   2. ingredient consistency 7. actionability
//   3. quantity consistency   8. timing plausibility
//   4. resource validation    9. safety
//   5. dietary constraints   10. one-action suitability
// ─────────────────────────────────────────────────────────────────────────────

import { recipeSchema } from '../domain/schemas';
import type { Recipe, PrepStep, CookingStep } from '../domain/types';
import type {
  RecipeValidationResult,
  RecipeValidationError,
  MissingConfirmation,
} from '../ai/types';
import {
  classifyIngredientSafety,
  normalizeAllergyCategory,
  normalizeRestriction,
} from './ingredient-safety';

export interface RecipeValidationContext {
  /** Names of ingredients the user says they have. */
  availableIngredients?: string[];
  availableEquipment?: string[];
  allergies?: string[];
  dietaryRestrictions?: string[];
}

export interface RecipeSafetyDecision extends RecipeValidationResult {
  blockingErrors: RecipeValidationError[];
  canPersist: boolean;
  canList: boolean;
  canLaunch: boolean;
}

const MEAT_TERMS = [
  'chicken', 'beef', 'pork', 'bacon', 'lamb', 'turkey', 'duck', 'veal',
  'steak', 'sausage', 'ham', 'mince', 'ground', 'fish', 'shrimp', 'salmon',
];

const HIGH_HEAT_TERMS = [
  'deep fry', 'deep-fry', 'fry', 'sear', 'hot oil', 'caramelize', 'blister', 'flash fry',
];

/** Action verbs used by the one-action-suitability heuristic. */
const ACTION_VERBS = [
  'dice', 'mince', 'chop', 'slice', 'peel', 'grate', 'whisk', 'mix', 'stir',
  'fold', 'add', 'pour', 'cook', 'fry', 'sear', 'simmer', 'boil', 'sauté',
  'saute', 'roast', 'bake', 'grill', 'brown', 'season', 'sprinkle', 'garnish',
  'toss', 'knead', 'roll', 'spread', 'melt', 'blend', 'puree', 'marinate',
  'drain', 'rinse', 'wash', 'pat', 'heat', 'caramelize', 'flip', 'strain',
  'crack', 'squeeze', 'zest', 'crush', 'press', 'trim',
];

// Name normalization: lowercase + separator-tolerant. Generated recipes often
// reference ingredients in kebab-case ("chicken-thighs") while the ingredient
// list uses spaces ("chicken thighs") — collapsing hyphens/underscores to a
// single space treats them as the same ingredient instead of a false error.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function validateRecipe(
  recipe: Recipe,
  ctx: RecipeValidationContext = {},
): RecipeSafetyDecision {
  const errors: RecipeValidationError[] = [];
  const warnings: RecipeValidationError[] = [];
  const missingConfirmations: MissingConfirmation[] = [];

  // 1. Schema validity
  const parsed = recipeSchema.safeParse(recipe);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
        severity: 'error',
      });
    }
    return decision(errors, warnings, missingConfirmations);
  }

  // 2. Ingredient consistency — every step reference must exist in the list.
  // References may use the ingredient NAME or its ID: the generator is
  // instructed to use exact names, but occasionally emits id-style references
  // ("rice_01") that are still consistent with the list. Resolving both is the
  // same tolerance norm() already applies to kebab-case vs spaces — a ref that
  // resolves to ANY listed ingredient is consistent, one that resolves to
  // nothing is a genuine error.
  const ingredientKeys = new Set([
    ...recipe.ingredients.map((i) => norm(i.name)),
    ...recipe.ingredients.map((i) => norm(i.id)),
  ]);
  for (const step of [...recipe.prepSteps, ...recipe.cookingSteps]) {
    for (const ref of step.ingredientsUsed) {
      if (!ingredientKeys.has(norm(ref))) {
        errors.push({
          field: 'steps',
          message: `Step "${truncate(step.instruction)}" references unknown ingredient "${ref}"`,
          severity: 'error',
        });
      }
    }
  }

  // 3. Quantity consistency — null quantities are explicit but flagged.
  const nullQuantityKeys = new Set([
    ...recipe.ingredients.filter((i) => i.quantity === null).map((i) => norm(i.name)),
    ...recipe.ingredients.filter((i) => i.quantity === null).map((i) => norm(i.id)),
  ]);
  for (const step of [...recipe.prepSteps, ...recipe.cookingSteps]) {
    for (const ref of step.ingredientsUsed) {
      if (nullQuantityKeys.has(norm(ref))) {
        warnings.push({
          field: 'ingredients',
          message: `Quantity for "${ref}" is unknown — confirm before shopping`,
          severity: 'warning',
        });
      }
    }
  }

  // 4. Resource validation — never silently assume the user has something.
  if (ctx.availableIngredients) {
    const available = new Set(ctx.availableIngredients.map(norm));
    for (const ing of recipe.ingredients) {
      if (!ing.optional && !available.has(norm(ing.name))) {
        missingConfirmations.push({
          item: ing.name,
          context: `This recipe requires ${ing.name}. Do you have ${ing.name}?`,
        });
      }
    }
  }
  if (ctx.availableEquipment) {
    const availableEq = new Set(ctx.availableEquipment.map(norm));
    for (const eq of recipe.equipment) {
      if (!availableEq.has(norm(eq))) {
        missingConfirmations.push({
          item: eq,
          context: `This recipe requires ${eq}. Do you have one?`,
        });
      }
    }
  }

  // 5. Dietary constraints — explicit allergies/restrictions take priority.
  const ingredientEvidence = recipe.ingredients.flatMap(classifyIngredientSafety);
  if (ctx.allergies?.length) {
    const lower = ctx.allergies.map(norm);
    for (const allergen of recipe.allergens) {
      const category = normalizeAllergyCategory(allergen);
      if (lower.includes(norm(allergen))
        || (category && ctx.allergies.some((item) => normalizeAllergyCategory(item) === category))) {
        errors.push({
          field: 'allergens',
          message: `Recipe contains allergen: ${allergen}`,
          severity: 'error',
        });
      }
    }
    for (const allergy of ctx.allergies) {
      const category = normalizeAllergyCategory(allergy);
      if (!category) continue;
      for (const evidence of ingredientEvidence.filter((item) => item.hazard === category)) {
        errors.push({
          field: 'ingredients',
          message: `Ingredient "${evidence.ingredient}" contains ${evidence.term}, conflicting with the ${allergy} allergy`,
          severity: 'error',
        });
      }
    }
  }
  if (ctx.dietaryRestrictions?.length) {
    for (const restriction of ctx.dietaryRestrictions) {
      const category = normalizeRestriction(restriction);
      const blockedHazards = category === 'vegetarian'
        ? new Set(['meat'])
        : category === 'vegan'
          ? new Set(['meat', 'animal_product'])
          : category === 'gluten_free'
            ? new Set(['gluten'])
            : null;
      if (!blockedHazards) continue;
      for (const evidence of ingredientEvidence.filter((item) => blockedHazards.has(item.hazard))) {
        errors.push({
          field: 'ingredients',
          message: `Ingredient "${evidence.ingredient}" contains ${evidence.term}, conflicting with the ${restriction} restriction`,
          severity: 'error',
        });
      }
    }
  }

  // 6. Logical order — steps must be executable in sequence.
  const checkOrder = (steps: Array<PrepStep | CookingStep>, label: string) => {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].stepNumber !== i + 1) {
        errors.push({
          field: label,
          message: `${label} are not sequentially numbered (position ${i + 1} has stepNumber ${steps[i].stepNumber})`,
          severity: 'error',
        });
        break;
      }
    }
  };
  checkOrder(recipe.prepSteps, 'prepSteps');
  checkOrder(recipe.cookingSteps, 'cookingSteps');

  // 7. Actionability — each step clearly tells the user what to do.
  // (Empty spokenInstruction is already rejected by the recipe schema.)

  // 8. Timing plausibility.
  const declared = recipe.totalMinutes;
  const sum = recipe.estimatedPrepMinutes + recipe.estimatedCookMinutes;
  if (Math.abs(declared - sum) > 5) {
    warnings.push({
      field: 'totalMinutes',
      message: `totalMinutes (${declared}) does not match prep (${recipe.estimatedPrepMinutes}) + cook (${recipe.estimatedCookMinutes}) = ${sum}`,
      severity: 'warning',
    });
  }

  // 9. Safety — high heat and raw-meat handling must be flagged.
  for (const step of recipe.cookingSteps) {
    const text = step.instruction.toLowerCase();
    const highHeat =
      step.heatLevel === 'high' ||
      step.heatLevel === 'medium-high' ||
      (step.temperature !== undefined && step.temperature >= 150) ||
      HIGH_HEAT_TERMS.some((t) => text.includes(t));
    if (highHeat && !step.safetyNote) {
      warnings.push({
        field: 'cookingSteps',
        message: `High-heat step "${truncate(step.instruction)}" lacks a safety note`,
        severity: 'warning',
      });
    }
  }
  const ingText = recipe.ingredients.map((i) => i.name.toLowerCase()).join(' ');
  const hasMeat = MEAT_TERMS.some((t) => ingText.includes(t));
  if (hasMeat && recipe.safetyNotes.length === 0) {
    warnings.push({
      field: 'safetyNotes',
      message: 'Recipe handles meat — add cross-contamination and safe-temperature safety notes',
      severity: 'warning',
    });
  }

  // 10. One-action suitability — steps must be short spoken actions.
  for (const step of [...recipe.prepSteps, ...recipe.cookingSteps]) {
    const wordCount = step.instruction.split(/\s+/).filter(Boolean).length;
    if (wordCount > 25) {
      warnings.push({
        field: 'steps',
        message: `Step "${truncate(step.instruction)}" is too wordy for one spoken action (${wordCount} words)`,
        severity: 'warning',
      });
    }
    // Count distinct action verbs. "Dice the onion and mince the garlic" has
    // two; "Add salt and pepper" has one and is a legitimately single action.
    const verbs = new Set<string>();
    for (const verb of ACTION_VERBS) {
      if (new RegExp(`\\b${verb}\\b`, 'i').test(step.instruction)) {
        verbs.add(verb);
      }
    }
    if (verbs.size >= 2) {
      warnings.push({
        field: 'steps',
        message: `Step "${truncate(step.instruction)}" contains multiple actions (${Array.from(verbs).join(', ')}) — split into one action per step`,
        severity: 'warning',
      });
    }
  }

  return decision(errors, warnings, missingConfirmations);
}

function decision(
  errors: RecipeValidationError[],
  warnings: RecipeValidationError[],
  missingConfirmations: MissingConfirmation[],
): RecipeSafetyDecision {
  const allowed = errors.length === 0;
  return {
    valid: allowed,
    errors,
    blockingErrors: errors,
    warnings,
    missingConfirmations,
    canPersist: allowed,
    canList: allowed,
    canLaunch: allowed,
  };
}

function truncate(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
