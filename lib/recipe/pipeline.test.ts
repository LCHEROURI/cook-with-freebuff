import { describe, it, expect, beforeEach } from 'vitest';
import { runGenerationPipeline } from './pipeline';
import { SessionService, InMemorySessionStore } from '../server/session-service';
import { registerRecipeGenerator, resetProviders } from '../ai/provider';
import type { Recipe, Ingredient } from '../domain/types';
import type { RecipeRequest } from '../ai/types';

function makeIngredient(name: string, quantity: number | null = null, unit: string | null = null): Ingredient {
  return { id: `ing-${name}`, name, quantity, unit, optional: false };
}

function makeRecipe(): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [
      makeIngredient('chicken thighs', 4, 'pieces'),
      makeIngredient('rice', 1, 'cup'),
      makeIngredient('onion', 1, null),
    ],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken for 4 minutes', spokenInstruction: 'Sear the chicken for four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil' },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil'],
    generatedAt: t,
    updatedAt: t,
  };
}

function makeRequest(overrides: Partial<RecipeRequest> = {}): RecipeRequest {
  return {
    ingredientsAvailable: [makeIngredient('chicken thighs', 4, 'pieces'), makeIngredient('rice', 1, 'cup'), makeIngredient('onion', 1, null)],
    servings: 2,
    dietaryRestrictions: [],
    allergies: [],
    cuisinePreferences: [],
    dislikedIngredients: [],
    availableEquipment: ['pan', 'knife'],
    ...overrides,
  };
}

