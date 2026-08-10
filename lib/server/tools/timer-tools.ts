// ─────────────────────────────────────────────────────────────────────────────
// Timer tools
//
// Timers have backend state (a `timers` document) — they never exist only in
// the LLM conversation. Starting a timer during COOKING_GUIDANCE transitions
// the session to WAITING_FOR_TIMER; completing it transitions back.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import type { CookingSession, CookingTimer } from '../../domain/types';

function newId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
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

export const startTimerTool: ToolDefinition = {
  name: 'start_timer',
  description: 'Start a backend-tracked timer for the session (transitions COOKING_GUIDANCE → WAITING_FOR_TIMER).',
  inputSchema: z.object({
    sessionId: z.string().optional(),
    label: z.string().min(1).max(200),
    durationSeconds: z.number().int().positive(),
    stepId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;

    if (s.currentPhase !== 'COOKING_GUIDANCE' && s.currentPhase !== 'WAITING_FOR_TIMER') {
      return fail('INVALID_PHASE', `Cannot start a timer in phase ${s.currentPhase}`, true);
    }

    try {
      const timerId = newId();
      const t = Date.now();
      const timer: CookingTimer = {
        id: timerId,
        userId: ctx.userId,
        sessionId: s.id,
        label: args.label,
        durationSeconds: args.durationSeconds,
        startedAt: t,
        endsAt: t + args.durationSeconds * 1000,
        status: 'RUNNING',
        stepId: args.stepId,
      };
      await ctx.timerStore.createTimer(timer);

      // If we're mid-cooking, enter WAITING_FOR_TIMER before attaching.
      let session = s;
      if (session.currentPhase === 'COOKING_GUIDANCE') {
        session = await ctx.sessionService.transitionTo(
          session.id,
          session.version,
          'WAITING_FOR_TIMER',
          'AGENT_TOOL',
          { correlationId: ctx.correlationId },
        );
      }
      const updated = await ctx.sessionService.attachTimer(
        session.id,
        session.version,
        timerId,
        { correlationId: ctx.correlationId },
      );

      return ok({
        timerId,
        sessionId: updated.id,
        phase: updated.currentPhase,
        endsAt: timer.endsAt,
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const getActiveTimersTool: ToolDefinition = {
  name: 'get_active_timers',
  description: 'List all running timers for the session.',
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async handler(ctx, args) {
    const resolved = await resolveSession(ctx, args.sessionId);
    if (!resolved.ok) return resolved.result;
    const s = resolved.session;
    const timers = await ctx.timerStore.listActiveTimers(s.id);
    return ok({
      sessionId: s.id,
      timers: timers.map((t) => ({
        timerId: t.id,
        label: t.label,
        durationSeconds: t.durationSeconds,
        endsAt: t.endsAt,
        stepId: t.stepId,
      })),
    });
  },
};

export const cancelTimerTool: ToolDefinition = {
  name: 'cancel_timer',
  description: 'Cancel a running timer and detach it from the session.',
  inputSchema: z.object({ timerId: z.string().min(1) }),
  async handler(ctx, args) {
    const timer = await ctx.timerStore.getTimer(args.timerId);
    if (!timer) return fail('TIMER_NOT_FOUND', `Timer ${args.timerId} not found`, true);
    if (timer.userId !== ctx.userId) {
      return fail('FORBIDDEN', 'Timer belongs to another user', false);
    }

    try {
      await ctx.timerStore.updateTimer(args.timerId, {
        status: 'CANCELLED',
        completedAt: Date.now(),
      });
      const session = await ctx.sessionService.getSession(timer.sessionId);
      let sessionId = timer.sessionId;
      if (session && session.userId === ctx.userId) {
        const updated = await ctx.sessionService.detachTimer(session.id, session.version, args.timerId);
        await ctx.sessionService.logSessionEvent(session.id, 'TIMER_CANCELLED', { timerId: args.timerId }, {
          correlationId: ctx.correlationId,
        });
        sessionId = updated.id;
      }
      return ok({ timerId: args.timerId, status: 'CANCELLED', sessionId });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const completeTimerTool: ToolDefinition = {
  name: 'complete_timer',
  description: 'Mark a timer completed; if the session is WAITING_FOR_TIMER, return it to COOKING_GUIDANCE.',
  inputSchema: z.object({ timerId: z.string().min(1) }),
  async handler(ctx, args) {
    const timer = await ctx.timerStore.getTimer(args.timerId);
    if (!timer) return fail('TIMER_NOT_FOUND', `Timer ${args.timerId} not found`, true);
    if (timer.userId !== ctx.userId) {
      return fail('FORBIDDEN', 'Timer belongs to another user', false);
    }

    try {
      await ctx.timerStore.updateTimer(args.timerId, {
        status: 'COMPLETED',
        completedAt: Date.now(),
      });

      const session = await ctx.sessionService.getSession(timer.sessionId);
      if (!session || session.userId !== ctx.userId) {
        return ok({ timerId: args.timerId, status: 'COMPLETED', sessionId: timer.sessionId });
      }

      const detached = await ctx.sessionService.detachTimer(session.id, session.version, args.timerId);
      await ctx.sessionService.logSessionEvent(session.id, 'TIMER_COMPLETED', { timerId: args.timerId }, {
        correlationId: ctx.correlationId,
      });

      // Return the session to cooking guidance if it was waiting on this timer.
      let finalSession = detached;
      if (finalSession.currentPhase === 'WAITING_FOR_TIMER') {
        finalSession = await ctx.sessionService.transitionTo(
          finalSession.id,
          finalSession.version,
          'COOKING_GUIDANCE',
          'TIMER_COMPLETED',
          { correlationId: ctx.correlationId },
        );
      }

      return ok({
        timerId: args.timerId,
        status: 'COMPLETED',
        sessionId: finalSession.id,
        phase: finalSession.currentPhase,
      });
    } catch (e) {
      return toToolError(e);
    }
  },
};