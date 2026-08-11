// ─────────────────────────────────────────────────────────────────────────────
// Gemini (Google AI) providers
//
// Concrete implementations of the RecipeGenerator / RecipeValidator boundary.
// The model is only ever asked for structured JSON, which is then validated
// with zod before it can enter the system. Business logic never depends on
// this file — it can be swapped via the provider registry.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { recipeSchema } from '../domain/schemas';
import type { Recipe, Ingredient } from '../domain/types';
import type {
  RecipeRequest,
  RecipeValidationResult,
  RecipeValidationError,
  MissingConfirmation,
} from './types';
import type { RecipeGenerator, RecipeValidator } from './provider';

export interface GeminiOptions {
  apiKey?: string;
  generationModel?: string;
  validationModel?: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveKey(opts: GeminiOptions): string | undefined {
  return opts.apiKey ?? process.env.GOOGLE_AI_API_KEY;
}

/**
 * Resolve a GenerativeModel from options/env, or null when no API key is set.
 */
export function getGeminiModel(opts: GeminiOptions, model?: string): GenerativeModel | null {
  const key = resolveKey(opts);
  if (!key) return null;
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: model ?? DEFAULT_MODEL });
}

function getModel(opts: GeminiOptions, role: 'generation' | 'validation'): GenerativeModel | null {
  const model =
    role === 'generation'
      ? (opts.generationModel ?? process.env.RECIPE_GENERATION_MODEL ?? DEFAULT_MODEL)
      : (opts.validationModel ?? process.env.RECIPE_VALIDATION_MODEL ?? DEFAULT_MODEL);
  return getGeminiModel(opts, model);
}

/** Extract the first balanced JSON object from a model response (handles ``` fences). */
export function extractJson(text: string): unknown {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();

  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const json = cleaned.slice(start, i + 1);
        return JSON.parse(json);
      }
    }
  }
  throw new Error('Unbalanced JSON object in model response');
}

// ── Generation prompt ────────────────────────────────────────────────────────

function formatIngredient(ing: Ingredient): string {
  const qty = ing.quantity === null ? 'unknown quantity' : `${ing.quantity}${ing.unit ? ` ${ing.unit}` : ''}`;
  const parts = [qty, ing.name];
  if (ing.preparation) parts.push(`(${ing.preparation})`);
  if (ing.condition) parts.push(`(${ing.condition})`);
  return parts.join(' ');
}

