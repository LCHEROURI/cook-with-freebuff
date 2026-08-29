// ─────────────────────────────────────────────────────────────────────────────
// Pantry + dietary profile tools (K8 — user memory & pantry intelligence)
//
// Thin wrappers over PantryService / DietaryProfileService. Every mutation is
// owner-scoped and logged. Session events are recorded when a sessionId is
// supplied (or the caller's active session is used).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext } from './types';
import { PantryService, PantryError } from '../pantry-service';
import { DietaryProfileService } from '../profile-service';

function pantry(ctx: ToolContext): PantryService | null {
  if (!ctx.pantryStore) return null;
  return new PantryService(ctx.pantryStore, ctx.sessionService);
}

function profileService(ctx: ToolContext): DietaryProfileService | null {
  if (!ctx.dietaryProfileStore) return null;
  return new DietaryProfileService(ctx.dietaryProfileStore);
}

function pantryUnavailable(): ReturnType<typeof fail> {
  return fail('PANTRY_UNAVAILABLE', 'Pantry storage is not available', true);
}

/** Resolve a session id: explicit arg, else the user's active session. */
async function resolveSessionId(ctx: ToolContext, sessionId?: string): Promise<string | undefined> {
  if (sessionId) return sessionId;
  const session = await ctx.sessionService.getActiveSession(ctx.userId);
  return session?.id;
}

