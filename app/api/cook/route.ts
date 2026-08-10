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
import { createGuideService } from '@/lib/server/tools/guide-tools';

const ACTIONS = [
  'launch', 'status', 'done', 'repeat', 'back', 'pause', 'resume', 'timers',
  'substitute', 'apply_substitution', 'correct', 'recover', 'clear_recovery',
] as const;
type CookAction = (typeof ACTIONS)[number];

function isCookAction(v: unknown): v is CookAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

async function handle(userId: string, body: unknown): Promise<NextResponse> {
  const parsed = body as {
    action?: unknown;
    sessionId?: unknown;
    recipeId?: unknown;
    correlationId?: unknown;
    unavailableIngredient?: unknown;
    replacement?: unknown;
    name?: unknown;
    quantity?: unknown;
    unit?: unknown;
    remove?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
    failedTool?: unknown;
  };

  const action: CookAction = isCookAction(parsed.action) ? parsed.action : 'status';
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const recipeId = typeof parsed.recipeId === 'string' ? parsed.recipeId : undefined;
  const correlationId = typeof parsed.correlationId === 'string' ? parsed.correlationId : undefined;
  const unavailableIngredient = typeof parsed.unavailableIngredient === 'string' ? parsed.unavailableIngredient : undefined;
  const replacement = typeof parsed.replacement === 'string' ? parsed.replacement : undefined;
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  const quantity = typeof parsed.quantity === 'number' ? parsed.quantity : undefined;
  const unit = typeof parsed.unit === 'string' ? parsed.unit : undefined;
  const remove = parsed.remove === true;
  const errorCode = typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined;
  const errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;
  const failedTool = typeof parsed.failedTool === 'string' ? parsed.failedTool : undefined;

  const ctx = buildProductionContext(userId, correlationId);
  const guide = createGuideService(ctx);

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
    case 'substitute': {
      if (!unavailableIngredient) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'substitute requires an unavailableIngredient', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.requestSubstitution(userId, sessionId, unavailableIngredient, { correlationId });
      return NextResponse.json({ success: true, data: result });
    }
    case 'apply_substitution': {
      if (!replacement) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'apply_substitution requires a replacement', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.applySubstitution(userId, sessionId, {
        unavailableIngredient: unavailableIngredient ?? '',
        replacement,
      }, { correlationId });
      return NextResponse.json({ success: true, data: result });
    }
    case 'correct': {
      if (!name) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'correct requires an ingredient name', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.correctAvailableIngredients(
        userId,
        sessionId,
        [{
          id: `ing-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name,
          quantity: quantity ?? null,
          unit: unit ?? null,
          optional: false,
        }],
        remove ? 'REMOVE' : 'UPSERT',
        { correlationId },
      );
      return NextResponse.json({ success: true, data: result });
    }
    case 'recover': {
      const decision = await guide.recoverAfterError(userId, sessionId, {
        code: errorCode ?? 'INTERNAL_ERROR',
        message: errorMessage,
        failedTool,
        recoverable: true,
      }, { correlationId });
      return NextResponse.json({ success: true, data: decision });
    }
    case 'clear_recovery': {
      const snapshot = await guide.clearRecovery(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
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