function buildGenerationPrompt(request: RecipeRequest): string {
  return [
    'You are a professional recipe generator. Produce a recipe that uses ONLY the ingredients listed as available.',
    '',
    'Rules:',
    '- Return STRICT JSON matching the schema below. No markdown, no prose outside JSON.',
    '- Separate prep steps (dicing, mincing, washing) from cooking steps (heating, searing, simmering).',
    '- Each step is ONE short spoken action. Provide a concise spokenInstruction.',
    '- ingredientsUsed / equipmentUsed must use the EXACT names from the ingredients/equipment lists ("chicken thighs", never "chicken-thighs").',
    '- Ingredients with an unknown quantity must use null, never an invented number.',
    '- Respect servings, dietary restrictions, allergies, disliked ingredients, and available equipment.',
    '- Include equipment, dietary tags, allergens, and safety notes (hot oil, raw meat handling).',
    '- Provide estimatedPrepMinutes, estimatedCookMinutes, and totalMinutes consistently.',
    '',
    `Available ingredients: ${request.ingredientsAvailable.map(formatIngredient).join('; ') || '(none)'}`,
    `Servings: ${request.servings ?? 2}`,
    request.maxTimeMinutes ? `Max time: ${request.maxTimeMinutes} minutes` : '',
    request.dietaryRestrictions.length ? `Dietary restrictions: ${request.dietaryRestrictions.join(', ')}` : '',
    request.allergies.length ? `Allergies: ${request.allergies.join(', ')}` : '',
    request.cuisinePreferences.length ? `Cuisine preferences: ${request.cuisinePreferences.join(', ')}` : '',
    request.dislikedIngredients.length ? `Avoid: ${request.dislikedIngredients.join(', ')}` : '',
    request.availableEquipment.length ? `Available equipment: ${request.availableEquipment.join(', ')}` : '',
    request.skillLevel ? `Skill level: ${request.skillLevel}` : '',
    '',
    'Recipe JSON schema:',
    JSON.stringify(
      {
        id: 'string (unique)',
        title: 'string',
        description: 'string (optional)',
        servings: 'number',
        estimatedPrepMinutes: 'number',
        estimatedCookMinutes: 'number',
        totalMinutes: 'number',
        ingredients: [{ id: 'string', name: 'string', quantity: 'number|null', unit: 'string|null', preparation: 'string (optional)', condition: 'string (optional)', optional: 'boolean' }],
        equipment: ['string'],
        prepSteps: [{ id: 'string', stepNumber: 'number', instruction: 'string', spokenInstruction: 'string', estimatedSeconds: 'number', ingredientsUsed: ['string'], equipmentUsed: ['string'] }],
        cookingSteps: [{ id: 'string', stepNumber: 'number', instruction: 'string', spokenInstruction: 'string', estimatedSeconds: 'number (optional)', timerSeconds: 'number (optional)', temperature: 'number (optional)', temperatureUnit: '"C"|"F" (optional)', heatLevel: '"low"|"medium-low"|"medium"|"medium-high"|"high" (optional)', ingredientsUsed: ['string'], equipmentUsed: ['string'], safetyNote: 'string (optional)' }],
        dietaryTags: ['string'],
        allergens: ['string'],
        safetyNotes: ['string'],
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createGeminiRecipeGenerator(opts: GeminiOptions = {}): RecipeGenerator {
  return {
    async generate(request: RecipeRequest): Promise<Recipe> {
      const model = getModel(opts, 'generation');
      if (!model) {
        throw new Error('GOOGLE_AI_API_KEY is not configured for recipe generation');
      }
      const response = await model.generateContent(buildGenerationPrompt(request));
      const text = response.response.text();
      const json = extractJson(text);
      const parsed = recipeSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `Gemini returned an invalid recipe: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
        );
      }
      return parsed.data;
    },
  };
}

// ── Validation prompt ────────────────────────────────────────────────────────

function buildValidationPrompt(recipe: Recipe): string {
  return [
    'You are a recipe QA engineer. Review this structured recipe for semantic problems a static checker cannot catch:',
    '- ingredient availability / seasonality concerns',
    '- flavor or texture inconsistencies',
    '- steps that would physically not work',
    '- missing technique details',
    '',
    'Return STRICT JSON: {"errors":[{"field":"...","message":"...","severity":"error"}],"warnings":[{"field":"...","message":"...","severity":"warning"}],"missingConfirmations":[{"item":"...","context":"..."}]}',
    'Only include genuine findings — do not invent problems. Empty arrays are fine.',
    '',
    `Recipe: ${JSON.stringify(recipe, null, 2)}`,
  ].join('\n');
}

export function createGeminiRecipeValidator(opts: GeminiOptions = {}): RecipeValidator {
  return {
    async validate(recipe: Recipe): Promise<RecipeValidationResult> {
      const model = getModel(opts, 'validation');
      if (!model) {
        return { valid: true, errors: [], warnings: [], missingConfirmations: [] };
      }
      const response = await model.generateContent(buildValidationPrompt(recipe));
      const text = response.response.text();
      const json = extractJson(text) as {
        errors?: RecipeValidationError[];
        warnings?: RecipeValidationError[];
        missingConfirmations?: MissingConfirmation[];
      };
      const errors = Array.isArray(json.errors) ? json.errors : [];
      const warnings = Array.isArray(json.warnings) ? json.warnings : [];
      const missing = Array.isArray(json.missingConfirmations) ? json.missingConfirmations : [];
      return { valid: errors.length === 0, errors, warnings, missingConfirmations: missing };
    },
  };
}