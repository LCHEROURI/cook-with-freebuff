import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from './route';
import { SessionService, InMemorySessionStore } from '@/lib/server/session-service';
import {
  InMemoryTimerStore,
  InMemoryLogStore,
  InMemoryRecipeStore,
  InMemoryPantryStore,
  InMemoryGroceryStore,
  InMemoryLeftoverStore,
  InMemoryDietaryProfileStore,
} from '@/lib/server/tools';
import type { ToolContext } from '@/lib/server/tools/types';
import type { Leftover, GroceryItem } from '@/lib/domain/types';

vi.mock('@/lib/server/admin', () => ({ resolveUserId: vi.fn() }));
vi.mock('@/lib/server/stores', () => ({ buildProductionContext: vi.fn() }));

import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';

const mockResolve = resolveUserId as ReturnType<typeof vi.fn>;
const mockBuild = buildProductionContext as ReturnType<typeof vi.fn>;

function testContext(userId: string): ToolContext {
  return {
    userId,
    sessionService: new SessionService(new InMemorySessionStore()),
    timerStore: new InMemoryTimerStore(),
    logStore: new InMemoryLogStore(),
    recipeStore: new InMemoryRecipeStore(),
    pantryStore: new InMemoryPantryStore(),
    groceryStore: new InMemoryGroceryStore(),
    leftoverStore: new InMemoryLeftoverStore(),
    dietaryProfileStore: new InMemoryDietaryProfileStore(),
  };
}

