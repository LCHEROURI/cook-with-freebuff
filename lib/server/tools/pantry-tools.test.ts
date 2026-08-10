import { describe, it, expect } from 'vitest';
import { SessionService, InMemorySessionStore } from '../session-service';
import { InMemoryPantryStore, InMemoryDietaryProfileStore, InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from './registry';
import { executeTool } from './registry';
import { createDefaultToolRegistry } from './index';
import type { ToolContext } from './types';

function makeContext(userId = 'user-1'): { ctx: ToolContext; sessionStore: InMemorySessionStore; pantryStore: InMemoryPantryStore } {
  const sessionStore = new InMemorySessionStore();
  const pantryStore = new InMemoryPantryStore();
  return {
    ctx: {
      userId,
      sessionService: new SessionService(sessionStore),
      timerStore: new InMemoryTimerStore(),
      logStore: new InMemoryLogStore(),
      recipeStore: new InMemoryRecipeStore(),
      pantryStore,
      dietaryProfileStore: new InMemoryDietaryProfileStore(),
    },
    sessionStore,
    pantryStore,
  };
}

const registry = createDefaultToolRegistry();

describe('K8 pantry + dietary profile tools', () => {
  it('registers all eight pantry/profile tools', () => {
    for (const name of [
      'get_pantry',
      'add_pantry_item',
      'update_pantry_item',
      'remove_pantry_item',
      'confirm_pantry_item',
      'confirm_pending_pantry_items',
      'get_dietary_profile',
      'update_dietary_profile',
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('add_pantry_item persists and records the item as pending on the active session', async () => {
    const { ctx, sessionStore, pantryStore } = makeContext();
    const session = await ctx.sessionService.createSession('user-1');

    const added = await executeTool(registry, ctx, 'add_pantry_item', { name: 'olive oil', sessionId: session.id });
    expect(added.success).toBe(true);
    expect((added.data as { pending: boolean }).pending).toBe(true);

    const fresh = await sessionStore.getSession(session.id);
    expect(fresh!.pendingPantryItems).toHaveLength(1);
    expect(fresh!.pendingPantryItems![0]).toMatchObject({ name: 'olive oil' });
    expect(fresh!.pendingPantryItems![0].itemId).toBe((added.data as { item: { id: string } }).item.id);
    expect((await pantryStore.listItems('user-1'))[0].name).toBe('olive oil');
  });

  it('confirm_pending_pantry_items raises confidence and clears the pending list', async () => {
    const { ctx, sessionStore, pantryStore } = makeContext();
    const session = await ctx.sessionService.createSession('user-1');
    await executeTool(registry, ctx, 'add_pantry_item', { name: 'salt', sessionId: session.id });
    await executeTool(registry, ctx, 'add_pantry_item', { name: 'black pepper', sessionId: session.id });

    const confirmed = await executeTool(registry, ctx, 'confirm_pending_pantry_items', {});
    expect(confirmed.success).toBe(true);
    const names = (confirmed.data as { confirmed: { name: string }[] }).confirmed.map((c) => c.name);
    expect(names).toEqual(['salt', 'black pepper']);

    const fresh = await sessionStore.getSession(session.id);
    expect(fresh!.pendingPantryItems).toEqual([]);
    const items = await pantryStore.listItems('user-1');
    expect(items.every((i) => i.confidence === 1)).toBe(true);
  });

  it('confirm_pending_pantry_items fails honestly when nothing is pending', async () => {
    const { ctx } = makeContext();
    await ctx.sessionService.createSession('user-1');
    const result = await executeTool(registry, ctx, 'confirm_pending_pantry_items', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_PENDING_PANTRY_ITEMS');
  });

  it('get_pantry echoes the query filter and flags stale entries', async () => {
    const { ctx, pantryStore } = makeContext();
    void ctx;
    const t = Date.now();
    await pantryStore.upsertItem({
      id: 'garlic-1', userId: 'user-1', name: 'garlic', confidence: 0.9, source: 'VOICE', lastConfirmedAt: t - 40 * 24 * 60 * 60 * 1000,
    });
    await pantryStore.upsertItem({
      id: 'salt-1', userId: 'user-1', name: 'salt', confidence: 1, source: 'MANUAL', lastConfirmedAt: t,
    });

    const all = await executeTool(registry, ctx, 'get_pantry', {});
    expect((all.data as { query: string | null }).query).toBeNull();
    expect((all.data as { stale: string[] }).stale).toEqual(['garlic']);

    const filtered = await executeTool(registry, ctx, 'get_pantry', { name: 'garlic' });
    expect((filtered.data as { query: string | null }).query).toBe('garlic');
    expect((filtered.data as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(['garlic']);
  });

  it('remove_pantry_item by name resolves the item id', async () => {
    const { ctx, pantryStore } = makeContext();
    await executeTool(registry, ctx, 'add_pantry_item', { name: 'onions' });
    const removed = await executeTool(registry, ctx, 'remove_pantry_item', { name: 'onions' });
    expect(removed.success).toBe(true);
    expect((removed.data as { removed: { name: string } }).removed.name).toBe('onions');
    const items = await pantryStore.listItems('user-1');
    expect(items).toHaveLength(0);
  });

  it('update_dietary_profile merges and get_dietary_profile reads back', async () => {
    const { ctx } = makeContext();
    const updated = await executeTool(registry, ctx, 'update_dietary_profile', {
      allergies: ['peanuts'],
      dietaryRestrictions: ['vegetarian'],
      defaultServings: 4,
    });
    expect(updated.success).toBe(true);
    const profile = (updated.data as { profile: { allergies: string[] } }).profile;
    expect(profile.allergies).toEqual(['peanuts']);

    const got = await executeTool(registry, ctx, 'get_dietary_profile', {});
    const read = (got.data as { profile: { dietaryRestrictions: string[]; defaultServings?: number } }).profile;
    expect(read.dietaryRestrictions).toEqual(['vegetarian']);
    expect(read.defaultServings).toBe(4);
  });
});
