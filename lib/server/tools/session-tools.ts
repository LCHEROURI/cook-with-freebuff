// ─────────────────────────────────────────────────────────────────────────────
// Session tools
//
// Thin wrappers over SessionService. The agent never mutates session state
// directly — it calls these tools and the backend applies state-machine rules.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import type { CookingSession } from '../../domain/types';
import { rebaseTimersAfterResume } from '../timer-rebase';
import { createGuideService } from './guide-tools';

/** Guided-cooking service bound to the tool context. */
function guide(ctx: ToolContext) {
  return createGuideService(ctx);
}

type ResolvedSession =
  | { ok: true; session: CookingSession }
  | { ok: false; result: ToolResult };

async function resolveSession(
  ctx: ToolContext,
  sessionId?: string,
): Promise<ResolvedSession> {
  const session = sessionId
    ? await ctx.sessionService.getSession(sessionId)
    : await ctx.sessionService.getActiveSession(ctx.userId);
  if (!session) {
    return { ok: false, result: fail('SESSION_NOT_FOUND', 'No cooking session found for this user', true) };
  }
  if (session.userId !== ctx.userId) {
    return { ok: false, result: fail('FORBIDDEN', 'Session belongs to another user', false) };
  }
  return { ok: true, session };
}

export const startCookingSessionTool: ToolDefinition = {
  name: 'start_cooking_session',
  description: 'Start a new cooking session (optionally pinned to a recipe id).',
  inputSchema: z.object({ recipeId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const session = await ctx.sessionService.createSession(ctx.userId, {
        recipeId: args.recipeId,
        correlationId: ctx.correlationId,
      });
      return ok({
        sessionId: session.id,
        phase: session.currentPhase,
        status: session.status,
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const getCookingSessionTool: ToolDefinition = {
  name: 'get_cooking_session',
  description: 'Get the current cooking session (active by default, or by id).',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;
    return ok({
      sessionId: s.id,
      phase: s.currentPhase,
      status: s.status,
      prepStepIndex: s.currentPrepStepIndex,
      cookingStepIndex: s.currentCookingStepIndex,
      activeTimerIds: s.activeTimerIds,
      availableIngredients: s.availableIngredients,
    });
  },
};

export const getCurrentStepTool: ToolDefinition = {
  name: 'get_current_step',
  description: 'Get the current step (prep or cooking) for the active session — the ONE action to do now.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const snapshot = await guide(ctx).getCurrentAction(ctx.userId, args.sessionId);
      if (!snapshot.found) {
        return fail('SESSION_NOT_FOUND', 'No cooking session found for this user', true);
      }
      return ok(snapshot);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const completeCurrentStepTool: ToolDefinition = {
  name: 'complete_current_step',
  description: 'Advance to the next step after the user says "done". Auto-transitions prep → cooking → plating and auto-starts timers on timed steps. A step with a safetyNote first returns a safety gate (SAFETY_WARNING) — the step completes only after the user confirms the note. Only advances on backend success.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const snapshot = await guide(ctx).completeCurrentAction(ctx.userId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok(snapshot);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const repeatCurrentStepTool: ToolDefinition = {
  name: 'repeat_current_step',
  description: 'Repeat the current step (does not change progress).',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const snapshot = await guide(ctx).repeatAction(ctx.userId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok(snapshot);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const previousStepTool: ToolDefinition = {
  name: 'previous_step',
  description: 'Go back to the previous step (never below step 0).',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    try {
      const snapshot = await guide(ctx).previousAction(ctx.userId, args.sessionId, {
        correlationId: ctx.correlationId,
      });
      return ok(snapshot);
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const pauseCookingSessionTool: ToolDefinition = {
  name: 'pause_cooking_session',
  description: 'Pause the cooking session, preserving the resumable state.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;
    try {
      const updated = await ctx.sessionService.pauseSession(s.id, s.version, {
        correlationId: ctx.correlationId,
      });
      return ok({ sessionId: updated.id, phase: updated.currentPhase, status: updated.status });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const resumeCookingSessionTool: ToolDefinition = {
  name: 'resume_cooking_session',
  description: 'Resume a paused session at the exact step it was paused on.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;
    try {
      // Pause froze the timers (snapshot reports the at-pause remainder);
      // resume shifts endsAt forward by the paused duration so the countdown
      // continues from where it froze instead of firing instantly.
      if (s.pausedAt) {
        await rebaseTimersAfterResume(ctx.timerStore, s.id, s.pausedAt);
      }
      const updated = await ctx.sessionService.resumeSession(s.id, s.version, {
        correlationId: ctx.correlationId,
      });
      return ok({ sessionId: updated.id, phase: updated.currentPhase, status: updated.status });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const endCookingSessionTool: ToolDefinition = {
  name: 'end_cooking_session',
  description: 'End the session (completed=true marks COMPLETED; false abandons).',
  inputSchema: z.object({ sessionId: z.string().optional(), completed: z.boolean().default(true) }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;
    try {
      const updated = await ctx.sessionService.endSession(s.id, s.version, {
        completed: args.completed,
        correlationId: ctx.correlationId,
      });
      return ok({ sessionId: updated.id, phase: updated.currentPhase, status: updated.status });
    } catch (e) {
      return toToolError(e);
    }
  },
};