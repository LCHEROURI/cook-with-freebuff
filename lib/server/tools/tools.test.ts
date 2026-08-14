import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionService, InMemorySessionStore } from '../session-service';
import {
  createDefaultToolRegistry,
  executeTool,
  defaultSanitize,
  InMemoryTimerStore,
  InMemoryLogStore,
  InMemoryRecipeStore,
} from './index';
import { ToolRegistry } from './registry';
import { generateRecipeTool } from './recipe-tools';
import type { ToolContext } from './types';
import { registerRecipeGenerator, registerRecipeValidator, registerSubstitutionService, resetProviders } from '../../ai/provider';
import type { Recipe, Ingredient } from '../../domain/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
    ingredients: [
      makeIngredient('chicken thighs', 4, 'pieces'),
      makeIngredient('rice', 1, 'cup'),
      makeIngredient('onion'),
    ],
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

// ── Test context builder ─────────────────────────────────────────────────────

function makeContext(userId = 'user-1'): {
  ctx: ToolContext;
  store: InMemorySessionStore;
  timers: InMemoryTimerStore;
  logs: InMemoryLogStore;
  recipes: InMemoryRecipeStore;
} {
  const store = new InMemorySessionStore();
  const timers = new InMemoryTimerStore();
  const logs = new InMemoryLogStore();
  const recipes = new InMemoryRecipeStore();
  const sessionService = new SessionService(store);
  return {
    ctx: { userId, sessionService, timerStore: timers, logStore: logs, recipeStore: recipes },
    store,
    timers,
    logs,
    recipes,
  };
}

const registry = createDefaultToolRegistry();

