import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from './route';
import { SessionService, InMemorySessionStore } from '@/lib/server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '@/lib/server/tools';
import type { ToolContext } from '@/lib/server/tools/types';
import type { Recipe } from '@/lib/domain/types';

vi.mock('@/lib/server/admin', () => ({ resolveUserId: vi.fn() }));
vi.mock('@/lib/server/stores', () => ({ buildProductionContext: vi.fn() }));
vi.mock('@/lib/server/app-check', () => ({ gateAppCheck: vi.fn(async () => null) }));

import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';
import { registerRecipeGenerator, resetProviders } from '@/lib/ai/provider';

const mockResolve = resolveUserId as ReturnType<typeof vi.fn>;
const mockBuild = buildProductionContext as ReturnType<typeof vi.fn>;

// A self-consistent generated recipe (every step reference exists in the
// ingredient list) so create_recipe's validation passes cleanly.
function makeGeneratedRecipe(): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-generated-1',
    title: 'Chicken Thighs with Rice',
    description: 'Generated for the create_recipe test',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 20,
    totalMinutes: 30,
    ingredients: [
      { id: 'g1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'g2', name: 'rice', quantity: 2, unit: 'cups', optional: false },
    ],
    equipment: ['pan'],
    prepSteps: [
      { id: 'gp1', stepNumber: 1, instruction: 'Rinse the rice', spokenInstruction: 'Rinse the rice', estimatedSeconds: 60, ingredientsUsed: ['rice'], equipmentUsed: [] },
    ],
    cookingSteps: [
      { id: 'gc1', stepNumber: 1, instruction: 'Cook the chicken 15 minutes', spokenInstruction: 'Cook the chicken fifteen minutes', estimatedSeconds: 900, timerSeconds: 900, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
  };
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
    ingredients: [{ id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false }],
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

function testContext(userId: string): ToolContext {
  const store = new InMemorySessionStore();
  const recipes = new InMemoryRecipeStore();
  return {
    userId,
    sessionService: new SessionService(store),
    timerStore: new InMemoryTimerStore(),
    logStore: new InMemoryLogStore(),
    recipeStore: recipes,
  };
}

function post(body: unknown, token = 'Bearer fake-token') {
  return POST(
    new Request('http://localhost/api/cook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

describe('/api/cook', () => {
  // One shared context per test — sessions/recipes must persist across the
  // separate requests of a flow (launch → done → status).
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('user-1');
    ctx = testContext('user-1');
    mockBuild.mockImplementation(() => ctx);
    // No AI providers by default — each create_recipe test registers its own
    // stub generator (the deployed app wires the real Gemini one).
    resetProviders();
  });

  it('returns 401 without a valid token', async () => {
    mockResolve.mockResolvedValue(null);
    const res = await post({ action: 'status' }, '');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('launch starts guided cooking and returns the first single action', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());

    const res = await post({ action: 'launch', recipeId: 'recipe-1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.phase).toBe('PREP_GUIDANCE');
    expect(body.data.instruction).toBe('Dice the onion');
    expect(body.data.stepNumber).toBe(1);
  });

  it('launch without recipeId returns 400', async () => {
    const res = await post({ action: 'launch' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('done advances to the timed cooking step (auto-started timer)', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());

    await post({ action: 'launch', recipeId: 'recipe-1' });
    const res = await post({ action: 'done' });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.phase).toBe('WAITING_FOR_TIMER');
    expect(body.data.timerStarted?.label).toBe('four-minute timer');
  });

  it('a resume retry after a TIMER_REBASE_FAILED rollback yields exactly ONE rebase end to end (Codex P1 — PR #53)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      // Swap the shared ctx's timer store for a flaky one that fails the
      // ATOMIC rebase on demand — the exact failure surface of the P1 chain:
      // transition → rebase fails → rollback to PAUSED → client retries with
      // the SAME correlation ID. The retry must transition once and rebase
      // from the ORIGINAL endsAt exactly once, end to end through the route.
      const flaky = new (class extends InMemoryTimerStore {
        failing = false;
        override async rebaseActiveTimers(sessionId: string, elapsedMs: number): Promise<void> {
          if (this.failing) throw new Error('simulated rebase write failure');
          return super.rebaseActiveTimers(sessionId, elapsedMs);
        }
      })();
      ctx = { ...ctx, timerStore: flaky };

      await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());
      await post({ action: 'launch', recipeId: 'recipe-1' });
      await post({ action: 'done' }); // → WAITING_FOR_TIMER, 240s timer auto-started
      const session = await ctx.sessionService.getActiveSession('user-1');
      const sessionId = session!.id;
      const [timer] = await flaky.listActiveTimers(sessionId);
      await flaky.updateTimer(timer.id, { startedAt: 1_000_000_000_000, endsAt: 1_000_000_000_000 + 180_000 });
      await post({ action: 'pause' });
      vi.setSystemTime(1_000_000_000_000 + 120_000);

      // First resume: rebase fails → route returns 400 TIMER_REBASE_FAILED
      // and the session rolls back to PAUSED with the ORIGINAL pausedAt.
      flaky.failing = true;
      const failed = await post({ action: 'resume', correlationId: 'route-resume-53' });
      expect(failed.status).toBe(400);
      const failedBody = await failed.json();
      expect(failedBody.success).toBe(false);
      expect(failedBody.error.code).toBe('TIMER_REBASE_FAILED');
      expect(failedBody.error.recoverable).toBe(true);
      const rolledBack = await ctx.sessionService.getSession(sessionId);
      expect(rolledBack?.currentPhase).toBe('PAUSED');

      // Retry with the SAME correlation ID while the store is healthy. The
      // rollback cleared the original ID, so this transitions PAUSED → ACTIVE
      // once and rebases from the untouched endsAt — exactly one shift, never
      // a swallowed duplicate or a second rebase.
      flaky.failing = false;
      const retried = await post({ action: 'resume', correlationId: 'route-resume-53' });
      expect(retried.status).toBe(200);
      const retriedBody = await retried.json();
      expect(retriedBody.success).toBe(true);
      expect(retriedBody.data.phase).toBe('WAITING_FOR_TIMER');

      const [rebased] = await flaky.listActiveTimers(sessionId);
      // endsAt was t0 + 180s at pause; 120s elapsed; a single rebase lands it
      // at now + 180s (a second shift would push it to now + 300s).
      expect(rebased.endsAt).toBe(Date.now() + 180_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('done surfaces a safety gate before completing a step with a safetyNote', async () => {
    const recipes = ctx.recipeStore as InMemoryRecipeStore;
    await recipes.createRecipe({
      ...makeRecipe(),
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: 'Heat the oil on high', spokenInstruction: 'Heat the oil on high', estimatedSeconds: 60, ingredientsUsed: [], equipmentUsed: ['pan'], safetyNote: 'Hot oil — keep children away' },
        { id: 'p2', stepNumber: 2, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
      ],
    });

    await post({ action: 'launch', recipeId: 'recipe-1' });
    const gated = await post({ action: 'done' });
    const gatedBody = await gated.json();
    expect(gatedBody.success).toBe(true);
    expect(gatedBody.data.phase).toBe('SAFETY_WARNING');
    expect(gatedBody.data.safetyGate.note).toBe('Hot oil — keep children away');
    expect(gatedBody.data.stepNumber).toBe(1); // progress preserved

    // The acknowledgment "done" completes the step and advances.
    const ack = await post({ action: 'done' });
    const ackBody = await ack.json();
    expect(ackBody.success).toBe(true);
    expect(ackBody.data.phase).toBe('PREP_GUIDANCE');
    expect(ackBody.data.stepNumber).toBe(2);
    expect(ackBody.data.instruction).toBe('Dice the onion');
  });

  it('status returns found:false with no session', async () => {
    const res = await post({ action: 'status' });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.found).toBe(false);
  });

  it('GET returns the active session status', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());
    await post({ action: 'launch', recipeId: 'recipe-1' });

    const res = await GET(new Request('http://localhost/api/cook', {
      headers: { authorization: 'Bearer fake-token' },
    }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.phase).toBe('PREP_GUIDANCE');
  });

  it('surfaces a structured error when no session exists', async () => {
    // Switch to a fresh context with no session — "done" fails honestly.
    mockBuild.mockImplementation(() => testContext('other-user'));
    const res = await post({ action: 'done' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('substitute preserves the location and returns candidates', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());
    await post({ action: 'launch', recipeId: 'recipe-1' });

    const res = await post({ action: 'substitute', unavailableIngredient: 'garlic' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.snapshot.phase).toBe('SUBSTITUTION_REQUIRED');
    expect(body.data.snapshot.stepNumber).toBe(1);
    expect(body.data.candidates.length).toBeGreaterThan(0);
  });

  it('apply_substitution replaces, persists, and resumes the exact step', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());
    await post({ action: 'launch', recipeId: 'recipe-1' });
    await post({ action: 'substitute', unavailableIngredient: 'milk' });

    const res = await post({ action: 'apply_substitution', replacement: 'heavy cream' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.from).toBe('milk');
    expect(body.data.to).toBe('heavy cream');
    expect(body.data.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('recover classifies a transient error as a bounded RETRY', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());
    await post({ action: 'launch', recipeId: 'recipe-1' });

    const res = await post({ action: 'recover', errorCode: 'NETWORK_ERROR', failedTool: 'complete_current_step' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.action).toBe('RETRY');
    expect(body.data.retryCount).toBe(1);
    expect(body.data.snapshot.phase).toBe('PREP_GUIDANCE');
  });

  it('start_over archives the current session and returns a fresh one on the same recipe', async () => {
    await (ctx.recipeStore as InMemoryRecipeStore).createRecipe(makeRecipe());

    const first = await post({ action: 'launch', recipeId: 'recipe-1' });
    const firstBody = await first.json();
    const oldSessionId = firstBody.data.sessionId;

    const res = await post({ action: 'start_over' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.phase).toBe('PREP_GUIDANCE');
    expect(body.data.stepNumber).toBe(1);
    expect(body.data.recipeId).toBe('recipe-1');
    expect(body.data.sessionId).not.toBe(oldSessionId);

    // The old session is archived (ABANDONED) — the fresh one is the active one.
    const active = await ctx.sessionService.getActiveSession('user-1');
    expect(active?.id).toBe(body.data.sessionId);
  });

  describe('list_recipes — the reusable “Your recipes” list', () => {
    it('returns an empty list when the owner has no recipes', async () => {
      const res = await post({ action: 'list_recipes' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.recipes).toEqual([]);
    });

    it('returns only the owner’s recipes as lightweight summaries, newest first', async () => {
      const store = ctx.recipeStore as InMemoryRecipeStore;
      await store.createRecipe({ ...makeRecipe(), id: 'recipe-old', title: 'Old Stew', updatedAt: 1000 });
      await store.createRecipe({
        ...makeRecipe(),
        id: 'recipe-new',
        title: 'Fresh Pasta',
        updatedAt: 5000,
        preferences: { servings: 4, allergies: ['peanuts'], dietaryRestrictions: ['vegetarian'] },
      });
      // Another user's recipe must never leak into the list (userId isolation).
      await store.createRecipe({ ...makeRecipe(), id: 'recipe-other', userId: 'user-2', updatedAt: 9000 });

      const res = await post({ action: 'list_recipes' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.recipes).toHaveLength(2);
      expect(body.data.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual(['recipe-new', 'recipe-old']);
      const first = body.data.recipes[0];
      expect(first.title).toBe('Fresh Pasta');
      expect(first.servings).toBe(2);
      expect(first.totalMinutes).toBe(35);
      expect(first.ingredientCount).toBe(1);
      // The build constraints surface in the summary — the row shows what the
      // recipe was built for.
      expect(first.preferences).toEqual({ servings: 4, allergies: ['peanuts'], dietaryRestrictions: ['vegetarian'] });
      // A recipe created without preferences gets a safe empty shape (never
      // `undefined` — the client renders it unconditionally).
      expect(body.data.recipes[1].preferences).toEqual({ servings: null, allergies: [], dietaryRestrictions: [] });
      // The summary stays light — full step lists never leave the server.
      expect(first).not.toHaveProperty('ingredients');
      expect(first).not.toHaveProperty('cookingSteps');
      expect(first).not.toHaveProperty('prepSteps');
    });
  });

  describe('delete_recipe — removing a saved recipe from the browser', () => {
    it('returns 400 without a recipeId', async () => {
      const res = await post({ action: 'delete_recipe' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });

    it('deletes the owner’s recipe and returns the id', async () => {
      const store = ctx.recipeStore as InMemoryRecipeStore;
      await store.createRecipe(makeRecipe());

      const res = await post({ action: 'delete_recipe', recipeId: 'recipe-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.deleted).toBe('recipe-1');
      // The recipe is gone from the store (list reflects the deletion).
      expect(await store.getRecipe('recipe-1')).toBeNull();
      expect(await store.listRecipes('user-1')).toEqual([]);
    });

    it('refuses to delete another user’s recipe (ownership is enforced)', async () => {
      const store = ctx.recipeStore as InMemoryRecipeStore;
      await store.createRecipe({ ...makeRecipe(), id: 'recipe-other', userId: 'user-2' });

      const res = await post({ action: 'delete_recipe', recipeId: 'recipe-other' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      // The other user's recipe survives untouched.
      expect(await store.getRecipe('recipe-other')).not.toBeNull();
    });

    it('returns 404 when the recipe does not exist', async () => {
      const res = await post({ action: 'delete_recipe', recipeId: 'missing-recipe' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('get_recipe — reading one saved recipe', () => {
    it('returns 400 without a recipeId', async () => {
      const res = await post({ action: 'get_recipe' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });

    it('returns the owner’s full recipe', async () => {
      const store = ctx.recipeStore as InMemoryRecipeStore;
      await store.createRecipe(makeRecipe());

      const res = await post({ action: 'get_recipe', recipeId: 'recipe-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.recipe.title).toBe('Chicken Rice');
      // The FULL recipe comes back — every section the detail page renders.
      expect(body.data.recipe.ingredients).toEqual(makeRecipe().ingredients);
      expect(body.data.recipe.equipment).toEqual(['pan', 'knife']);
      expect(body.data.recipe.prepSteps).toEqual(makeRecipe().prepSteps);
      expect(body.data.recipe.cookingSteps).toEqual(makeRecipe().cookingSteps);
      expect(body.data.recipe.safetyNotes).toEqual(['Hot oil']);
    });

    it('refuses to read another user’s recipe (ownership is enforced)', async () => {
      const store = ctx.recipeStore as InMemoryRecipeStore;
      await store.createRecipe({ ...makeRecipe(), id: 'recipe-other', userId: 'user-2' });

      const res = await post({ action: 'get_recipe', recipeId: 'recipe-other' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
      // The other user's recipe survives untouched — reading is side-effect free.
      expect(await store.getRecipe('recipe-other')).not.toBeNull();
    });

    it('returns 404 when the recipe does not exist', async () => {
      const res = await post({ action: 'get_recipe', recipeId: 'missing-recipe' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('create_recipe — the missing start-from-scratch stage', () => {
    it('returns NO_INGREDIENTS when the prompt has nothing parseable', async () => {
      // A craving with no ingredient list (and the question gate keeps the
      // "I have …" retry from swallowing it either).
      const res = await post({ action: 'create_recipe', prompt: 'what should I cook?' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NO_INGREDIENTS');
    });

    it('returns INVALID_BODY without a prompt', async () => {
      const res = await post({ action: 'create_recipe' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });

    it('generates, validates and returns the recipe id for a parseable prompt', async () => {
      // Realistic model output: the generator omits generatedAt/updatedAt
      // (server metadata — the generation prompt never asks for them).
      registerRecipeGenerator('default', {
        generate: async () => {
          const { generatedAt, updatedAt, ...modelOutput } = makeGeneratedRecipe();
          return modelOutput as Recipe; // schema function defaults stamp the timestamps at parse
        },
      });

      const res = await post({ action: 'create_recipe', prompt: 'I have chicken thighs and rice' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.recipeId).toBe('recipe-generated-1');
      expect(body.data.title).toBe('Chicken Thighs with Rice');
      expect(body.data.validation.valid).toBe(true);
      expect(body.data.validation.confirmations).toEqual([]);
    });

    it('parses a bare list via the possession-lead-in retry', async () => {
      registerRecipeGenerator('default', { generate: async () => makeGeneratedRecipe() });

      const res = await post({ action: 'create_recipe', prompt: 'chicken thighs, rice' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.recipeId).toBe('recipe-generated-1');
    });

    it('persists the generated recipe into the owner store with stamped metadata', async () => {
      registerRecipeGenerator('default', {
        generate: async () => {
          const { generatedAt, updatedAt, ...modelOutput } = makeGeneratedRecipe();
          return modelOutput as Recipe;
        },
      });

      await post({ action: 'create_recipe', prompt: 'I have chicken thighs and rice' });
      const stored = await (ctx.recipeStore as InMemoryRecipeStore).getRecipe('recipe-generated-1');
      expect(stored).not.toBeNull();
      expect(stored?.userId).toBe('user-1'); // owner-stamped (K9 ownership)
      // Server metadata stamped at persist time (the model never provides it).
      expect(typeof stored?.generatedAt).toBe('number');
      expect((stored?.generatedAt ?? 0)).toBeGreaterThan(0);
      expect(typeof stored?.updatedAt).toBe('number');
    });

    it('reports GENERATION_UNAVAILABLE when no provider is registered', async () => {
      const res = await post({ action: 'create_recipe', prompt: 'I have chicken thighs' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('GENERATION_UNAVAILABLE');
    });

    it('threads servings, allergies, and dietary restrictions into the generation request', async () => {
      // The starter prompt can carry preferences: "…for 4 people, no peanuts,
      // vegetarian" — create_recipe must parse them and pass them to the
      // generator (the request the model actually reads).
      let received: unknown = null;
      registerRecipeGenerator('default', {
        generate: async (request: unknown) => {
          received = request;
          return makeGeneratedRecipe();
        },
      });

      const res = await post({
        action: 'create_recipe',
        prompt: 'I have chicken thighs and rice for 4 people, no peanuts, vegetarian',
      });
      expect(res.status).toBe(200);
      const req = received as {
        servings?: unknown;
        allergies?: unknown;
        dietaryRestrictions?: unknown;
        ingredientsAvailable?: { name: string }[];
      };
      expect(req.servings).toBe(4);
      expect(req.allergies).toEqual(['peanuts']);
      expect(req.dietaryRestrictions).toEqual(['vegetarian']);
      // The preference spans must be stripped BEFORE ingredient extraction —
      // “rice for 4 people” would otherwise become an ingredient name.
      expect(req.ingredientsAvailable?.map((i) => i.name)).toEqual(['chicken thighs', 'rice']);
    });

    it('echoes the parsed preferences in the response', async () => {
      registerRecipeGenerator('default', { generate: async () => makeGeneratedRecipe() });

      const res = await post({
        action: 'create_recipe',
        prompt: 'chicken thighs, rice — for 2, dairy-free, no sesame',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.preferences).toEqual({
        servings: 2,
        allergies: ['sesame'],
        dietaryRestrictions: ['dairy-free'],
      });
    });

    it('passes the generator a defaulted request (regression: undefined.length crash on deploy)', async () => {
      // The deployed route crashed with "Cannot read properties of undefined
      // (reading 'length')" because a raw { ingredientsAvailable, servings }
      // object skipped the tool's zod defaults (dietaryRestrictions, allergies,
      // …) that buildGenerationPrompt reads. The handler call must go through
      // the tool's inputSchema so every defaulted array arrives filled.
      let received: unknown = null;
      registerRecipeGenerator('default', {
        generate: async (request: unknown) => {
          received = request;
          return makeGeneratedRecipe();
        },
      });

      const res = await post({ action: 'create_recipe', prompt: 'I have chicken thighs and rice' });
      expect(res.status).toBe(200);
      const req = received as { dietaryRestrictions?: unknown; allergies?: unknown; cuisinePreferences?: unknown; dislikedIngredients?: unknown; availableEquipment?: unknown; servings?: unknown };
      expect(Array.isArray(req?.dietaryRestrictions)).toBe(true);
      expect(Array.isArray(req?.allergies)).toBe(true);
      expect(Array.isArray(req?.cuisinePreferences)).toBe(true);
      expect(Array.isArray(req?.dislikedIngredients)).toBe(true);
      expect(Array.isArray(req?.availableEquipment)).toBe(true);
      expect(req?.servings).toBe(2);
      expect((req as { ingredientsAvailable?: unknown[] })?.ingredientsAvailable).toHaveLength(2);
    });
  });
});

describe('/api/cook — correlationId boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('user-1');
    mockBuild.mockImplementation(() => testContext('user-1'));
    resetProviders();
  });

  it('rejects a malformed correlationId with 400 INVALID_BODY before anything is built', async () => {
    for (const bad of ['bad/id', 'a'.repeat(200), 123, '']) {
      const res = await post({ action: 'status', correlationId: bad });
      expect(res.status, `correlationId ${JSON.stringify(bad)}`).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
      expect(body.error.message).toContain('correlationId');
    }
    // Nothing reached the service layer, so no marker could have been written
    // and no session could have been touched.
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('threads a valid correlationId through to the service layer unchanged', async () => {
    const ctx = testContext('user-1');
    mockBuild.mockImplementation(() => ctx);
    const res = await post({ action: 'status', correlationId: 'boundary-ok-1' });
    expect(res.status).toBe(200);
    expect(mockBuild).toHaveBeenCalledWith('user-1', 'boundary-ok-1');
  });
});
