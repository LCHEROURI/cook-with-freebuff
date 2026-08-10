// ─────────────────────────────────────────────────────────────────────────────
// Grocery list service (K10 — grocery list generation from pantry depletion)
//
// The grocery list is generated, not just curated:
//   - MANUAL             — the user asks to add something ("add milk to my
//                          grocery list")
//   - PANTRY_DEPLETION   — a guided completion consumed the last of an item
//                          (its known quantity ran out)
//   - EXPIRATION         — a pantry item's expirationDate has passed; the item
//                          is surfaced as expired and a replenish entry is
//                          added automatically
//
// Open lines are deduped by normalized name — an already-OPEN entry is never
// duplicated, whatever the source. Bought items stay in the list (marked
// BOUGHT) so the history is honest; removal deletes the entry.
// ─────────────────────────────────────────────────────────────────────────────

import type { GroceryStore } from './tools/types';
import type {
  GroceryItem,
  GroceryItemSource,
  PantryItem,
} from '../domain/types';

export interface GroceryItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  source?: GroceryItemSource;
  pantryItemId?: string;
}

export class GroceryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'GroceryError';
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function slug(name: string): string {
  return normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

export class GroceryService {
  constructor(private readonly groceryStore: GroceryStore) {}

  /**
   * Add an item to the open list. Dedupe contract: an OPEN entry with the
   * same normalized name is left untouched and returned — no source (manual,
   * depletion, expiration) can duplicate an open line.
   */
  async addItem(userId: string, input: GroceryItemInput): Promise<GroceryItem> {
    const name = input.name.trim();
    const now = Date.now();
    const open = await this.listOpenItems(userId);
    const existing = open.find((i) => normalizeName(i.name) === normalizeName(name));
    if (existing) return existing;

    const item: GroceryItem = {
      id: `grocery-${slug(name)}-${rand4()}`,
      userId,
      name,
      quantity: input.quantity,
      unit: input.unit,
      source: input.source ?? 'MANUAL',
      status: 'OPEN',
      pantryItemId: input.pantryItemId,
      createdAt: now,
      updatedAt: now,
    };
    await this.groceryStore.createGroceryItem(item);
    return item;
  }

  /** OPEN entries, oldest first (the shopping order). */
  async listOpenItems(userId: string): Promise<GroceryItem[]> {
    const all = await this.groceryStore.listGroceryItems(userId);
    return all
      .filter((i) => i.status === 'OPEN')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Mark an item bought — stays in history, leaves the open list. */
  async markBought(userId: string, itemId: string): Promise<GroceryItem> {
    const item = await this.requireOwned(userId, itemId);
    await this.groceryStore.updateGroceryItem(item.id, { status: 'BOUGHT', updatedAt: Date.now() });
    return { ...item, status: 'BOUGHT', updatedAt: Date.now() };
  }

  /** Remove an entry entirely (the user says it's not needed). */
  async removeItem(userId: string, itemId: string): Promise<GroceryItem> {
    const item = await this.requireOwned(userId, itemId);
    await this.groceryStore.deleteGroceryItem(item.id);
    return item;
  }

  /**
   * Depletion sync (K10): items a guided completion exhausted land on the
   * list automatically. Deduped — repeating the same recipe the same day adds
   * the line once. Returns the open lines now covering the depleted names
   * (whatever their source — a pre-existing MANUAL line is still the line).
   */
  async syncDepleted(
    userId: string,
    depleted: { name: string; quantity?: number; unit?: string }[],
  ): Promise<GroceryItem[]> {
    for (const d of depleted) {
      await this.addItem(userId, {
        name: d.name,
        quantity: d.quantity,
        unit: d.unit,
        source: 'PANTRY_DEPLETION',
      });
    }
    const wanted = new Set(depleted.map((d) => normalizeName(d.name)));
    return (await this.listOpenItems(userId)).filter((i) => wanted.has(normalizeName(i.name)));
  }

  /**
   * Expiration sync (K10): pantry items whose expirationDate has passed get a
   * replenish entry (source EXPIRATION, linked via pantryItemId). Returns the
   * open lines covering those items.
   */
  async syncExpired(userId: string, expired: PantryItem[]): Promise<GroceryItem[]> {
    const wanted = new Set(expired.map((i) => normalizeName(i.name)));
    const open = await this.listOpenItems(userId);
    const openByName = new Map(open.map((i) => [normalizeName(i.name), i]));
    for (const item of expired) {
      const existing = openByName.get(normalizeName(item.name));
      if (existing) continue;
      const created = await this.addItem(userId, {
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        source: 'EXPIRATION',
        pantryItemId: item.id,
      });
      openByName.set(normalizeName(created.name), created);
    }
    return (await this.listOpenItems(userId)).filter((i) => wanted.has(normalizeName(i.name)));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireOwned(userId: string, itemId: string): Promise<GroceryItem> {
    const item = await this.groceryStore.getGroceryItem(itemId);
    if (!item) {
      throw new GroceryError(`Grocery item ${itemId} not found`, 'GROCERY_NOT_FOUND', true);
    }
    if (item.userId !== userId) {
      throw new GroceryError('Grocery item belongs to another user', 'FORBIDDEN', false);
    }
    return item;
  }
}
