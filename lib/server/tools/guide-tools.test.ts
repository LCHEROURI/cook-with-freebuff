import { describe, it, expect } from 'vitest';
import { SessionService, InMemorySessionStore } from '../session-service';
import { createDefaultToolRegistry, executeTool, InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from './index';
import type { ToolContext } from './types';
import type { Ingredient, Recipe } from '../../domain/types';

function makeIngredient(name: string, quantity: number | null = null, unit: string | null = null): Ingredient {
  return { id: `ing-${name}`, name, quantity, unit, optional: false };
}

function makeRecipe(): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [makeIngredient('chicken thighs', 4, 'pieces'), makeIngredient('rice', 1, 'cup'), makeIngredient('onion')],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil' },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil'],
    generatedAt: t,
    updatedAt: t,
  };
}

function makeContext(userId = 'user-1'): {
  ctx: ToolContext;
  timers: InMemoryTimerStore;
  recipes: InMemoryRecipeStore;
} {
  const timers = new InMemoryTimerStore();
  const recipes = new InMemoryRecipeStore();
  const sessionService = new SessionService(new InMemorySessionStore());
  return {
    ctx: {
      userId,
      sessionService,
      timerStore: timers,
      logStore: new InMemoryLogStore(),
      recipeStore: recipes,
    },
    timers,
    recipes,
  };
}

const registry = createDefaultToolRegistry();

describe('cook_with_me', () => {
  it('launches guided cooking and returns the first single action', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());

    const result = await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });
    expect(result.success).toBe(true);
    const data = result.data as { phase: string; instruction: string; stepNumber: number; totalSteps: number };
    expect(data.phase).toBe('PREP_GUIDANCE');
    expect(data.instruction).toBe('Dice the onion');
    expect(data.stepNumber).toBe(1);
    expect(data.totalSteps).toBe(1);
  });

  it('reports RECIPE_NOT_FOUND honestly', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'missing' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RECIPE_NOT_FOUND');
  });

  it('validates the recipeId argument', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'cook_with_me', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
  });
});

describe('complete_current_step (guided)', () => {
  it('auto-transitions prep → cooking and auto-starts the step timer', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());

    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });
    const result = await executeTool(registry, ctx, 'complete_current_step', {});

    expect(result.success).toBe(true);
    const data = result.data as {
      phase: string;
      instruction: string;
      timerStarted?: { label: string };
      activeTimers: unknown[];
    };
    expect(data.phase).toBe('WAITING_FOR_TIMER');
    expect(data.instruction).toBe('Sear the chicken four minutes');
    expect(data.timerStarted?.label).toBe('four-minute timer');
    expect(data.activeTimers).toHaveLength(1);
  });
});

describe('request_substitution / apply_substitution', () => {
  it('request preserves location and returns candidates', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });

    const result = await executeTool(registry, ctx, 'request_substitution', {
      unavailableIngredient: 'garlic',
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      snapshot: { phase: string; stepNumber: number };
      candidates: { ingredient: string }[];
    };
    expect(data.snapshot.phase).toBe('SUBSTITUTION_REQUIRED');
    expect(data.snapshot.stepNumber).toBe(1);
    expect(data.candidates.length).toBeGreaterThan(0);
  });

  it('apply persists the replacement and resumes the exact step', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });
    await executeTool(registry, ctx, 'request_substitution', { unavailableIngredient: 'milk' });

    const result = await executeTool(registry, ctx, 'apply_substitution', { replacement: 'heavy cream' });
    expect(result.success).toBe(true);
    const data = result.data as { from: string; to: string; snapshot: { phase: string; stepNumber: number } };
    expect(data.from).toBe('milk');
    expect(data.to).toBe('heavy cream');
    expect(data.snapshot.phase).toBe('PREP_GUIDANCE');
    expect(data.snapshot.stepNumber).toBe(1);
  });

  it('apply without a pending substitution fails honestly', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });

    const result = await executeTool(registry, ctx, 'apply_substitution', {
      unavailableIngredient: 'milk',
      replacement: 'heavy cream',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_PENDING_SUBSTITUTION');
  });
});

describe('correct_ingredient', () => {
  it('persists the correction and resumes the exact step', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });

    const result = await executeTool(registry, ctx, 'correct_ingredient', {
      name: 'tomatoes',
      quantity: 2,
    });
    expect(result.success).toBe(true);
    const data = result.data as { regenerating: boolean; snapshot: { phase: string } };
    expect(data.regenerating).toBe(false);
    expect(data.snapshot.phase).toBe('PREP_GUIDANCE');
  });
});

describe('recover_session', () => {
  it('classifies a transient error as a bounded RETRY and restores', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });

    const result = await executeTool(registry, ctx, 'recover_session', { errorCode: 'NETWORK_ERROR' });
    expect(result.success).toBe(true);
    const data = result.data as { action: string; retryCount: number; snapshot: { phase: string } };
    expect(data.action).toBe('RETRY');
    expect(data.retryCount).toBe(1);
    expect(data.snapshot.phase).toBe('PREP_GUIDANCE');
  });
});

describe('check_timers', () => {
  it('surfaces a finished-timer alert and recovers the session', async () => {
    const { ctx, recipes, timers } = makeContext();
    await recipes.createRecipe(makeRecipe());
    await executeTool(registry, ctx, 'cook_with_me', { recipeId: 'recipe-1' });
    await executeTool(registry, ctx, 'complete_current_step', {}); // → WAITING_FOR_TIMER

    const started = await executeTool(registry, ctx, 'get_cooking_session', {});
    const sessionId = (started.data as { sessionId: string }).sessionId;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 250_000, endsAt: Date.now() - 10_000 });

    const result = await executeTool(registry, ctx, 'check_timers', {});
    expect(result.success).toBe(true);
    const data = result.data as {
      alerts: { message: string }[];
      snapshot: { phase: string; instruction: string };
    };
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0].message).toBe('Your four-minute timer is finished.');
    expect(data.snapshot.phase).toBe('COOKING_GUIDANCE');
    expect(data.snapshot.instruction).toBe('Sear the chicken four minutes');
  });
});
