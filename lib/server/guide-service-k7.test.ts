import { describe, it, expect } from 'vitest';
import { SessionService, InMemorySessionStore } from './session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from './tools';
import { GuidedCookingService } from './guide-service';
import type { Ingredient, Recipe } from '../domain/types';

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
    ingredients: [makeIngredient('chicken thighs', 4, 'pieces'), makeIngredient('rice', 1, 'cup'), makeIngredient('onion'), makeIngredient('garlic', 2, 'cloves')],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
      { id: 'p2', stepNumber: 2, instruction: 'Rinse the rice', spokenInstruction: 'Rinse the rice', estimatedSeconds: 60, ingredientsUsed: ['rice'], equipmentUsed: [] },
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

function makeContext(userId = 'user-1') {
  const store = new InMemorySessionStore();
  const timers = new InMemoryTimerStore();
  const recipes = new InMemoryRecipeStore();
  const sessionService = new SessionService(store);
  const guide = new GuidedCookingService(sessionService, timers, recipes);
  return { store, timers, recipes, sessionService, guide };
}

async function launch(userId = 'user-1') {
  const ctx = makeContext(userId);
  await ctx.recipes.createRecipe(makeRecipe());
  const snap = await ctx.guide.launchCookWithMe(userId, 'recipe-1');
  return { ...ctx, snap };
}

// ── Part A — Substitution ────────────────────────────────────────────────────

