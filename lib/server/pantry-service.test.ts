import { describe, it, expect } from 'vitest';
import { InMemoryPantryStore } from './tools';
import {
  PantryService,
  PantryError,
  STALE_AFTER_MS,
  CONSUME_CONFIDENCE_THRESHOLD,
} from './pantry-service';
import type { PantryItem, Recipe } from '../domain/types';

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
      { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'i2', name: 'rice', quantity: 1, unit: 'cup', optional: false },
      { id: 'i3', name: 'secret spice', quantity: null, unit: null, optional: false },
    ],
    equipment: ['pan', 'knife'],
    prepSteps: [],
    cookingSteps: [],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
  };
}

function seedItem(store: InMemoryPantryStore, item: PantryItem): void {
  void store.upsertItem(item);
}

describe('PantryService', () => {
  it('adds an item with a voice confidence and lists it newest first', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    await service.addItem('user-1', { name: 'Olive Oil', quantity: 2, unit: 'bottles', source: 'VOICE' });
    const items = await service.listPantry('user-1');
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Olive Oil');
    expect(items[0].confidence).toBe(0.9);
    expect(items[0].stale).toBe(false);
  });

  it('scopes pantry lists per user', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    await service.addItem('user-1', { name: 'olive oil', source: 'VOICE' });
    await service.addItem('user-2', { name: 'garlic', source: 'VOICE' });
    expect(await service.listPantry('user-1')).toHaveLength(1);
    expect((await service.listPantry('user-1'))[0].name).toBe('olive oil');
  });

  it('flags entries older than 30 days as stale', async () => {
    const store = new InMemoryPantryStore();
    seedItem(store, {
      id: 'old',
      userId: 'user-1',
      name: 'garlic',
      confidence: 0.9,
      source: 'VOICE',
      lastConfirmedAt: Date.now() - STALE_AFTER_MS - 1000,
    });
    const items = await new PantryService(store).listPantry('user-1');
    expect(items[0].stale).toBe(true);
  });

  it('confirmation raises confidence to 1 and refreshes the date', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const added = await service.addItem('user-1', { name: 'salt', source: 'VOICE' });
    expect(added.confidence).toBe(0.9);

    const confirmed = await service.confirmItem('user-1', added.id);
    expect(confirmed.confidence).toBe(1);
    expect(confirmed.lastConfirmedAt).toBeGreaterThanOrEqual(added.lastConfirmedAt);
  });

  it('rejects mutating another user’s item', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const added = await service.addItem('user-1', { name: 'salt', source: 'VOICE' });
    await expect(service.updateItem('user-2', added.id, { quantity: 99 })).rejects.toBeInstanceOf(PantryError);
  });

  it('removes an item by id', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const added = await service.addItem('user-1', { name: 'salt', source: 'VOICE' });
    const removed = await service.removeItem('user-1', added.id);
    expect(removed.id).toBe(added.id);
    expect(await service.listPantry('user-1')).toHaveLength(0);
  });

  it('consumeForRecipe reduces known quantities and removes exhausted items', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const chicken = await service.addItem('user-1', { name: 'chicken thighs', quantity: 6, unit: 'pieces', source: 'MANUAL' });
    const rice = await service.addItem('user-1', { name: 'rice', quantity: 1, unit: 'cup', source: 'MANUAL' });
    await service.confirmItem('user-1', chicken.id);
    await service.confirmItem('user-1', rice.id);

    const result = await service.consumeForRecipe('user-1', makeRecipe());

    // 4 of 6 thighs consumed → 2 left.
    const chickenAfter = (await store.getItem(chicken.id))!;
    expect(chickenAfter.quantity).toBe(2);
    // 1 of 1 cup consumed → removed.
    expect(await store.getItem(rice.id)).toBeNull();
    expect(result.adjusted.map((a) => a.name).sort()).toEqual(['chicken thighs', 'rice']);
  });

  it('consumeForRecipe never reduces uncertain quantities or low-confidence matches', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    // Unknown quantity → untouched even though the name matches.
    const vague = await service.addItem('user-1', { name: 'chicken thighs', source: 'VOICE' });
    // Fresh but unconfirmed → confidence 0.9 is above the threshold, quantity known.
    const rice = await service.addItem('user-1', { name: 'rice', quantity: 3, unit: 'cup', source: 'VOICE' });
    await service.confirmItem('user-1', vague.id);

    const result = await service.consumeForRecipe('user-1', makeRecipe());
    // The 1-cup rice is consumed; the vague thighs (no quantity) are untouched.
    expect(result.adjusted.map((a) => a.name)).toEqual(['rice']);
    expect(result.untouched).toContain('chicken thighs');
    expect((await store.getItem(rice.id))!.quantity).toBe(2);
  });

  it('stale entries are never auto-consumed (confidence capped below threshold)', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    seedItem(store, {
      id: 'old-rice',
      userId: 'user-1',
      name: 'rice',
      quantity: 5,
      unit: 'cup',
      confidence: 1,
      source: 'MANUAL',
      lastConfirmedAt: Date.now() - STALE_AFTER_MS - 1000,
    });
    const result = await service.consumeForRecipe('user-1', makeRecipe());
    expect(result.adjusted).toHaveLength(0);
    expect(result.untouched).toContain('rice');
    expect((await store.getItem('old-rice'))!.quantity).toBe(5);
  });

  it('records a PANTRY_ITEM_CONFIRMED event when a session is attached', async () => {
    const store = new InMemoryPantryStore();
    const sessionStore = new (await import('./session-service')).InMemorySessionStore();
    const sessionService = new (await import('./session-service')).SessionService(sessionStore);
    const session = await sessionService.createSession('user-1');
    const service = new PantryService(store, sessionService);
    const added = await service.addItem('user-1', { name: 'salt', source: 'VOICE' }, { sessionId: session.id });
    await service.confirmItem('user-1', added.id, { sessionId: session.id });

    const events = await sessionService.getSessionEvents(session.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('INGREDIENT_ADDED');
    expect(types).toContain('PANTRY_ITEM_CONFIRMED');
  });
});

