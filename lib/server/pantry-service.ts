// ─────────────────────────────────────────────────────────────────────────────
// Pantry service (K8 — pantry intelligence)
//
// Long-term pantry memory with honest confidence handling:
//   - items carry `confidence` (0..1) and `lastConfirmedAt`
//   - entries older than STALE_AFTER_MS are surfaced as needing re-confirmation
//     ("You had garlic last time. Do you still have some?") — never assumed
//     accurate forever
//   - explicit confirmation (confirmItem) raises confidence to 1
//   - consumeForRecipe (recipe consumption) adjusts ONLY items whose effective
//     confidence is high AND whose quantity is known — uncertain quantities are
//     never reduced automatically
// Every mutation logs a session event (INGREDIENT_ADDED / INGREDIENT_REMOVED /
// INGREDIENT_CORRECTED / PANTRY_ITEM_CONFIRMED) when a session is attached.
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionService } from './session-service';
import type { PantryStore } from './tools/types';
import type {
  Ingredient,
  PantryItem,
  PantryItemSource,
  Recipe,
  SessionEventType,
} from '../domain/types';

/** How old a pantry entry may be before it is flagged for re-confirmation. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Confidence below which a match is never auto-consumed. */
export const CONSUME_CONFIDENCE_THRESHOLD = 0.8;

/** An item is flagged "expiring soon" within this window (K10). */
export const EXPIRE_SOON_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

/** A pantry entry with its live re-confirmation + expiration flags. */
export interface PantryItemView extends PantryItem {
  /** True when the entry is old enough that we should ask before trusting it. */
  stale: boolean;
  /** True when expirationDate is within EXPIRE_SOON_MS. */
  expiresSoon: boolean;
  /** True when expirationDate is in the past. */
  expired: boolean;
  /** Whole days until expiration (negative when already expired), null when unset. */
  daysUntilExpiration: number | null;
}

export interface PantryItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  source: PantryItemSource;
  notes?: string;
}

export interface ConsumptionResult {
  adjusted: {
    itemId: string;
    name: string;
    action: 'removed' | 'reduced';
    before?: number;
    after?: number;
  }[];
  /** Ingredients left untouched (no pantry match, uncertain, or low confidence). */
  untouched: string[];
}