function post(body: unknown, token = 'Bearer fake-token') {
  return POST(
    new Request('http://localhost/api/kitchen', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

async function snapshotBody() {
  const res = await post({ action: 'snapshot' });
  const body = await res.json();
  return body.data as {
    pantry: { id: string; name: string; quantity: number | null; stale: boolean; expiresSoon: boolean; expired: boolean }[];
    grocery: { id: string; name: string; source: string }[];
    leftovers: { id: string; title: string; servings: number }[];
    profile: { allergies: string[]; dietaryRestrictions: string[] } | null;
  };
}

describe('/api/kitchen', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('user-1');
    ctx = testContext('user-1');
    mockBuild.mockImplementation(() => ctx);
  });

  it('returns 401 without a valid token', async () => {
    mockResolve.mockResolvedValue(null);
    const res = await post({ action: 'snapshot' }, '');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('snapshot returns an empty kitchen for a fresh user', async () => {
    const res = await post({ action: 'snapshot' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.pantry).toEqual([]);
    expect(body.data.grocery).toEqual([]);
    expect(body.data.leftovers).toEqual([]);
    expect(body.data.profile).toBeNull();
  });

  it('GET returns the same snapshot', async () => {
    const res = await GET(
      new Request('http://localhost/api/kitchen', { headers: { authorization: 'Bearer fake-token' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.pantry)).toBe(true);
  });

  describe('pantry', () => {
    it('pantry_add persists an item and snapshot lists it with live flags', async () => {
      const add = await post({ action: 'pantry_add', name: 'olive oil', quantity: 1, unit: 'bottle' });
      expect(add.status).toBe(200);
      const added = await add.json();
      expect(added.success).toBe(true);

      const data = await snapshotBody();
      expect(data.pantry).toHaveLength(1);
      expect(data.pantry[0].name).toBe('olive oil');
      expect(data.pantry[0].quantity).toBe(1);
      expect(data.pantry[0].stale).toBe(false);
    });

    it('pantry_remove deletes the item', async () => {
      await post({ action: 'pantry_add', name: 'milk' });
      const added = await snapshotBody();
      const id = added.pantry[0].id;

      const res = await post({ action: 'pantry_remove', itemId: id });
      expect(res.status).toBe(200);
      const removed = await res.json();
      expect(removed.data.removed).toBe(true);

      const data = await snapshotBody();
      expect(data.pantry).toHaveLength(0);
    });

    it('pantry_confirm raises confidence to 1', async () => {
      await post({ action: 'pantry_add', name: 'garlic' });
      const added = await snapshotBody();
      const id = added.pantry[0].id;

      const res = await post({ action: 'pantry_confirm', itemId: id });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.item.confidence).toBe(1);

      const stored = await ctx.pantryStore?.getItem(id);
      expect(stored?.confidence).toBe(1);
    });

    it('validates the name', async () => {
      const res = await post({ action: 'pantry_add' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });
  });

  describe('grocery list', () => {
    it('grocery_add → snapshot lists the open line; grocery_bought removes it from the open list', async () => {
      await post({ action: 'grocery_add', name: 'eggs', quantity: 6 });
      let data = await snapshotBody();
      expect(data.grocery).toHaveLength(1);
      expect(data.grocery[0].name).toBe('eggs');
      expect(data.grocery[0].source).toBe('MANUAL');

      const res = await post({ action: 'grocery_bought', itemId: data.grocery[0].id });
      expect(res.status).toBe(200);
      const bought = await res.json();
      expect(bought.data.status).toBe('BOUGHT');

      data = await snapshotBody();
      expect(data.grocery).toHaveLength(0);
    });

    it('grocery_remove deletes the line entirely', async () => {
      await post({ action: 'grocery_add', name: 'bread' });
      const data = await snapshotBody();

      const res = await post({ action: 'grocery_remove', itemId: data.grocery[0].id });
      expect(res.status).toBe(200);
      const after = await snapshotBody();
      expect(after.grocery).toHaveLength(0);
    });
  });

  describe('leftovers', () => {
    it('leftover_log → snapshot lists the active leftover; leftover_consume removes it', async () => {
      const log = await post({ action: 'leftover_log', title: 'Beef stew', servings: 2, notes: 'Big batch' });
      expect(log.status).toBe(200);

      let data = await snapshotBody();
      expect(data.leftovers).toHaveLength(1);
      expect(data.leftovers[0].title).toBe('Beef stew');
      expect(data.leftovers[0].servings).toBe(2);

      const res = await post({ action: 'leftover_consume', leftoverId: data.leftovers[0].id });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.consumed).toBe(true);

      data = await snapshotBody();
      expect(data.leftovers).toHaveLength(0);
    });

    it('validates the title', async () => {
      const res = await post({ action: 'leftover_log' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });
  });

  describe('dietary profile', () => {
    it('profile_update persists the remembered preferences', async () => {
      const res = await post({
        action: 'profile_update',
        allergies: 'peanuts, Shellfish',
        dietaryRestrictions: 'vegetarian',
        dislikedIngredients: 'cilantro',
        preferredCuisines: 'italian, Mexican',
        defaultServings: 4,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.profile.allergies).toEqual(['peanuts', 'Shellfish']);
      expect(body.data.profile.dietaryRestrictions).toEqual(['vegetarian']);
      expect(body.data.profile.defaultServings).toBe(4);

      const data = await snapshotBody();
      expect(data.profile?.allergies).toEqual(['peanuts', 'Shellfish']);
      expect(data.profile?.dietaryRestrictions).toEqual(['vegetarian']);
    });

    it('replaces whole lists (never merges) on a second update', async () => {
      await post({ action: 'profile_update', allergies: 'peanuts, sesame' });
      await post({ action: 'profile_update', allergies: 'tree nuts' });
      const data = await snapshotBody();
      expect(data.profile?.allergies).toEqual(['tree nuts']);
    });
  });

  it('isolates users — another user’s kitchen never leaks into the snapshot', async () => {
    const other = testContext('user-2');
    await other.pantryStore?.upsertItem({
      id: 'p-other',
      userId: 'user-2',
      name: 'secret truffles',
      confidence: 0.9,
      source: 'MANUAL',
      lastConfirmedAt: Date.now(),
    });
    await other.groceryStore?.createGroceryItem({
      id: 'g-other',
      userId: 'user-2',
      name: 'caviar',
      source: 'MANUAL',
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as GroceryItem);

    const data = await snapshotBody();
    expect(data.pantry).toHaveLength(0);
    expect(data.grocery).toHaveLength(0);
  });

  it('does not leak bought grocery lines or consumed leftovers into the snapshot', async () => {
    const store = ctx.groceryStore!;
    await store.createGroceryItem({
      id: 'g-bought',
      userId: 'user-1',
      name: 'already bought',
      source: 'MANUAL',
      status: 'BOUGHT',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as GroceryItem);
    const lstore = ctx.leftoverStore!;
    await lstore.createLeftover({
      id: 'l-eaten',
      userId: 'user-1',
      title: 'Eaten already',
      servings: 1,
      completedAt: Date.now(),
      storedAt: Date.now(),
      status: 'CONSUMED',
    } as Leftover);

    const data = await snapshotBody();
    expect(data.grocery).toHaveLength(0);
    expect(data.leftovers).toHaveLength(0);
  });
});
