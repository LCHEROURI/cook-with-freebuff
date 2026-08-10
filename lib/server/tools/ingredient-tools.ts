// ─────────────────────────────────────────────────────────────────────────────
// Ingredient tools
//
// save_available_ingredients   — replace the session's ingredient list
// update_available_ingredients — upsert (merge by name)
// confirm_available_ingredients— advance COLLECTING → CONFIRMING after the
//                                user approves the extracted summary
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ingredientSchema } from '../../domain/schemas';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext } from './types';
import type { CookingSession, Ingredient } from '../../domain/types';

async function ownedSession(
  ctx: ToolContext,
  sessionId?: string,
): Promise<CookingSession | null> {
  const session = sessionId
    ? await ctx.sessionService.getSession(sessionId)
    : await ctx.sessionService.getActiveSession(ctx.userId);
  if (!session) return null;
  if (session.userId !== ctx.userId) return null; // object-level authorization
  return session;
}

export const saveAvailableIngredientsTool: ToolDefinition = {
  name: 'save_available_ingredients',
  description: 'Replace the session\'s available-ingredient list with the given ingredients.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    ingredients: z.array(ingredientSchema).min(1),
  }),
  async handler(ctx, args) {
    const session = await ownedSession(ctx, args.sessionId);
    if (!session) {
      return fail('SESSION_NOT_FOUND', 'No cooking session found for this user', true);
    }
    try {
      const updated = await ctx.sessionService.updateAvailableIngredients(
        session.id,
        session.version,
        args.ingredients as Ingredient[],
        'REPLACE',
        { correlationId: ctx.correlationId },
      );
      return ok({ sessionId: updated.id, ingredients: updated.availableIngredients });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const updateAvailableIngredientsTool: ToolDefinition = {
  name: 'update_available_ingredients',
  description: 'Upsert ingredients into the session\'s available-ingredient list (merge by name).',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    ingredients: z.array(ingredientSchema).min(1),
  }),
  async handler(ctx, args) {
    const session = await ownedSession(ctx, args.sessionId);
    if (!session) {
      return fail('SESSION_NOT_FOUND', 'No cooking session found for this user', true);
    }
    try {
      const updated = await ctx.sessionService.updateAvailableIngredients(
        session.id,
        session.version,
        args.ingredients as Ingredient[],
        'UPSERT',
        { correlationId: ctx.correlationId },
      );
      return ok({ sessionId: updated.id, ingredients: updated.availableIngredients });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const confirmAvailableIngredientsTool: ToolDefinition = {
  name: 'confirm_available_ingredients',
  description: 'Confirm the collected ingredient list and advance the session to ingredient confirmation.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const session = await ownedSession(ctx, args.sessionId);
    if (!session) {
      return fail('SESSION_NOT_FOUND', 'No cooking session found for this user', true);
    }
    if (session.currentPhase !== 'COLLECTING_INGREDIENTS') {
      return fail(
        'INVALID_PHASE',
        `Cannot confirm ingredients in phase ${session.currentPhase}`,
        true,
      );
    }
    try {
      const updated = await ctx.sessionService.transitionTo(
        session.id,
        session.version,
        'CONFIRMING_INGREDIENTS',
        'USER_INPUT',
        { correlationId: ctx.correlationId },
      );
      return ok({ sessionId: updated.id, phase: updated.currentPhase });
    } catch (e) {
      return toToolError(e);
    }
  },
};