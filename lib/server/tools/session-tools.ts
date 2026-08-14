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

/** Random opaque token for per-attempt correlation-ID suffixes (see below). */
function rollbackNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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
      // Validate + transition FIRST, mutate timers AFTER (same contract as
      // guide-service.resume): a duplicate resume rejects with NOT_PAUSED
      // before any timer is touched. pausedAt persists on the doc after
      // resume, so the guard is the phase, never the field.
      const pausedAt = s.currentPhase === 'PAUSED' ? s.pausedAt : undefined;
      const updated = await ctx.sessionService.resumeSession(s.id, s.version, {
        correlationId: ctx.correlationId,
      });
      if (pausedAt) {
        // The frozen at-pause remainder carries through — shift endsAt
        // forward by the paused duration so the countdown continues where it
        // froze instead of firing instantly. On failure, roll the session
        // back to PAUSED with the ORIGINAL pausedAt so a retry is legal and
        // rebases from the untouched endsAt (same contract as
        // guide-service.resume — Codex P1: the transition and rebase must be
        // atomic or the rebase idempotently retryable).
        try {
          await rebaseTimersAfterResume(ctx.timerStore, updated.id, pausedAt);
        } catch (e) {
          // Same rollback contract as guide-service.resume — and the same
          // correlation-ID trap (Codex P1, PR #30 review): the re-pause must
          // NOT reuse ctx.correlationId, which resumeSession already marked
          // processed, or transitionTo would return the ACTIVE session
          // without pausing and silently undo the rollback.
          await ctx.sessionService
            .pauseSession(updated.id, updated.version, {
              // UNIQUE per attempt (Codex P1, PR #53 review): a deterministic
              // resume-rollback:<id> would collide on a second failed retry —
              // the first rollback already marked it processed, so the second
              // re-pause would be swallowed as a duplicate while the session
              // sat ACTIVE. Fresh nonce every attempt.
              correlationId: ctx.correlationId
                ? `resume-rollback:${ctx.correlationId}:${rollbackNonce()}`
                : undefined,
              pausedAt,
            })
            .then(async () => {
              // The rollback restored the PAUSED state with the ORIGINAL
              // pausedAt — the original resume ID is valid again. Forget it so
              // a client retry with that same ID transitions once instead of
              // being swallowed as a processed duplicate (Codex P1, PR #51).
              await ctx.sessionService.clearProcessed(ctx.correlationId);
            })
            .catch(() => undefined);
          return fail(
            'TIMER_REBASE_FAILED',
            'Resume could not finish syncing the paused timers — the session was paused again. Please resume once more.',
            true,
          );
        }
      }
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