export class PantryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'PantryError';
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function slug(name: string): string {
  return normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

export class PantryService {
  constructor(
    private readonly pantryStore: PantryStore,
    private readonly sessionService?: SessionService,
  ) {}

  /** All pantry entries for the user, newest first, with live stale + expiry flags. */
  async listPantry(userId: string): Promise<PantryItemView[]> {
    const items = await this.pantryStore.listItems(userId);
    return items
      .map((item) => ({ ...item, ...this.expiryFlags(item) }))
      .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt);
  }

  /** Entries whose expirationDate has already passed (K10 expiration sync). */
  async expiredItems(userId: string): Promise<PantryItem[]> {
    const items = await this.pantryStore.listItems(userId);
    return items.filter((i) => this.expiryFlags(i).expired);
  }

  /** Add a new pantry entry (source decides starting confidence). */
  async addItem(
    userId: string,
    input: PantryItemInput,
    options?: { sessionId?: string },
  ): Promise<PantryItem> {
    const item: PantryItem = {
      id: `pantry-${slug(input.name)}-${rand4()}`,
      userId,
      name: input.name.trim(),
      quantity: input.quantity,
      unit: input.unit,
      confidence: input.source === 'RECIPE_USAGE' ? 0.6 : 0.9,
      source: input.source,
      lastConfirmedAt: Date.now(),
      notes: input.notes,
    };
    await this.pantryStore.upsertItem(item);
    await this.logEvent(options?.sessionId, 'INGREDIENT_ADDED', {
      itemId: item.id,
      name: item.name,
      source: item.source,
    });
    return item;
  }

  /** Correct an entry's quantity/unit/notes/expiration (null clears the field). */
  async updateItem(
    userId: string,
    itemId: string,
    patch: {
      quantity?: number | null;
      unit?: string | null;
      notes?: string | null;
      expirationDate?: number | null;
    },
    options?: { sessionId?: string },
  ): Promise<PantryItem> {
    const current = await this.requireOwned(userId, itemId);
    const updated: PantryItem = {
      ...current,
      ...(patch.quantity !== undefined ? { quantity: patch.quantity ?? undefined } : {}),
      ...(patch.unit !== undefined ? { unit: patch.unit ?? undefined } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes ?? undefined } : {}),
      ...(patch.expirationDate !== undefined
        ? { expirationDate: patch.expirationDate ?? undefined }
        : {}),
    };
    await this.pantryStore.upsertItem(updated);
    await this.logEvent(options?.sessionId, 'INGREDIENT_CORRECTED', {
      itemId: updated.id,
      name: updated.name,
    });
    return updated;
  }

  /** Remove an entry entirely. */
  async removeItem(
    userId: string,
    itemId: string,
    options?: { sessionId?: string },
  ): Promise<PantryItem> {
    const item = await this.requireOwned(userId, itemId);
    await this.pantryStore.deleteItem(itemId);
    await this.logEvent(options?.sessionId, 'INGREDIENT_REMOVED', {
      itemId: item.id,
      name: item.name,
    });
    return item;
  }

  /** Explicit confirmation — raises confidence to 1 and refreshes the date. */
  async confirmItem(
    userId: string,
    itemId: string,
    options?: { sessionId?: string },
  ): Promise<PantryItem> {
    const current = await this.requireOwned(userId, itemId);
    const updated: PantryItem = {
      ...current,
      confidence: 1,
      lastConfirmedAt: Date.now(),
    };
    await this.pantryStore.upsertItem(updated);
    await this.logEvent(options?.sessionId, 'PANTRY_ITEM_CONFIRMED', {
      itemId: updated.id,
      name: updated.name,
    });
    return updated;
  }

  /**
   * Recipe consumption (K8): adjust pantry inventory for a completed recipe.
   * Only entries with effective confidence >= CONSUME_CONFIDENCE_THRESHOLD AND a
   * known quantity are adjusted (removed when exhausted, otherwise reduced).
   * Uncertain entries are never reduced — they are reported as untouched.
   */
  async consumeForRecipe(
    userId: string,
    recipe: Recipe,
    options?: { sessionId?: string },
  ): Promise<ConsumptionResult> {
    const items = await this.pantryStore.listItems(userId);
    const result: ConsumptionResult = { adjusted: [], untouched: [] };

    for (const ingredient of recipe.ingredients) {
      const outcome = await this.consumeIngredient(userId, items, ingredient, options);
      if (outcome) {
        result.adjusted.push(outcome);
      } else {
        result.untouched.push(ingredient.name);
      }
    }
    return result;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async consumeIngredient(
    userId: string,
    items: PantryItem[],
    ingredient: Ingredient,
    options?: { sessionId?: string },
  ): Promise<ConsumptionResult['adjusted'][number] | null> {
    const match = items.find((i) => normalizeName(i.name) === normalizeName(ingredient.name));
    if (!match) return null;

    const needed = ingredient.quantity;
    // Never reduce uncertain quantities or low-confidence entries.
    if (needed == null || match.quantity === undefined || this.effectiveConfidence(match) < CONSUME_CONFIDENCE_THRESHOLD) {
      return null;
    }

    if (match.quantity <= needed) {
      await this.pantryStore.deleteItem(match.id);
      await this.logEvent(options?.sessionId, 'INGREDIENT_REMOVED', {
        itemId: match.id,
        name: match.name,
        reason: 'recipe-consumed',
      });
      return { itemId: match.id, name: match.name, action: 'removed', before: match.quantity };
    }

    const after = match.quantity - needed;
    await this.pantryStore.upsertItem({ ...match, quantity: after, source: 'RECIPE_USAGE' });
    await this.logEvent(options?.sessionId, 'INGREDIENT_CORRECTED', {
      itemId: match.id,
      name: match.name,
      before: match.quantity,
      after,
      reason: 'recipe-consumed',
    });
    return { itemId: match.id, name: match.name, action: 'reduced', before: match.quantity, after };
  }

  /** Age-based staleness — entries older than STALE_AFTER_MS need re-confirmation. */
  private isStale(item: PantryItem): boolean {
    return Date.now() - item.lastConfirmedAt > STALE_AFTER_MS;
  }

  /** Live expiration flags for an entry (K10 expiration awareness). */
  private expiryFlags(item: PantryItem): {
    stale: boolean;
    expiresSoon: boolean;
    expired: boolean;
    daysUntilExpiration: number | null;
  } {
    const stale = this.isStale(item);
    if (!item.expirationDate) {
      return { stale, expiresSoon: false, expired: false, daysUntilExpiration: null };
    }
    const days = Math.ceil((item.expirationDate - Date.now()) / (24 * 60 * 60 * 1000));
    return {
      stale,
      expiresSoon: days > 0 && days <= 2,
      expired: days <= 0,
      daysUntilExpiration: days,
    };
  }

  /** Effective confidence for decisions — stale entries cap at 0.5. */
  private effectiveConfidence(item: PantryItem): number {
    return this.isStale(item) ? Math.min(item.confidence, 0.5) : item.confidence;
  }

  private async requireOwned(userId: string, itemId: string): Promise<PantryItem> {
    const item = await this.pantryStore.getItem(itemId);
    if (!item) {
      throw new PantryError(`Pantry item ${itemId} not found`, 'PANTRY_NOT_FOUND', true);
    }
    if (item.userId !== userId) {
      throw new PantryError('Pantry item belongs to another user', 'FORBIDDEN', false);
    }
    return item;
  }

  private async logEvent(
    sessionId: string | undefined,
    type: SessionEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!sessionId || !this.sessionService) return;
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;
    await this.sessionService.logSessionEvent(sessionId, type, data);
  }
}
