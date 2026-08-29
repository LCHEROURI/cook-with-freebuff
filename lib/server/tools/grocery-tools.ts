// ─────────────────────────────────────────────────────────────────────────────
// Grocery list tools (K10 — grocery list generation)
//
// Thin wrappers over GroceryService. The list is generated, not just curated:
// guided completions auto-add depleted (PANTRY_DEPLETION) and expired
// (EXPIRATION) items; the tools here give the user the manual surface —
// add, list, mark bought, remove. Open lines are deduped by name.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext } from './types';
import { GroceryService, GroceryError } from '../grocery-service';

function groceries(ctx: ToolContext): GroceryService | null {
  if (!ctx.groceryStore) return null;
  return new GroceryService(ctx.groceryStore);
}

function unavailable(): ReturnType<typeof fail> {
  return fail('GROCERY_UNAVAILABLE', 'Grocery list storage is not available', true);
}

export const getGroceryListTool: ToolDefinition = {
  name: 'get_grocery_list',
  description: 'List the OPEN grocery list — what still needs buying, oldest first, with each item\'s source (MANUAL / PANTRY_DEPLETION / EXPIRATION).',
  inputSchema: z.object({}),
  async handler(ctx) {
    const service = groceries(ctx);
    if (!service) return unavailable();
    try {
      const items = await service.listOpenItems(ctx.userId);
      return ok({
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity ?? null,
          unit: i.unit ?? null,
          source: i.source,
        })),
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const addGroceryItemTool: ToolDefinition = {
  name: 'add_grocery_item',
  description: 'Add something to the grocery list (deduped: an already-open line for the same item is left alone).',
  inputSchema: z.object({
    name: z.string().min(1).max(200),
    quantity: z.number().nonnegative().optional(),
    unit: z.string().max(50).optional(),
  }),
  async handler(ctx, args) {
    const service = groceries(ctx);
    if (!service) return unavailable();
    try {
      const item = await service.addItem(ctx.userId, {
        name: args.name,
        quantity: args.quantity,
        unit: args.unit,
        source: 'MANUAL',
      });
      return ok({
        item: { id: item.id, name: item.name, quantity: item.quantity ?? null, unit: item.unit ?? null, source: item.source },
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

/** Resolve an open grocery item id by itemId, or by exact name (case-insensitive). */
async function resolveOpenItemId(
  ctx: ToolContext,
  service: GroceryService,
  itemId?: string,
  name?: string,
): Promise<string> {
  if (itemId) return itemId;
  if (name) {
    const items = await service.listOpenItems(ctx.userId);
    const found = items.find((i) => i.name.toLowerCase().trim() === name.toLowerCase().trim());
    if (found) return found.id;
    throw new GroceryError(`No open grocery item named "${name}"`, 'GROCERY_NOT_FOUND', true);
  }
  throw new GroceryError('Provide a grocery itemId or name', 'GROCERY_NOT_FOUND', true);
}

export const markGroceryBoughtTool: ToolDefinition = {
  name: 'mark_grocery_bought',
  description: 'Mark a grocery list item as bought (by itemId or name) — it leaves the open list but stays in history.',
  inputSchema: z.object({
    itemId: z.string().optional(),
    name: z.string().optional(),
  }),
  async handler(ctx, args) {
    const service = groceries(ctx);
    if (!service) return unavailable();
    try {
      const id = await resolveOpenItemId(ctx, service, args.itemId, args.name);
      const item = await service.markBought(ctx.userId, id);
      return ok({ itemId: item.id, name: item.name, status: item.status });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const removeGroceryItemTool: ToolDefinition = {
  name: 'remove_grocery_item',
  description: 'Remove an item from the grocery list entirely (by itemId or name) — not needed after all.',
  inputSchema: z.object({
    itemId: z.string().optional(),
    name: z.string().optional(),
  }),
  async handler(ctx, args) {
    const service = groceries(ctx);
    if (!service) return unavailable();
    try {
      const id = await resolveOpenItemId(ctx, service, args.itemId, args.name);
      const item = await service.removeItem(ctx.userId, id);
      return ok({ removed: true, name: item.name });
    } catch (e) {
      return toToolError(e);
    }
  },
};
