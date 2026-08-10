import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from './route';
import { SessionService, InMemorySessionStore } from '@/lib/server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '@/lib/server/tools';
import type { ToolContext } from '@/lib/server/tools/types';
import type { Recipe } from '@/lib/domain/types';

vi.mock('@/lib/server/admin', () => ({ resolveUserId: vi.fn() }));
vi.mock('@/lib/server/stores', () => ({ buildProductionContext: vi.fn() }));

import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';

const mockResolve = resolveUserId as ReturnType<typeof vi.fn>;
const mockBuild = buildProductionContext as ReturnType<typeof vi.fn>;

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
});
