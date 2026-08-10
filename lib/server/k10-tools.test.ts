import { describe, it, expect } from 'vitest';
import { createDefaultToolRegistry } from './tools';
import { executeTool, InMemoryLeftoverStore, InMemoryGroceryStore } from './tools/registry';
import { SessionService, InMemorySessionStore } from './session-service';
import { InMemoryTimerStore, InMemoryLogStore } from './tools/registry';
import type { ToolContext } from './tools/types';

function makeContext(): { ctx: ToolContext; leftovers: InMemoryLeftoverStore; groceries: InMemoryGroceryStore } {
  const leftovers = new InMemoryLeftoverStore();
  const groceries = new InMemoryGroceryStore();
  return {
    leftovers,
    groceries,
    ctx: {
      userId: 'user-1',
      sessionService: new SessionService(new InMemorySessionStore()),
      timerStore: new InMemoryTimerStore(),
      logStore: new InMemoryLogStore(),
      leftoverStore: leftovers,
      groceryStore: groceries,
    },
  };
}

const registry = createDefaultToolRegistry();

describe('K10 leftover tools', () => {
  it('get_leftovers lists only ACTIVE leftovers with storedDays', async () => {
    const { ctx, leftovers } = makeContext();
    await leftovers.createLeftover({ id: 'l1', userId: 'user-1', title: 'Soup', servings: 2, completedAt: Date.now(), storedAt: Date.now(), status: 'ACTIVE' });
    await leftovers.createLeftover({ id: 'l2', userId: 'user-1', title: 'Old Stew', servings: 1, completedAt: Date.now() - 3 * 86_400_000, storedAt: Date.now() - 3 * 86_400_000, status: 'CONSUMED' });
    const res = await executeTool(registry, ctx, 'get_leftovers', {});
    expect(res.success).toBe(true);
    const items = (res as { data: { items: { title: string; storedDays: number }[] } }).data.items;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Soup');
    expect(items[0].storedDays).toBe(0);
  });

  it('log_leftover creates an entry and consume_leftover removes it from the active list', async () => {
    const { ctx } = makeContext();
    const logged = await executeTool(registry, ctx, 'log_leftover', { title: 'Takeout Thai', servings: 2 });
    expect(logged.success).toBe(true);
    const id = (logged as { data: { leftover: { id: string } } }).data.leftover.id;
    let listed = await executeTool(registry, ctx, 'get_leftovers', {});
    expect((listed as { data: { items: unknown[] } }).data.items).toHaveLength(1);
    const consumed = await executeTool(registry, ctx, 'consume_leftover', { leftoverId: id });
    expect(consumed.success).toBe(true);
    listed = await executeTool(registry, ctx, 'get_leftovers', {});
    expect((listed as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  });

  it('cross-user leftover access is forbidden', async () => {
    const { ctx, leftovers } = makeContext();
    await leftovers.createLeftover({ id: 'l1', userId: 'user-1', title: 'Soup', servings: 2, completedAt: Date.now(), storedAt: Date.now(), status: 'ACTIVE' });
    const res = await executeTool(registry, { ...ctx, userId: 'user-2' }, 'consume_leftover', { leftoverId: 'l1' });
    expect(res.success).toBe(false);
    expect((res as { error?: { code: string } }).error?.code).toBe('FORBIDDEN');
  });
});

describe('K10 grocery tools', () => {
  it('add_grocery_item creates an open MANUAL line (deduped by name)', async () => {
    const { ctx } = makeContext();
    const first = await executeTool(registry, ctx, 'add_grocery_item', { name: 'milk', quantity: 1, unit: 'gallon' });
    const second = await executeTool(registry, ctx, 'add_grocery_item', { name: 'Milk' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const listed = await executeTool(registry, ctx, 'get_grocery_list', {});
    const items = (listed as { data: { items: { name: string; source: string }[] } }).data.items;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('milk');
  });

  it('mark_grocery_bought and remove_grocery_item work by name', async () => {
    const { ctx } = makeContext();
    await executeTool(registry, ctx, 'add_grocery_item', { name: 'eggs' });
    await executeTool(registry, ctx, 'add_grocery_item', { name: 'bread' });
    const bought = await executeTool(registry, ctx, 'mark_grocery_bought', { name: 'eggs' });
    expect(bought.success).toBe(true);
    const removed = await executeTool(registry, ctx, 'remove_grocery_item', { name: 'bread' });
    expect(removed.success).toBe(true);
    const listed = await executeTool(registry, ctx, 'get_grocery_list', {});
    expect((listed as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  });

  it('marking an unknown name returns a recoverable GROCERY_NOT_FOUND', async () => {
    const { ctx } = makeContext();
    const res = await executeTool(registry, ctx, 'mark_grocery_bought', { name: 'nothing' });
    expect(res.success).toBe(false);
    expect((res as { error?: { code: string; recoverable: boolean } }).error).toMatchObject({
      code: 'GROCERY_NOT_FOUND',
      recoverable: true,
    });
  });

  it('unavailable stores fail with the targeted code (never a crash)', async () => {
    const { ctx } = makeContext();
    const bare: ToolContext = { ...ctx, leftoverStore: undefined, groceryStore: undefined };
    const res = await executeTool(registry, bare, 'get_leftovers', {});
    expect((res as { error?: { code: string } }).error?.code).toBe('LEFTOVER_UNAVAILABLE');
    const groc = await executeTool(registry, bare, 'get_grocery_list', {});
    expect((groc as { error?: { code: string } }).error?.code).toBe('GROCERY_UNAVAILABLE');
  });
});