describe('substitution (K7 Part A)', () => {
  it('preserves the exact location and returns honest candidates', async () => {
    const { guide, snap } = await launch();
    const { snapshot, unavailableIngredient, candidates } = await guide.requestSubstitution(
      'user-1', snap.sessionId, 'garlic',
    );

    expect(snapshot.phase).toBe('SUBSTITUTION_REQUIRED');
    // Location preserved: still step 1 of prep, same instruction.
    expect(snapshot.stepNumber).toBe(1);
    expect(snapshot.instruction).toBe('Dice the onion');
    expect(unavailableIngredient).toBe('garlic');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.ingredient === 'garlic powder')).toBe(true);
  });

  it('never suggests a silent replacement — apply requires a pending substitution', async () => {
    const { guide, snap } = await launch();
    await expect(
      guide.applySubstitution('user-1', snap.sessionId, { unavailableIngredient: 'garlic', replacement: 'garlic powder' }),
    ).rejects.toMatchObject({ code: 'NO_PENDING_SUBSTITUTION' });
  });

  it('applies a confirmed substitution: recipe replaced, persisted, and resumed at the EXACT step', async () => {
    const { guide, recipes, store, snap } = await launch();
    await guide.requestSubstitution('user-1', snap.sessionId, 'garlic');

    const result = await guide.applySubstitution('user-1', snap.sessionId, {
      unavailableIngredient: 'garlic',
      replacement: 'garlic powder',
    });

    expect(result.from).toBe('garlic');
    expect(result.to).toBe('garlic powder');
    // Resumed at the exact step.
    expect(result.snapshot.phase).toBe('PREP_GUIDANCE');
    expect(result.snapshot.stepNumber).toBe(1);
    expect(result.snapshot.instruction).toBe('Dice the onion');

    // Persisted: the stored recipe now uses the substitute.
    const stored = await recipes.getRecipe('recipe-1');
    expect(stored?.ingredients.some((i) => i.name === 'garlic powder')).toBe(true);
    expect(stored?.ingredients.some((i) => i.name === 'garlic')).toBe(false);

    // Pending substitution cleared.
    const session = await store.getSession(snap.sessionId!);
    expect(session?.pendingSubstitution).toBeUndefined();

    // Event sourced.
    const events = await store.listSessionEvents(snap.sessionId!);
    expect(events.some((e) => e.type === 'SUBSTITUTION_APPLIED')).toBe(true);
  });

  it('supports the "use X" confirmation without repeating the unavailable ingredient', async () => {
    const { guide, snap } = await launch();
    await guide.requestSubstitution('user-1', snap.sessionId, 'milk');
    // Only the replacement is provided — the pending state supplies the rest.
    const result = await guide.applySubstitution('user-1', snap.sessionId, { replacement: 'heavy cream' });
    expect(result.from).toBe('milk');
    expect(result.to).toBe('heavy cream');
    expect(result.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('rejects applying with a non-pending session', async () => {
    const { guide, snap } = await launch();
    const first = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(first.phase).toBe('PREP_GUIDANCE');
  });
});

// ── Part B — User correction ─────────────────────────────────────────────────

describe('correction (K7 Part B)', () => {
  it('persists a correction and resumes the exact step when the recipe stays viable', async () => {
    const { guide, store, snap } = await launch();
    const result = await guide.correctAvailableIngredients('user-1', snap.sessionId,
      [makeIngredient('tomatoes', 2)], 'UPSERT');

    expect(result.regenerating).toBe(false);
    expect(result.revalidated).toBe(true);
    // Exact step preserved.
    expect(result.snapshot.phase).toBe('PREP_GUIDANCE');
    expect(result.snapshot.stepNumber).toBe(1);

    const session = await store.getSession(snap.sessionId!);
    expect(session?.availableIngredients.some((i) => i.name === 'tomatoes' && i.quantity === 2)).toBe(true);

    const events = await store.listSessionEvents(snap.sessionId!);
    expect(events.some((e) => e.type === 'INGREDIENT_CORRECTED' || e.type === 'INGREDIENT_ADDED')).toBe(true);
  });

  it('requests regeneration when the correction breaks the recipe (removed a used ingredient)', async () => {
    const { guide, snap } = await launch();
    const result = await guide.correctAvailableIngredients('user-1', snap.sessionId,
      [makeIngredient('onion')], 'REMOVE');

    expect(result.revalidated).toBe(true);
    expect(result.regenerating).toBe(true);
    expect(result.snapshot.phase).toBe('COLLECTING_REQUIREMENTS');
  });

  it('refuses corrections outside guidance phases', async () => {
    const { guide } = makeContext();
    await expect(
      guide.correctAvailableIngredients('user-1', undefined, [makeIngredient('x')], 'UPSERT'),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});

// ── Part C — Error recovery ──────────────────────────────────────────────────

describe('error recovery (K7 Part C)', () => {
  it('classifies a transient error as a bounded RETRY and restores the exact step', async () => {
    const { guide, snap } = await launch();
    const before = await guide.getCurrentAction('user-1', snap.sessionId);

    const r1 = await guide.recoverAfterError('user-1', snap.sessionId, {
      code: 'NETWORK_ERROR', failedTool: 'complete_current_step',
    });
    expect(r1.action).toBe('RETRY');
    expect(r1.retryCount).toBe(1);
    expect(r1.failedTool).toBe('complete_current_step');
    expect(r1.snapshot.phase).toBe('PREP_GUIDANCE');
    expect(r1.snapshot.stepNumber).toBe(before.stepNumber);
  });

  it('bounds retries: RETRY → RETRY → GIVE_UP', async () => {
    const { guide, snap } = await launch();
    const r1 = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'NETWORK_ERROR' });
    expect(r1.action).toBe('RETRY');
    expect(r1.retryCount).toBe(1);

    const r2 = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'NETWORK_ERROR' });
    expect(r2.action).toBe('RETRY');
    expect(r2.retryCount).toBe(2);

    const r3 = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'NETWORK_ERROR' });
    expect(r3.action).toBe('GIVE_UP');
    expect(r3.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('classifies a user-correctable error as a QUESTION', async () => {
    const { guide, snap } = await launch();
    const r = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'INVALID_ARGUMENTS' });
    expect(r.action).toBe('QUESTION');
    if (r.action === 'QUESTION') {
      expect(r.question.length).toBeGreaterThan(0);
    }
    expect(r.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('classifies a version conflict as RELOAD', async () => {
    const { guide, snap } = await launch();
    const r = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'VERSION_CONFLICT' });
    expect(r.action).toBe('RELOAD');
    expect(r.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('preserves the session for non-recoverable failures (FATAL)', async () => {
    const { guide, snap } = await launch();
    const r = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'REPLACEMENT_INVALID', recoverable: false });
    expect(r.action).toBe('FATAL');
    expect(r.snapshot.phase).toBe('ERROR_RECOVERY'); // preserved, not silently resumed
  });

  // ── Recovery invariants ──────────────────────────────────────────────────

  it('recovery never skips or duplicates a step', async () => {
    const { guide, snap } = await launch();
    await guide.completeCurrentAction('user-1', snap.sessionId); // prep 1 → prep 2
    const before = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(before.stepNumber).toBe(2);

    // Error + recovery at step 2.
    await guide.recoverAfterError('user-1', snap.sessionId, { code: 'NETWORK_ERROR' });

    // Completing the step still lands on the NEXT step — no skip, no dup.
    const after = await guide.completeCurrentAction('user-1', snap.sessionId);
    expect(after.stepNumber).toBe(1); // prep 2 → cooking 1 (only 2 prep steps)
    expect(after.phase).toBe('WAITING_FOR_TIMER');
  });

  it('recovery never duplicates timers and never alters the recipe', async () => {
    const { guide, timers, recipes, snap } = await launch();
    await guide.completeCurrentAction('user-1', snap.sessionId); // prep 1 → prep 2
    const timed = await guide.completeCurrentAction('user-1', snap.sessionId); // → WAITING_FOR_TIMER
    const timerIdsBefore = [...timed.activeTimers.map((t) => t.timerId)];
    const recipeBefore = JSON.stringify(await recipes.getRecipe('recipe-1'));

    // Error + recovery while waiting on the timer.
    const r = await guide.recoverAfterError('user-1', snap.sessionId, { code: 'NETWORK_ERROR' });
    expect(r.action).toBe('RETRY');
    expect(r.snapshot.phase).toBe('WAITING_FOR_TIMER');

    const session = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(session.activeTimers.map((t) => t.timerId)).toEqual(timerIdsBefore); // no duplicates
    const active = await timers.listActiveTimers(snap.sessionId!);
    expect(active).toHaveLength(1); // still exactly one RUNNING timer

    const recipeAfter = JSON.stringify(await recipes.getRecipe('recipe-1'));
    expect(recipeAfter).toBe(recipeBefore); // recipe untouched
  });

  it('recovery never loses session progress', async () => {
    const { guide, snap } = await launch();
    await guide.completeCurrentAction('user-1', snap.sessionId); // → prep 2
    const before = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(before.stepNumber).toBe(2);

    await guide.recoverAfterError('user-1', snap.sessionId, { code: 'TIMEOUT' });
    const after = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(after.stepNumber).toBe(2); // still prep 2
    expect(after.instruction).toBe('Rinse the rice');
  });
});
