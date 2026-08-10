import { describe, it, expect } from 'vitest';
import { InMemoryLeftoverStore } from './tools';
import { LeftoverService, LeftoverError } from './leftover-service';

describe('LeftoverService (K10)', () => {
  it('logs a leftover as ACTIVE and lists it newest first', async () => {
    const store = new InMemoryLeftoverStore();
    const service = new LeftoverService(store);
    await service.createLeftover('user-1', { title: 'Chicken Rice', servings: 2 });
    const items = await service.listActiveLeftovers('user-1');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Chicken Rice');
    expect(items[0].servings).toBe(2);
    expect(items[0].status).toBe('ACTIVE');
  });

  it('keeps consumed leftovers out of the active list but in history', async () => {
    const store = new InMemoryLeftoverStore();
    const service = new LeftoverService(store);
    const a = await service.createLeftover('user-1', { title: 'Pasta', servings: 3 });
    await service.createLeftover('user-1', { title: 'Soup', servings: 2 });
    await service.consumeLeftover('user-1', a.id);
    const active = await service.listActiveLeftovers('user-1');
    expect(active.map((l) => l.title)).toEqual(['Soup']);
    const all = await store.listLeftovers('user-1');
    expect(all.find((l) => l.id === a.id)?.status).toBe('CONSUMED');
  });

  it('orders active leftovers newest first', async () => {
    const store = new InMemoryLeftoverStore();
    const service = new LeftoverService(store);
    await service.createLeftover('user-1', { title: 'Old', servings: 1 });
    await new Promise((r) => setTimeout(r, 2));
    await service.createLeftover('user-1', { title: 'New', servings: 1 });
    const active = await service.listActiveLeftovers('user-1');
    expect(active.map((l) => l.title)).toEqual(['New', 'Old']);
  });

  it('scopes leftovers per user and forbids cross-user consumption', async () => {
    const store = new InMemoryLeftoverStore();
    const service = new LeftoverService(store);
    const leftover = await service.createLeftover('user-1', { title: 'Stew', servings: 2 });
    expect(await service.listActiveLeftovers('user-2')).toHaveLength(0);
    await expect(service.consumeLeftover('user-2', leftover.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service.consumeLeftover('user-1', 'missing-id')).rejects.toBeInstanceOf(LeftoverError);
  });
});
