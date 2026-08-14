// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent — one conversational turn
//
// Body: { utterance: string, sessionId?: string, correlationId?: string }
// Auth: Bearer <Firebase ID token>
//
// Runs the ConversationOrchestrator: command routing → ingredient extraction
// → tool execution → concise spoken response. Never false success.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { defaultToolRegistry } from '@/lib/server/tools';
import { buildProductionContext } from '@/lib/server/stores';
import { getConversationAgent } from '@/lib/ai/provider';
import { ConversationOrchestrator } from '@/lib/agent';
import { logError, logInfo } from '@/lib/server/logger';
import {
  generateCorrelationId,
  runWithContext,
  validateClientCorrelationId,
  INVALID_CORRELATION_ID_MESSAGE,
} from '@/lib/server/requestContext';

export async function POST(req: Request) {
  const appCheck = await gateAppCheck(req);
  if (appCheck) return appCheck;

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

  const parsed = body as { utterance?: unknown; sessionId?: unknown; correlationId?: unknown };
  if (typeof parsed.utterance !== 'string' || parsed.utterance.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Missing "utterance" string', recoverable: false } },
      { status: 400 },
    );
  }

  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  // Boundary contract: a malformed client correlation id is rejected before it
  // can reach the tool layer (and from there the marker namespace).
  const cid = validateClientCorrelationId(parsed.correlationId);
  if (!cid.valid) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: INVALID_CORRELATION_ID_MESSAGE, recoverable: false } },
      { status: 400 },
    );
  }
  const correlationId = cid.id ?? generateCorrelationId();

  const startedAt = Date.now();
  logInfo('api.agent.request', {
    correlationId,
    userId: userId.slice(0, 10),
    sessionId: sessionId?.slice(0, 10),
    utteranceLen: parsed.utterance.length,
  });

  return runWithContext(correlationId, async () => {
    const ctx = buildProductionContext(userId, correlationId);
    const provider = getConversationAgent();

    const orchestrator = new ConversationOrchestrator({ registry: defaultToolRegistry, context: ctx, provider });
    let turn;
    try {
      turn = await orchestrator.process(parsed.utterance as string, sessionId);
    } catch (e) {
      logError('api.agent.error', {
        correlationId,
        userId: userId.slice(0, 10),
        sessionId: sessionId?.slice(0, 10),
        message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        latencyMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { utterance: parsed.utterance, response: 'I had trouble with that. Please try again.', toolCalls: [], status: 'ERROR' },
      );
    } finally {
      logInfo('api.agent.response', {
        correlationId,
        latencyMs: Date.now() - startedAt,
        status: (turn as { status?: string } | undefined)?.status ?? 'ERROR',
      });
    }

    return NextResponse.json(turn);
  });
}