describe('PantryService expiration awareness (K10)', () => {
  it('flags nothing for items without an expirationDate', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    await service.addItem('user-1', { name: 'salt', source: 'MANUAL' });
    const [item] = await service.listPantry('user-1');
    expect(item.expiresSoon).toBe(false);
    expect(item.expired).toBe(false);
    expect(item.daysUntilExpiration).toBeNull();
  });

  it('flags expiring-soon (within 2 days) and expired entries with day counts', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const day = 24 * 60 * 60 * 1000;
    seedItem(store, { id: 'soon-milk', userId: 'user-1', name: 'milk', confidence: 1, source: 'MANUAL', lastConfirmedAt: Date.now(), expirationDate: Date.now() + day });
    seedItem(store, { id: 'dead-yogurt', userId: 'user-1', name: 'yogurt', confidence: 1, source: 'MANUAL', lastConfirmedAt: Date.now(), expirationDate: Date.now() - day });
    seedItem(store, { id: 'fine-cheese', userId: 'user-1', name: 'cheese', confidence: 1, source: 'MANUAL', lastConfirmedAt: Date.now(), expirationDate: Date.now() + 5 * day });
    const items = await service.listPantry('user-1');
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName.milk.expiresSoon).toBe(true);
    expect(byName.milk.expired).toBe(false);
    expect(byName.milk.daysUntilExpiration).toBe(1);
    expect(byName.yogurt.expired).toBe(true);
    expect(byName.yogurt.expiresSoon).toBe(false);
    expect(byName.yogurt.daysUntilExpiration).toBeLessThanOrEqual(0);
    expect(byName.cheese.expiresSoon).toBe(false);
    expect(byName.cheese.expired).toBe(false);
  });

  it('expiredItems returns only entries past their expirationDate', async () => {
    const store = new InMemoryPantryStore();
    const service = new PantryService(store);
    const day = 24 * 60 * 60 * 1000;
    seedItem(store, { id: 'a', userId: 'user-1', name: 'sour cream', confidence: 1, source: 'MANUAL', lastConfirmedAt: Date.now(), expirationDate: Date.now() - day });
    seedItem(store, { id: 'b', userId: 'user-1', name: 'fresh eggs', confidence: 1, source: 'MANUAL', lastConfirmedAt: Date.now(), expirationDate: Date.now() + 5 * day });
    const expired = await service.expiredItems('user-1');
    expect(expired.map((i) => i.name)).toEqual(['sour cream']);
  });
});
