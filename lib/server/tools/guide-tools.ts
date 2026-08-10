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

export const cookWithMeTool: ToolDefinition = {
  name: 'cook_with_me',
  description: 'Begin guided cooking ("Cook With Me") for a validated recipe — returns the first single action.',
  inputSchema: z.object({
    recipeId: z.string().min(1),
    sessionId: z.string().optional(),
  }),
  async handler(ctx, args) {
    try {
      const snapshot = await new GuidedCookingService(
        ctx.sessionService,
        ctx.timerStore,
        ctx.recipeStore,
      ).launchCookWithMe(ctx.userId, args.recipeId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok(snapshot);
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
      const { alerts, snapshot } = await new GuidedCookingService(
        ctx.sessionService,
        ctx.timerStore,
        ctx.recipeStore,
      ).checkTimers(ctx.userId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok({ alerts, snapshot });
    } catch (e) {
      return toToolError(e);
    }
  },
};