describe('executor contract', () => {
  it('returns UNKNOWN_TOOL for an unregistered tool', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'no_such_tool', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('rejects invalid arguments with INVALID_ARGUMENTS', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'start_timer', {
      label: 'x',
      durationSeconds: -5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENTS');
  });

  it('logs every call with sanitized args, result, and latency', async () => {
    const { ctx, logs } = makeContext();
    await executeTool(registry, ctx, 'start_cooking_session', {});
    const entries = logs.listLogs();
    expect(entries.length).toBe(1);
    expect(entries[0].tool).toBe('start_cooking_session');
    expect(entries[0].userId).toBe('user-1');
    expect(entries[0].result.success).toBe(true);
    expect(entries[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('records failures in the log without throwing', async () => {
    const { ctx, logs } = makeContext();
    const result = await executeTool(registry, ctx, 'complete_current_step', {});
    expect(result.success).toBe(false);
    const entry = logs.listLogs()[0];
    expect(entry.result.success).toBe(false);
    expect(entry.result.errorCode).toBe('SESSION_NOT_FOUND');
  });
});

describe('defaultSanitize', () => {
  it('drops secret-looking keys recursively', () => {
    const cleaned = defaultSanitize({
      name: 'garlic',
      apiKey: 'sk-123',
      nested: { secret: 'x', token: 'y', safe: true },
    });
    expect(cleaned).toEqual({ name: 'garlic', nested: { safe: true } });
  });

  it('truncates long strings', () => {
    const cleaned = defaultSanitize({ text: 'a'.repeat(1000) });
    expect((cleaned as { text: string }).text.length).toBeLessThan(600);
  });
});

describe('ingredient tools', () => {
  it('save_available_ingredients replaces the list', async () => {
    const { ctx } = makeContext();
    await executeTool(registry, ctx, 'start_cooking_session', {});
    const result = await executeTool(registry, ctx, 'save_available_ingredients', {
      ingredients: [makeIngredient('tomato', 3), makeIngredient('garlic', 2)],
    });
    expect(result.success).toBe(true);
    const data = result.data as { ingredients: Ingredient[] };
    expect(data.ingredients.map((i) => i.name)).toEqual(['tomato', 'garlic']);
  });

  it('update_available_ingredients merges by name', async () => {
    const { ctx } = makeContext();
    await executeTool(registry, ctx, 'start_cooking_session', {});
    await executeTool(registry, ctx, 'save_available_ingredients', {
      ingredients: [makeIngredient('tomato', 3), makeIngredient('garlic', 2)],
    });
    const result = await executeTool(registry, ctx, 'update_available_ingredients', {
      ingredients: [makeIngredient('tomato', 4), makeIngredient('onion', 1)],
    });
    const data = result.data as { ingredients: Ingredient[] };
    const names = data.ingredients.map((i) => i.name);
    expect(names).toContain('garlic');
    expect(names).toContain('onion');
    expect(data.ingredients.find((i) => i.name === 'tomato')?.quantity).toBe(4);
  });

  it('confirm_available_ingredients advances the phase', async () => {
    const { ctx } = makeContext();
    await executeTool(registry, ctx, 'start_cooking_session', {});
    const result = await executeTool(registry, ctx, 'confirm_available_ingredients', {});
    expect(result.success).toBe(true);
    const data = result.data as { phase: string };
    expect(data.phase).toBe('CONFIRMING_INGREDIENTS');
  });

  it('rejects confirm when not in COLLECTING_INGREDIENTS', async () => {
    const { ctx } = makeContext();
    await executeTool(registry, ctx, 'start_cooking_session', {});
    await executeTool(registry, ctx, 'confirm_available_ingredients', {});
    const result = await executeTool(registry, ctx, 'confirm_available_ingredients', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
  });

  it('emits ingredient events on the session', async () => {
    const { ctx, store } = makeContext();
    const session = await (ctx.sessionService as SessionService).createSession('user-1');
    await executeTool(registry, ctx, 'save_available_ingredients', {
      sessionId: session.id,
      ingredients: [makeIngredient('rice', 1, 'cup')],
    });
    await executeTool(registry, ctx, 'update_available_ingredients', {
      sessionId: session.id,
      ingredients: [makeIngredient('salt', 1, null)],
    });
    const events = await store.listSessionEvents(session.id);
    expect(events.some((e) => e.type === 'INGREDIENT_CORRECTED')).toBe(true);
    expect(events.some((e) => e.type === 'INGREDIENT_ADDED')).toBe(true);
  });
});

describe('session tools', () => {
  it('start_cooking_session creates and reports the phase', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'start_cooking_session', {});
    expect(result.success).toBe(true);
    const data = result.data as { phase: string; sessionId: string };
    expect(data.phase).toBe('COLLECTING_INGREDIENTS');
    expect(data.sessionId).toBeTruthy();
  });

  it('get_cooking_session returns the active session', async () => {
    const { ctx } = makeContext();
    const started = (await executeTool(registry, ctx, 'start_cooking_session', {}))
      .data as { sessionId: string };
    const result = await executeTool(registry, ctx, 'get_cooking_session', {});
    expect(result.success).toBe(true);
    expect((result.data as { sessionId: string }).sessionId).toBe(started.sessionId);
  });

  it('get_current_step returns the recipe step when a recipe is attached', async () => {
    const { ctx, recipes } = makeContext();
    const recipe = makeRecipe();
    await recipes.createRecipe(recipe);

    // Start a session pinned to the recipe and drive it to PREP_GUIDANCE.
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1', { recipeId: 'recipe-1' });
    const phasePath = ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE'] as const;
    for (const phase of phasePath) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }

    const result = await executeTool(registry, ctx, 'get_current_step', {
      sessionId: s.id,
    });
    expect(result.success).toBe(true);
    const data = result.data as { instruction: string | undefined };
    expect(data.instruction).toBe('Dice the onion');
  });

  it('complete_current_step advances through prep and auto-starts a step timer (guided)', async () => {
    const { ctx, recipes } = makeContext();
    await recipes.createRecipe(makeRecipe());
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1', { recipeId: 'recipe-1' });
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }
    const result = await executeTool(registry, ctx, 'complete_current_step', { sessionId: s.id });
    expect(result.success).toBe(true);
    const data = result.data as {
      phase: string;
      instruction: string;
      timerStarted?: { label: string };
    };
    // The fixture recipe has 1 prep step and 1 cooking step (240s timer):
    // completing prep auto-transitions to cooking and starts the timer.
    expect(data.phase).toBe('WAITING_FOR_TIMER');
    expect(data.instruction).toBe('Sear the chicken four minutes');
    expect(data.timerStarted?.label).toBe('four-minute timer');
  });

  it('pause/resume round-trip preserves the step', async () => {
    const { ctx } = makeContext();
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1');
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }
    const paused = await executeTool(registry, ctx, 'pause_cooking_session', { sessionId: s.id });
    expect((paused.data as { status: string }).status).toBe('PAUSED');
    const resumed = await executeTool(registry, ctx, 'resume_cooking_session', { sessionId: s.id });
    expect(resumed.success).toBe(true);
    expect((resumed.data as { phase: string }).phase).toBe('PREP_GUIDANCE');
  });

  it('a same-ID retry after a failed rebase transitions ONCE through the tool (Codex P1 — PR #51)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      // The tool path (session-tools.ts) mirrors guide-service.resume: the
      // rollback re-pause must forget the ORIGINAL resume ID, or the client's
      // retry with that same ID gets swallowed as a processed duplicate while
      // the session sits PAUSED and the timers get rebased a second time.
      const store = new InMemorySessionStore();
      const sessionService = new SessionService(store);
      const flaky = new (class extends InMemoryTimerStore {
        failing = false;
        override async rebaseActiveTimers(sessionId: string, elapsedMs: number): Promise<void> {
          if (this.failing) throw new Error('simulated rebase write failure');
          return super.rebaseActiveTimers(sessionId, elapsedMs);
        }
      })();
      const logs = new InMemoryLogStore();
      const recipes = new InMemoryRecipeStore();
      await recipes.createRecipe(makeRecipe());
      const ctx: ToolContext = { userId: 'user-1', sessionService, timerStore: flaky, logStore: logs, recipeStore: recipes };

      const started = (await executeTool(registry, ctx, 'start_cooking_session', { recipeId: 'recipe-1' }))
        .data as { sessionId: string };
      let s = await store.getSession(started.sessionId);
      for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE'] as const) {
        const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' ? 'AGENT_TOOL' : 'USER_INPUT';
        s = (await sessionService.transitionTo(s!.id, s!.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT'))!;
      }
      await executeTool(registry, ctx, 'complete_current_step', { sessionId: s!.id }); // → WAITING_FOR_TIMER
      const [timer] = await flaky.listActiveTimers(s!.id);
      await flaky.updateTimer(timer.id, { startedAt: 1_000_000_000_000, endsAt: 1_000_000_000_000 + 180_000 });
      await executeTool(registry, ctx, 'pause_cooking_session', { sessionId: s!.id });
      vi.setSystemTime(1_000_000_000_000 + 120_000);

      // Rebase fails → rollback to PAUSED. Retry with the SAME correlation ID
      // (distinct per test: the processed set is module-level).
      flaky.failing = true;
      ctx.correlationId = 'resume-op-51-tool';
      const first = await executeTool(registry, ctx, 'resume_cooking_session', { sessionId: s!.id });
      expect(first.success).toBe(false);
      expect((first.error as { code?: string })?.code).toBe('TIMER_REBASE_FAILED');
      expect((await store.getSession(s!.id))?.currentPhase).toBe('PAUSED');

      flaky.failing = false;
      const retried = await executeTool(registry, ctx, 'resume_cooking_session', { sessionId: s!.id });
      expect(retried.success).toBe(true);
      expect((retried.data as { phase: string }).phase).toBe('WAITING_FOR_TIMER');
      const [rebased] = await flaky.listActiveTimers(s!.id);
      // Single shift from the ORIGINAL endsAt: now + 180s, never + 300s.
      expect(rebased.endsAt).toBe(Date.now() + 180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies access to another user\'s session (FORBIDDEN)', async () => {
    // Both contexts share the same store so the session is visible — only the
    // userId differs, proving object-level authorization, not just lookup.
    const store = new InMemorySessionStore();
    const sessionService = new SessionService(store);
    const timers = new InMemoryTimerStore();
    const logs = new InMemoryLogStore();
    const recipes = new InMemoryRecipeStore();

    const ownerCtx: ToolContext = { userId: 'user-1', sessionService, timerStore: timers, logStore: logs, recipeStore: recipes };
    const otherCtx: ToolContext = { userId: 'user-2', sessionService, timerStore: timers, logStore: logs, recipeStore: recipes };

    const started = (await executeTool(registry, ownerCtx, 'start_cooking_session', {}))
      .data as { sessionId: string };
    const result = await executeTool(registry, otherCtx, 'get_cooking_session', {
      sessionId: started.sessionId,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
  });
});

describe('timer tools', () => {
  it('start_timer creates backend state and enters WAITING_FOR_TIMER', async () => {
    const { ctx, timers } = makeContext();
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1');
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' || phase === 'PREP_GUIDANCE' || phase === 'COOKING_GUIDANCE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }

    const result = await executeTool(registry, ctx, 'start_timer', {
      sessionId: s.id,
      label: 'Chicken timer',
      durationSeconds: 240,
    });
    expect(result.success).toBe(true);
    const data = result.data as { timerId: string; phase: string };
    expect(data.phase).toBe('WAITING_FOR_TIMER');

    const timer = await timers.getTimer(data.timerId);
    expect(timer).not.toBeNull();
    expect(timer!.status).toBe('RUNNING');
    expect(timer!.endsAt).toBeGreaterThan(Date.now());
  });

  it('get_active_timers lists running timers', async () => {
    const { ctx } = makeContext();
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1');
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' || phase === 'PREP_GUIDANCE' || phase === 'COOKING_GUIDANCE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }
    await executeTool(registry, ctx, 'start_timer', { sessionId: s.id, label: 'T1', durationSeconds: 60 });
    const result = await executeTool(registry, ctx, 'get_active_timers', { sessionId: s.id });
    expect(result.success).toBe(true);
    expect((result.data as { timers: unknown[] }).timers.length).toBe(1);
  });

  it('complete_timer returns the session to COOKING_GUIDANCE', async () => {
    const { ctx, timers } = makeContext();
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1');
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' || phase === 'PREP_GUIDANCE' || phase === 'COOKING_GUIDANCE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }
    const started = (await executeTool(registry, ctx, 'start_timer', { sessionId: s.id, label: 'T', durationSeconds: 30 }))
      .data as { timerId: string };

    const result = await executeTool(registry, ctx, 'complete_timer', { timerId: started.timerId });
    expect(result.success).toBe(true);
    const data = result.data as { phase: string; status: string };
    expect(data.phase).toBe('COOKING_GUIDANCE');
    expect(data.status).toBe('COMPLETED');

    const timer = await timers.getTimer(started.timerId);
    expect(timer!.status).toBe('COMPLETED');
  });

  it('cancel_timer marks the timer cancelled', async () => {
    const { ctx, timers } = makeContext();
    const service = ctx.sessionService as SessionService;
    let s = await service.createSession('user-1');
    for (const phase of ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE'] as const) {
      const reason = phase === 'GENERATING_RECIPE' || phase === 'VALIDATING_RECIPE' || phase === 'PREP_GUIDANCE' || phase === 'COOKING_GUIDANCE' ? 'AGENT_TOOL' : 'USER_INPUT';
      s = await service.transitionTo(s.id, s.version, phase, reason as 'AGENT_TOOL' | 'USER_INPUT');
    }
    const started = (await executeTool(registry, ctx, 'start_timer', { sessionId: s.id, label: 'T', durationSeconds: 30 }))
      .data as { timerId: string };
    const result = await executeTool(registry, ctx, 'cancel_timer', { timerId: started.timerId });
    expect(result.success).toBe(true);
    expect((await timers.getTimer(started.timerId))!.status).toBe('CANCELLED');
  });
});

describe('recipe tools', () => {
  beforeEach(() => {
    resetProviders();
  });

  it('resize_recipe scales quantities deterministically', async () => {
    const { ctx } = makeContext();
    const recipe = makeRecipe();
    const result = await executeTool(registry, ctx, 'resize_recipe', { recipe, servings: 4 });
    expect(result.success).toBe(true);
    const scaled = (result.data as { recipe: Recipe }).recipe;
    expect(scaled.servings).toBe(4);
    const chicken = scaled.ingredients.find((i) => i.name === 'chicken thighs')!;
    expect(chicken.quantity).toBe(8);
  });

  it('resize_recipe keeps unknown quantities null', async () => {
    const { ctx } = makeContext();
    const recipe = makeRecipe();
    const result = await executeTool(registry, ctx, 'resize_recipe', { recipe, servings: 4 });
    const onion = (result.data as { recipe: Recipe }).recipe.ingredients.find((i) => i.name === 'onion')!;
    expect(onion.quantity).toBeNull();
  });

  it('generate_recipe uses the registered provider and persists', async () => {
    const { ctx, recipes } = makeContext();
    registerRecipeGenerator('default', {
      async generate() {
        return makeRecipe();
      },
    });
    const result = await executeTool(registry, ctx, 'generate_recipe', {
      request: {
        ingredientsAvailable: [makeIngredient('chicken')],
        servings: 4,
        dietaryRestrictions: ['vegetarian'],
        allergies: ['peanuts'],
        cuisinePreferences: [],
        dislikedIngredients: [],
        availableEquipment: [],
      },
    });
    expect(result.success).toBe(true);
    const saved = await recipes.getRecipe('recipe-1');
    expect(saved).not.toBeNull();
    // The user-provided build constraints are stamped onto the persisted
    // recipe — a saved recipe records what it was built FOR (the /cook
    // "Your recipes" rows surface them).
    expect(saved!.preferences).toEqual({
      servings: 4,
      allergies: ['peanuts'],
      dietaryRestrictions: ['vegetarian'],
    });
  });

  it('generate_recipe reports GENERATION_UNAVAILABLE without a provider', async () => {
    const { ctx } = makeContext();
    // A registry with the tool registered but no provider bound.
    const noProvider = new ToolRegistry().register(generateRecipeTool);
    const result = await executeTool(noProvider, ctx, 'generate_recipe', {
      request: { ingredientsAvailable: [makeIngredient('x')] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GENERATION_UNAVAILABLE');
  });

  it('validate_recipe uses the registered validator', async () => {
    const { ctx } = makeContext();
    registerRecipeValidator('default', {
      async validate() {
        return { valid: true, errors: [], warnings: [], missingConfirmations: [] };
      },
    });
    const result = await executeTool(registry, ctx, 'validate_recipe', { recipe: makeRecipe() });
    expect(result.success).toBe(true);
    expect((result.data as { valid: boolean }).valid).toBe(true);
  });

  it('replace_ingredient swaps the name everywhere', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'replace_ingredient', {
      recipe: makeRecipe(),
      from: 'chicken thighs',
      to: 'turkey thighs',
    });
    expect(result.success).toBe(true);
    const updated = (result.data as { recipe: Recipe }).recipe;
    expect(updated.ingredients.find((i) => i.name === 'turkey thighs')).toBeDefined();
    expect(updated.ingredients.some((i) => i.name === 'chicken thighs')).toBe(false);
    expect(updated.cookingSteps[0].ingredientsUsed).toContain('turkey thighs');
  });

  it('find_substitution uses the registered provider', async () => {
    const { ctx } = makeContext();
    registerSubstitutionService('default', {
      async findSubstitution() {
        return [{ ingredient: 'shallot', ratio: '1:1', notes: 'milder than onion' }];
      },
    });
    const result = await executeTool(registry, ctx, 'find_substitution', {
      unavailableIngredient: 'onion',
      recipe: makeRecipe(),
      availablePantry: ['shallot'],
    });
    expect(result.success).toBe(true);
    expect((result.data as { candidates: unknown[] }).candidates.length).toBe(1);
  });
});

