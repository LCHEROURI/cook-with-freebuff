import { describe, it, expect } from 'vitest';
import { InMemoryGroceryStore } from './tools';
import { GroceryService } from './grocery-service';
import type { PantryItem } from '../domain/types';

function pantryItem(over: Partial<PantryItem> = {}): PantryItem {
  return {
    id: `pantry-${over.name ?? 'x'}`,
    userId: 'user-1',
    name: over.name ?? 'milk',
    quantity: over.quantity,
    unit: over.unit,
    confidence: 1,
    source: 'MANUAL',
    lastConfirmedAt: Date.now(),
    expirationDate: over.expirationDate,
    ...over,
  };
}

describe('GroceryService (K10)', () => {
  it('adds a MANUAL item and lists it oldest first', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    await service.addItem('user-1', { name: 'milk', quantity: 1, unit: 'gallon' });
    const open = await service.listOpenItems('user-1');
    expect(open).toHaveLength(1);
    expect(open[0].name).toBe('milk');
    expect(open[0].source).toBe('MANUAL');
    expect(open[0].status).toBe('OPEN');
  });

  it('never duplicates an OPEN line, whatever the source', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    await service.addItem('user-1', { name: 'milk', source: 'MANUAL' });
    const again = await service.addItem('user-1', { name: 'Milk ', source: 'PANTRY_DEPLETION' });
    const open = await service.listOpenItems('user-1');
    expect(open).toHaveLength(1);
    // The dedupe returns the EXISTING line, not a new PANTRY_DEPLETION one.
    expect(again.source).toBe('MANUAL');
  });

  it('marks bought (leaves open list, stays in history) and removes entirely', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    const milk = await service.addItem('user-1', { name: 'milk' });
    const eggs = await service.addItem('user-1', { name: 'eggs' });
    await service.markBought('user-1', milk.id);
    let open = await service.listOpenItems('user-1');
    expect(open.map((i) => i.name)).toEqual(['eggs']);
    expect(store.listGroceryItems).toBeDefined();
    expect((await store.listGroceryItems('user-1')).find((i) => i.id === milk.id)?.status).toBe('BOUGHT');
    await service.removeItem('user-1', eggs.id);
    open = await service.listOpenItems('user-1');
    expect(open).toHaveLength(0);
  });

  it('syncDepleted adds a PANTRY_DEPLETION line once, even on repeat', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    const first = await service.syncDepleted('user-1', [{ name: 'garlic' }]);
    const second = await service.syncDepleted('user-1', [{ name: 'garlic' }]);
    expect(first.map((i) => i.source)).toEqual(['PANTRY_DEPLETION']);
    expect(second).toHaveLength(1);
    expect(await service.listOpenItems('user-1')).toHaveLength(1);
  });

  it('syncExpired adds an EXPIRATION line linked to the pantry item', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    const expired = [pantryItem({ name: 'yogurt', expirationDate: Date.now() - 1000 })];
    const lines = await service.syncExpired('user-1', expired);
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe('EXPIRATION');
    expect(lines[0].pantryItemId).toBe('pantry-yogurt');
    expect(lines[0].quantity).toBeUndefined();
  });

  it('syncExpired skips items already open on the list', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    await service.addItem('user-1', { name: 'milk', source: 'MANUAL' });
    const lines = await service.syncExpired('user-1', [pantryItem({ name: 'milk', expirationDate: Date.now() - 1000 })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe('MANUAL'); // the existing line, not a duplicate
    expect(await service.listOpenItems('user-1')).toHaveLength(1);
  });

  it('scopes the list per user and forbids cross-user mutations', async () => {
    const store = new InMemoryGroceryStore();
    const service = new GroceryService(store);
    const milk = await service.addItem('user-1', { name: 'milk' });
    expect(await service.listOpenItems('user-2')).toHaveLength(0);
    await expect(service.markBought('user-2', milk.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.removeItem('user-1', 'missing')).rejects.toMatchObject({ code: 'GROCERY_NOT_FOUND' });
  });
});
