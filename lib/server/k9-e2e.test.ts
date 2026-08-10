import { describe, it, expect } from 'vitest';
import { SessionService, InMemorySessionStore } from './session-service';
import {
  InMemoryTimerStore,
  InMemoryLogStore,
  InMemoryRecipeStore,
  InMemoryPantryStore,
} from './tools/registry';
import { createDefaultToolRegistry } from './tools';
import { executeTool } from './tools/registry';
import { GuidedCookingService } from './guide-service';
import { validateRecipe } from '../recipe/validate';
import type { Recipe } from '../domain/types';
import type { ToolContext } from './tools/types';

// ── K9 Part D — the spec's end-to-end scenarios, as integration tests ───────
// Each scenario drives the real services (guide service, session service,
// tool layer) against in-memory stores — the same code the API routes run.

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 15,
    totalMinutes: 20,
    ingredients: [
      { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'i2', name: 'rice', quantity: 1, unit: 'cup', optional: false },
      { id: 'i3', name: 'onion', quantity: 1, unit: 'piece', optional: false },
    ],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
      { id: 'p2', stepNumber: 2, instruction: 'Rinse the rice', spokenInstruction: 'Rinse the rice', estimatedSeconds: 60, ingredientsUsed: ['rice'], equipmentUsed: [] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'] },
      { id: 'c2', stepNumber: 2, instruction: 'Simmer the rice', spokenInstruction: 'Simmer the rice', estimatedSeconds: 600, ingredientsUsed: ['rice'], equipmentUsed: [] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
    ...overrides,
  };
}

function makeContext(userId = 'user-1') {
  const store = new InMemorySessionStore();
  const timers = new InMemoryTimerStore();
  const recipes = new InMemoryRecipeStore();
  const logs = new InMemoryLogStore();
  const pantry = new InMemoryPantryStore();
  const sessionService = new SessionService(store);
  const ctx: ToolContext = { userId, sessionService, timerStore: timers, logStore: logs, recipeStore: recipes, pantryStore: pantry };
  const guide = new GuidedCookingService(sessionService, timers, recipes);
  return { store, timers, recipes, logs, sessionService, ctx, guide };
}

const registry = createDefaultToolRegistry();

describe('K9 scenario 3 — pause → close → reopen → resume exact step', () => {
  it('a NEW service instance (fresh object, same store) resumes the paused step', async () => {
    const ctx = makeContext();
    await ctx.recipes.createRecipe(makeRecipe());
    const snap = await ctx.guide.launchCookWithMe('user-1', 'recipe-1');

    const paused = await ctx.guide.pause('user-1', snap.sessionId);
    expect(paused.phase).toBe('PAUSED');

    // \"Close the app\": a brand-new service over the SAME persisted stores.
    const reopened = new GuidedCookingService(ctx.sessionService, ctx.timers, ctx.recipes);
    const resumed = await reopened.resume('user-1');
    expect(resumed.phase).toBe('PREP_GUIDANCE');
    expect(resumed.instruction).toBe('Dice the onion');
    expect(resumed.stepNumber).toBe(1);
  });
});

describe('K9 scenario 9 — two rapid \"done\" commands do not advance twice', () => {
  it('the second concurrent done hits a version conflict and the session advances exactly once', async () => {
    const ctx = makeContext();
    await ctx.recipes.createRecipe(makeRecipe());
    await ctx.guide.launchCookWithMe('user-1', 'recipe-1');

    // Two rapid completions fired at the same instant (double-tap). The
    // session's optimistic versioning means exactly one can win; the loser
    // surfaces a recoverable version conflict instead of silently skipping a
    // step.
    const [a, b] = await Promise.allSettled([
      ctx.guide.completeCurrentAction('user-1'),
      ctx.guide.completeCurrentAction('user-1'),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      // The in-memory lock throws a plain Error; the recovery layer classifies
      // it as a version conflict — either way the loser must NOT advance.
      const reason = (r as PromiseRejectedResult).reason as { code?: string; message?: string };
      const isConflict = /version conflict/i.test(reason.message ?? '');
      const isPhaseError = reason.code === 'INVALID_PHASE';
      expect(isConflict || isPhaseError).toBe(true);
    }

    // Exactly one step was consumed — still on prep step 2, never step 3.
    const after = await ctx.guide.getCurrentAction('user-1');
    expect(after.phase).toBe('PREP_GUIDANCE');
    expect(after.stepNumber).toBe(2);
  });
});

describe('K9 scenario 6 — missing ingredient → substitution → resume', () => {
  it('substitution replaces the ingredient, revalidates, and resumes the exact step', async () => {
    const ctx = makeContext();
    await ctx.recipes.createRecipe(makeRecipe());
    await ctx.guide.launchCookWithMe('user-1', 'recipe-1');

    const sub = await ctx.guide.requestSubstitution('user-1', undefined, 'milk');
    expect(sub.candidates.length).toBeGreaterThan(0);

    const applied = await ctx.guide.applySubstitution('user-1', undefined, {
      unavailableIngredient: 'milk',
      replacement: sub.candidates[0].ingredient,
    });
    expect(applied.validation.valid).toBe(true);
    expect(applied.snapshot.phase).toBe('PREP_GUIDANCE');
    expect(applied.snapshot.stepNumber).toBe(1);
  });
});

describe('K9 scenario 10 — dietary restriction incompatible with the recipe', () => {
  it('validation prevents presenting a recipe that violates an allergy', () => {
    const recipe = makeRecipe({ allergens: ['peanuts'] });
    const result = validateRecipe(recipe, {
      allergies: ['peanuts'],
      dietaryRestrictions: [],
      availableEquipment: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.severity === 'error' && /peanut/i.test(e.message))).toBe(true);
  });

  it('a compatible recipe passes validation and is presentable', () => {
    const recipe = makeRecipe({ allergens: [] });
    const result = validateRecipe(recipe, {
      allergies: ['shellfish'],
      dietaryRestrictions: [],
      availableEquipment: ['pan', 'knife'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('K9 scenario 8 — tool call fails honestly', () => {
  it('a failed tool surfaces a structured error and never a false success', async () => {
    const ctx = makeContext();
    const result = await executeTool(registry, ctx.ctx, 'get_current_step', { sessionId: 'missing' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBeTruthy();
    expect(result.error?.recoverable).toBe(true);
    // The failure is also durable in the log trail.
    const entry = ctx.logs.listLogs().at(-1);
    expect(entry?.result.success).toBe(false);
  });
});

describe('K9 scenario 4 + 5 — previous and repeat', () => {
  it('previous goes back one step; repeat replays the current step', async () => {
    const ctx = makeContext();
    await ctx.recipes.createRecipe(makeRecipe());
    await ctx.guide.launchCookWithMe('user-1', 'recipe-1');
    await ctx.guide.completeCurrentAction('user-1'); // → prep 2

    const back = await ctx.guide.previousAction('user-1');
    expect(back.stepNumber).toBe(1);

    const repeated = await ctx.guide.repeatAction('user-1');
    expect(repeated.instruction).toBe('Dice the onion');
  });
});