export const getPantryTool: ToolDefinition = {
  name: 'get_pantry',
  description: 'List the user\'s pantry (optionally filtered by name). Entries older than 30 days are flagged as needing re-confirmation.',
  inputSchema: z.object({ name: z.string().optional() }),
  async handler(ctx, args) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      const items = await service.listPantry(ctx.userId);
      const filtered = args.name
        ? items.filter((i) => i.name.toLowerCase().includes(args.name!.toLowerCase()))
        : items;
      return ok({
        items: filtered.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity ?? null,
          unit: i.unit ?? null,
          confidence: i.confidence,
          stale: i.stale,
          expiresSoon: i.expiresSoon,
          expired: i.expired,
          daysUntilExpiration: i.daysUntilExpiration,
          lastConfirmedAt: i.lastConfirmedAt,
          expirationDate: i.expirationDate ?? null,
          notes: i.notes ?? null,
        })),
        stale: filtered.filter((i) => i.stale).map((i) => i.name),
        // K10 expiration awareness: the reply can surface what to use up or
        // replenish without the model guessing dates.
        expiringSoon: filtered.filter((i) => i.expiresSoon).map((i) => i.name),
        expired: filtered.filter((i) => i.expired).map((i) => i.name),
        query: args.name ?? null,
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const addPantryItemTool: ToolDefinition = {
  name: 'add_pantry_item',
  description: 'Add an item to the user\'s pantry (source VOICE by default). Persists immediately.',
  inputSchema: z.object({
    name: z.string().min(1),
    quantity: z.number().nonnegative().optional(),
    unit: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      const item = await service.addItem(ctx.userId, {
        name: args.name,
        quantity: args.quantity,
        unit: args.unit,
        source: 'VOICE',
      }, { sessionId });
      // The user offered this item — record it as pending confirmation on the
      // active session so "yes" can acknowledge it (K8 confirm flow).
      if (sessionId) {
        const session = await ctx.sessionService.getSession(sessionId);
        if (session) {
          await ctx.sessionService.updateSessionMetadata(session.id, session.version, {
            pendingPantryItems: [
              ...(session.pendingPantryItems ?? []),
              {
                itemId: item.id,
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
              },
            ],
          });
        }
      }
      return ok({ item, pending: true });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const updatePantryItemTool: ToolDefinition = {
  name: 'update_pantry_item',
  description: 'Correct a pantry item\'s quantity, unit, notes, or expirationDate (epoch ms; null clears the field).',
  inputSchema: z.object({
    itemId: z.string().min(1),
    quantity: z.number().nonnegative().nullable().optional(),
    unit: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    expirationDate: z.number().int().positive().nullable().optional(),
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      const item = await service.updateItem(ctx.userId, args.itemId, {
        quantity: args.quantity,
        unit: args.unit,
        notes: args.notes,
        expirationDate: args.expirationDate,
      }, { sessionId });
      return ok({ item });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const removePantryItemTool: ToolDefinition = {
  name: 'remove_pantry_item',
  description: 'Remove an item from the user\'s pantry (by itemId, or by exact name).',
  inputSchema: z.object({
    itemId: z.string().optional(),
    name: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      if (!args.itemId && !args.name) {
        return fail('INVALID_ARGUMENTS', 'remove_pantry_item requires an itemId or a name', true);
      }
      let itemId = args.itemId;
      if (!itemId && args.name) {
        const items = await service.listPantry(ctx.userId);
        const match = items.find((i) => i.name.toLowerCase() === args.name!.toLowerCase());
        if (!match) {
          return fail('PANTRY_NOT_FOUND', `No pantry item named "${args.name}"`, true);
        }
        itemId = match.id;
      }
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      const removed = await service.removeItem(ctx.userId, itemId!, { sessionId });
      return ok({ removed });
    } catch (e) {
      if (e instanceof PantryError) {
        return fail(e.code, e.message, e.recoverable);
      }
      return toToolError(e);
    }
  },
};

export const confirmPantryItemTool: ToolDefinition = {
  name: 'confirm_pantry_item',
  description: 'Confirm the user still has a pantry item — raises confidence to 1 and refreshes the date.',
  inputSchema: z.object({ itemId: z.string().min(1), sessionId: z.string().optional() }),
  async handler(ctx, args) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      const item = await service.confirmItem(ctx.userId, args.itemId, { sessionId });
      return ok({ item });
    } catch (e) {
      return toToolError(e);
    }
  },
};

/**
 * Confirm every pantry item the user offered this session ("I always have …")
 * and clear the pending list. The user's "yes" is the acknowledgment gate.
 */
export const confirmPendingPantryItemsTool: ToolDefinition = {
  name: 'confirm_pending_pantry_items',
  description: 'Confirm all pantry items the user just offered in the current session (the pending list). Raises each to full confidence.',
  inputSchema: z.object({}),
  async handler(ctx) {
    const service = pantry(ctx);
    if (!service) return pantryUnavailable();
    try {
      const session = await ctx.sessionService.getActiveSession(ctx.userId);
      const pending = session?.pendingPantryItems ?? [];
      if (!session || pending.length === 0) {
        return fail('NO_PENDING_PANTRY_ITEMS', 'No pantry items are waiting for confirmation', true);
      }
      const confirmed: { id: string; name: string }[] = [];
      for (const pendingItem of pending) {
        const item = await service.confirmItem(ctx.userId, pendingItem.itemId, { sessionId: session.id });
        confirmed.push({ id: item.id, name: item.name });
      }
      await ctx.sessionService.updateSessionMetadata(session.id, session.version, {
        pendingPantryItems: [],
      });
      return ok({ confirmed });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const getDietaryProfileTool: ToolDefinition = {
  name: 'get_dietary_profile',
  description: 'Inspect the user\'s remembered dietary profile (allergies, restrictions, dislikes, cuisines, servings, equipment).',
  inputSchema: z.object({}),
  async handler(ctx) {
    const service = profileService(ctx);
    if (!service) return fail('PROFILE_UNAVAILABLE', 'Dietary profile storage is not available', true);
    try {
      const profile = await service.getProfile(ctx.userId);
      return ok({ profile });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const updateDietaryProfileTool: ToolDefinition = {
  name: 'update_dietary_profile',
  description: 'Change the user\'s remembered dietary profile. Arrays replace the whole list — pass the full desired set.',
  inputSchema: z.object({
    allergies: z.array(z.string()).optional(),
    dietaryRestrictions: z.array(z.string()).optional(),
    dislikedIngredients: z.array(z.string()).optional(),
    preferredCuisines: z.array(z.string()).optional(),
    defaultServings: z.number().int().positive().optional(),
    preferredEquipment: z.array(z.string()).optional(),
  }),
  async handler(ctx, args) {
    const service = profileService(ctx);
    if (!service) return fail('PROFILE_UNAVAILABLE', 'Dietary profile storage is not available', true);
    try {
      const profile = await service.updateProfile(ctx.userId, args);
      return ok({ profile });
    } catch (e) {
      return toToolError(e);
    }
  },
};
