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
import { defaultToolRegistry } from '@/lib/server/tools';
import { buildProductionContext } from '@/lib/server/stores';
import { getConversationAgent } from '@/lib/ai/provider';
import { ConversationOrchestrator } from '@/lib/agent';

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

  const parsed = body as { utterance?: unknown; sessionId?: unknown; correlationId?: unknown };
  if (typeof parsed.utterance !== 'string' || parsed.utterance.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Missing "utterance" string', recoverable: false } },
      { status: 400 },
    );
  }

  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const correlationId = typeof parsed.correlationId === 'string' ? parsed.correlationId : undefined;
  const ctx = buildProductionContext(userId, correlationId);
  const provider = getConversationAgent();

  const orchestrator = new ConversationOrchestrator({ registry: defaultToolRegistry, context: ctx, provider });
  const turn = await orchestrator.process(parsed.utterance, sessionId);

  return NextResponse.json(turn);
}