describe('runGenerationPipeline', () => {
  beforeEach(() => {
    resetProviders();
  });

  it('generates, validates, and reaches RECIPE_READY', async () => {
    registerRecipeGenerator('default', { async generate() { return makeRecipe(); } });
    const result = await runGenerationPipeline({ request: makeRequest() });
    expect(result.phase).toBe('RECIPE_READY');
    expect(result.recipe).toBeDefined();
    expect(result.validation?.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ERROR when no generator is registered', async () => {
    const result = await runGenerationPipeline({ request: makeRequest() });
    expect(result.phase).toBe('ERROR');
    expect(result.error?.code).toBe('GENERATION_UNAVAILABLE');
  });

  it('returns ERROR when the generator throws', async () => {
    registerRecipeGenerator('default', {
      async generate() { throw new Error('model exploded'); },
    });
    const result = await runGenerationPipeline({ request: makeRequest() });
    expect(result.phase).toBe('ERROR');
    expect(result.error?.code).toBe('INTERNAL_ERROR');
  });

  it('sends schema-invalid output back to COLLECTING_REQUIREMENTS', async () => {
    registerRecipeGenerator('default', {
      async generate() {
        return { title: '', servings: -1 } as unknown as Recipe;
      },
    });
    const result = await runGenerationPipeline({ request: makeRequest() });
    expect(result.phase).toBe('COLLECTING_REQUIREMENTS');
    expect(result.validation?.valid).toBe(false);
  });

  it('sends validation-failing output back to COLLECTING_REQUIREMENTS', async () => {
    const bad = makeRecipe();
    bad.ingredients = [makeIngredient('chicken thighs', 4, 'pieces')]; // drop rice/onion refs still used
    bad.cookingSteps = [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken', spokenInstruction: 'Sear the chicken', estimatedSeconds: 240, ingredientsUsed: ['chicken thighs', 'rice'], equipmentUsed: ['pan'] },
    ];
    registerRecipeGenerator('default', { async generate() { return bad; } });
    const result = await runGenerationPipeline({ request: makeRequest() });
    expect(result.phase).toBe('COLLECTING_REQUIREMENTS');
    expect(result.validation?.errors.some((e) => e.message.includes('rice'))).toBe(true);
  });

  it('requires confirmation when the user lacks an ingredient', async () => {
    // The generated recipe uses onion, but the user only has chicken + rice.
    registerRecipeGenerator('default', { async generate() { return makeRecipe(); } });
    const result = await runGenerationPipeline({
      request: makeRequest({
        ingredientsAvailable: [makeIngredient('chicken thighs', 4, 'pieces'), makeIngredient('rice', 1, 'cup')],
      }),
    });
    // The pipeline asks for confirmation rather than approving silently.
    expect(result.validation?.missingConfirmations.map((m) => m.item)).toContain('onion');
    expect(result.phase).toBe('COLLECTING_REQUIREMENTS');
  });

  it('persists the generated recipe when a store is provided', async () => {
    let saved: Recipe | null = null;
    const recipeStore = { async createRecipe(r: Recipe) { saved = r; } };
    registerRecipeGenerator('default', { async generate() { return makeRecipe(); } });
    await runGenerationPipeline({ request: makeRequest(), recipeStore });
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe('recipe-1');
  });

  it('does not persist a recipe that fails deterministic allergy validation', async () => {
    let saved: Recipe | null = null;
    const recipeStore = { async createRecipe(r: Recipe) { saved = r; } };
    registerRecipeGenerator('default', {
      async generate() {
        return { ...makeRecipe(), allergens: ['peanuts'] };
      },
    });

    const result = await runGenerationPipeline({
      request: makeRequest({ allergies: ['peanuts'] }),
      recipeStore,
    });

    expect(result.phase).toBe('COLLECTING_REQUIREMENTS');
    expect(result.validation?.errors).toEqual([
      expect.objectContaining({ field: 'allergens' }),
    ]);
    expect(saved).toBeNull();
  });

  it('drives the session state machine through the phases', async () => {
    const store = new InMemorySessionStore();
    const service = new SessionService(store);
    let s = await service.createSession('user-1');
    // Drive to COLLECTING_REQUIREMENTS
    s = await service.transitionTo(s.id, s.version, 'CONFIRMING_INGREDIENTS', 'USER_INPUT');
    s = await service.transitionTo(s.id, s.version, 'COLLECTING_REQUIREMENTS', 'USER_INPUT');

    registerRecipeGenerator('default', { async generate() { return makeRecipe(); } });

    const result = await runGenerationPipeline({
      request: makeRequest(),
      session: { id: s.id, version: s.version, service },
    });
    expect(result.phase).toBe('RECIPE_READY');

    const finalSession = await service.getSession(s.id);
    expect(finalSession!.currentPhase).toBe('RECIPE_READY');

    const events = await store.listSessionEvents(s.id);
    expect(events.some((e) => e.type === 'RECIPE_GENERATION_STARTED')).toBe(true);
    expect(events.some((e) => e.type === 'RECIPE_GENERATED')).toBe(true);
    expect(events.some((e) => e.type === 'RECIPE_VALIDATED')).toBe(true);
  });

  it('transitions the session back to COLLECTING_REQUIREMENTS on validation failure', async () => {
    const store = new InMemorySessionStore();
    const service = new SessionService(store);
    let s = await service.createSession('user-1');
    s = await service.transitionTo(s.id, s.version, 'CONFIRMING_INGREDIENTS', 'USER_INPUT');
    s = await service.transitionTo(s.id, s.version, 'COLLECTING_REQUIREMENTS', 'USER_INPUT');

    const bad = makeRecipe();
    bad.ingredients = [makeIngredient('chicken thighs', 4, 'pieces')];
    bad.cookingSteps = [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken', spokenInstruction: 'Sear the chicken', estimatedSeconds: 240, ingredientsUsed: ['chicken thighs', 'rice'], equipmentUsed: ['pan'] },
    ];
    registerRecipeGenerator('default', { async generate() { return bad; } });

    const result = await runGenerationPipeline({
      request: makeRequest(),
      session: { id: s.id, version: s.version, service },
    });
    expect(result.phase).toBe('COLLECTING_REQUIREMENTS');

    const finalSession = await service.getSession(s.id);
    expect(finalSession!.currentPhase).toBe('COLLECTING_REQUIREMENTS');
    const events = await store.listSessionEvents(s.id);
    expect(events.some((e) => e.type === 'RECIPE_VALIDATION_FAILED')).toBe(true);
  });
});
