// ─────────────────────────────────────────────────────────────────────────────
// Leftover tools (K10 — leftovers tracking)
//
// Thin wrappers over LeftoverService. get_leftovers lists what's still in the
// fridge (with how long it's been stored), log_leftover records a manual
// entry (takeout, a big batch), consume_leftover marks an entry eaten.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext } from './types';
import { LeftoverService } from '../leftover-service';
import type { Leftover } from '../../domain/types';

function leftovers(ctx: ToolContext): LeftoverService | null {
  if (!ctx.leftoverStore) return null;
  return new LeftoverService(ctx.leftoverStore, ctx.sessionService);
}

function unavailable(): ReturnType<typeof fail> {
  return fail('LEFTOVER_UNAVAILABLE', 'Leftover storage is not available', true);
}

/** Whole days the leftover has been stored (0 = today). */
function daysStored(leftover: Leftover): number {
  return Math.max(0, Math.floor((Date.now() - leftover.storedAt) / (24 * 60 * 60 * 1000)));
}

export const getLeftoversTool: ToolDefinition = {
  name: 'get_leftovers',
  description: 'List what is still in the fridge — ACTIVE leftovers from completed meals, newest first, with how long each has been stored.',
  inputSchema: z.object({}),
  async handler(ctx) {
    const service = leftovers(ctx);
    if (!service) return unavailable();
    try {
      const items = await service.listActiveLeftovers(ctx.userId);
      return ok({
        items: items.map((l) => ({
          id: l.id,
          title: l.title,
          servings: l.servings,
          recipeId: l.recipeId ?? null,
          storedDays: daysStored(l),
          storedAt: l.storedAt,
          notes: l.notes ?? null,
        })),
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const logLeftoverTool: ToolDefinition = {
  name: 'log_leftover',
  description: 'Record a leftover the user is keeping (e.g. takeout or a big batch) — appears in get_leftovers until consumed.',
  inputSchema: z.object({
    title: z.string().min(1).max(200),
    servings: z.number().int().positive().default(1),
    notes: z.string().max(500).optional(),
  }),
  async handler(ctx, args) {
    const service = leftovers(ctx);
    if (!service) return unavailable();
    try {
      const leftover = await service.createLeftover(ctx.userId, {
        title: args.title,
        servings: args.servings,
        notes: args.notes,
      });
      return ok({ leftover: { id: leftover.id, title: leftover.title, servings: leftover.servings } });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const consumeLeftoverTool: ToolDefinition = {
  name: 'consume_leftover',
  description: 'Mark a leftover as eaten/used up — removes it from the active fridge list.',
  inputSchema: z.object({
    leftoverId: z.string().min(1),
  }),
  async handler(ctx, args) {
    const service = leftovers(ctx);
    if (!service) return unavailable();
    try {
      await service.consumeLeftover(ctx.userId, args.leftoverId);
      return ok({ consumed: true });
    } catch (e) {
      return toToolError(e);
    }
  },
};
