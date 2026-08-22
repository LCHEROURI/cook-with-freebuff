// ─────────────────────────────────────────────────────────────────────────────
// Guided-cooking tools (K6 — "Cook With Me")
//
// cook_with_me launches one-action guided cooking from a validated recipe.
// check_timers surfaces finished timers and recovers the session to the
// exact step. Both go through the GuidedCookingService — never direct
// session mutation.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, toToolError } from './types';
import type { ToolDefinition, ToolContext } from './types';
import { GuidedCookingService } from '../guide-service';
import { PantryService } from '../pantry-service';
import { LeftoverService } from '../leftover-service';
import { GroceryService } from '../grocery-service';
import type { Ingredient } from '../../domain/types';

/**
 * Guided-cooking service bound to the tool context. When the pantry store is
 * wired, the service also adjusts pantry inventory on recipe completion (K8);
 * with leftover + grocery stores it logs the finished meal as a leftover and
 * auto-generates grocery lines for depleted + expired items (K10).
 */
export function createGuideService(ctx: ToolContext): GuidedCookingService {
  return new GuidedCookingService(
    ctx.sessionService,
    ctx.timerStore,
    ctx.recipeStore,
    ctx.pantryStore ? new PantryService(ctx.pantryStore, ctx.sessionService) : undefined,
    ctx.leftoverStore ? new LeftoverService(ctx.leftoverStore, ctx.sessionService) : undefined,
    ctx.groceryStore ? new GroceryService(ctx.groceryStore) : undefined,
    ctx.dietaryProfileStore,
  );
}

export const cookWithMeTool: ToolDefinition = {
  name: 'cook_with_me',
  description: 'Begin guided cooking ("Cook With Me") for a validated recipe — returns the first single action.',
  inputSchema: z.object({
    recipeId: z.string().min(1),
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    try {
      const snapshot = await createGuideService(ctx).launchCookWithMe(ctx.userId, args.recipeId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok(snapshot);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const requestSubstitutionTool: ToolDefinition = {
  name: 'request_substitution',
  description: 'The cook is out of an ingredient — preserve the session location and return viable substitution candidates.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    unavailableIngredient: z.string().min(1),
  }),
  async handler(ctx, args) {
    try {
      const result = await createGuideService(ctx).requestSubstitution(ctx.userId, args.sessionId, args.unavailableIngredient, {
        correlationId: ctx.correlationId,
      });
      return ok(result);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const applySubstitutionTool: ToolDefinition = {
  name: 'apply_substitution',
  description: 'Confirm a substitution: replace the ingredient throughout the recipe, revalidate, and resume the exact step. Never silent. unavailableIngredient may be omitted when a substitution is already pending.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    unavailableIngredient: z.string().optional(),
    replacement: z.string().min(1),
  }),
  async handler(ctx, args) {
    try {
      const result = await createGuideService(ctx).applySubstitution(ctx.userId, args.sessionId, {
        unavailableIngredient: args.unavailableIngredient,
        replacement: args.replacement,
      }, {
        correlationId: ctx.correlationId,
      });
      return ok(result);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const correctIngredientTool: ToolDefinition = {
  name: 'correct_ingredient',
  description: 'The cook corrects an ingredient mid-guidance (quantity, unit, or removal). Persists the correction and resumes the exact step.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    name: z.string().min(1),
    quantity: z.number().nullable().optional(),
    unit: z.string().nullable().optional(),
    remove: z.boolean().default(false),
  }),
  async handler(ctx, args) {
    try {
      const ingredient: Ingredient = {
        id: `ing-${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: args.name,
        quantity: args.quantity ?? null,
        unit: args.unit ?? null,
        optional: false,
      };
      const result = await createGuideService(ctx).correctAvailableIngredients(ctx.userId, args.sessionId, [ingredient], args.remove ? 'REMOVE' : 'UPSERT', {
        correlationId: ctx.correlationId,
      });
      return ok(result);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const recoverSessionTool: ToolDefinition = {
  name: 'recover_session',
  description: 'Classify and handle the last error: bounded retry for transient failures, one question for user-correctable issues, canonical reload for state conflicts.',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    failedTool: z.string().optional(),
  }),
  async handler(ctx, args) {
    try {
      const decision = await createGuideService(ctx).recoverAfterError(ctx.userId, args.sessionId, {
        code: args.errorCode ?? 'INTERNAL_ERROR',
        message: args.errorMessage,
        failedTool: args.failedTool,
        recoverable: true,
      }, {
        correlationId: ctx.correlationId,
      });
      return ok(decision);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const checkTimersTool: ToolDefinition = {
  name: 'check_timers',
  description: 'Check for finished timers. Surfaces an alert for each completed timer and recovers the session to the exact step.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const { alerts, snapshot } = await createGuideService(ctx).checkTimers(ctx.userId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok({ alerts, snapshot });
    } catch (e) {
      return toToolError(e);
    }
  },
};
