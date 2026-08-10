// ─────────────────────────────────────────────────────────────────────────────
// /api/cook — guided cooking ("Cook With Me")
//
// POST { action: 'launch'|'status'|'done'|'repeat'|'back'|'pause'|'resume'|'timers',
//        sessionId?, recipeId?, correlationId? }
// GET  → status of the active session
// Auth: Bearer <Firebase ID token>
//
// Returns the ONE current action (never a whole procedure). Timer alerts
// surface via the 'timers' action. All mutations go through
// GuidedCookingService — never direct session writes.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';
import { GuidedCookingService } from '@/lib/server/guide-service';

const ACTIONS = ['launch', 'status', 'done', 'repeat', 'back', 'pause', 'resume', 'timers'] as const;
type CookAction = (typeof ACTIONS)[number];

function isCookAction(v: unknown): v is CookAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

async function handle(userId: string, body: unknown): Promise<NextResponse> {
  const parsed = body as { action?: unknown; sessionId?: unknown; recipeId?: unknown; correlationId?: unknown };

  const action: CookAction = isCookAction(parsed.action) ? parsed.action : 'status';
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const recipeId = typeof parsed.recipeId === 'string' ? parsed.recipeId : undefined;
  const correlationId = typeof parsed.correlationId === 'string' ? parsed.correlationId : undefined;

  const ctx = buildProductionContext(userId, correlationId);
  const guide = new GuidedCookingService(ctx.sessionService, ctx.timerStore, ctx.recipeStore);

  switch (action) {
    case 'launch': {
      if (!recipeId) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'launch requires a recipeId', recoverable: false } },
          { status: 400 },
        );
      }
      const snapshot = await guide.launchCookWithMe(userId, recipeId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'done': {
      const snapshot = await guide.completeCurrentAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'repeat': {
      const snapshot = await guide.repeatAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'back': {
      const snapshot = await guide.previousAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'pause': {
      const snapshot = await guide.pause(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'resume': {
      const snapshot = await guide.resume(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'timers': {
      const { alerts, snapshot } = await guide.checkTimers(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: { alerts, snapshot } });
    }
    default: {
      const snapshot = await guide.getCurrentAction(userId, sessionId);
      return NextResponse.json({ success: true, data: snapshot });
    }
  }
}

export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  const userId = await resolveUserId(token);
  if (!userId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', recoverable: false } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON', recoverable: false } },
      { status: 400 },
    );
  }

  try {
    return await handle(userId, body);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    const message = typeof err.message === 'string' ? err.message : 'Guided cooking request failed';
    const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
    return NextResponse.json({ success: false, error: { code, message, recoverable } }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  const userId = await resolveUserId(token);
  if (!userId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', recoverable: false } },
      { status: 401 },
    );
  }

  try {
    const snapshot = await handle(userId, { action: 'status' });
    return snapshot;
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    const message = typeof err.message === 'string' ? err.message : 'Guided cooking request failed';
    const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
    return NextResponse.json({ success: false, error: { code, message, recoverable } }, { status: 400 });
  }
}
