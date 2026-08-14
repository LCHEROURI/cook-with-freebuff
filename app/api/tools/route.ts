// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tools — execute a named agent tool
//
// Body: { tool: string, arguments: object, correlationId?: string }
// Auth: Bearer <Firebase ID token>
//
// The tool name + arguments are validated by the executor; the userId comes
// from the verified token, never from the client.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { defaultToolRegistry, executeTool } from '@/lib/server/tools';
import { buildProductionContext } from '@/lib/server/stores';
import { logInfo } from '@/lib/server/logger';
import {
  generateCorrelationId,
  runWithContext,
  validateClientCorrelationId,
  INVALID_CORRELATION_ID_MESSAGE,
} from '@/lib/server/requestContext';

const TOOL_BODY_SCHEMA = {
  tool: (v: unknown): v is string => typeof v === 'string' && v.length > 0,
  // arguments validated per-tool by the executor
};

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

  const parsed = body as { tool?: unknown; arguments?: unknown; correlationId?: unknown };
  if (!TOOL_BODY_SCHEMA.tool(parsed.tool)) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Missing "tool" string', recoverable: false } },
      { status: 400 },
    );
  }

  // Boundary contract: a malformed client correlation id is rejected before it
  // can reach the tool layer (and from there the marker namespace).
  const cid = validateClientCorrelationId(parsed.correlationId);
  if (!cid.valid) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: INVALID_CORRELATION_ID_MESSAGE, recoverable: false } },
      { status: 400 },
    );
  }
  const correlationId: string = cid.id ?? generateCorrelationId();
  const toolName: string = parsed.tool as string;

  const startedAt = Date.now();
  logInfo('api.tools.request', {
    correlationId,
    userId: userId.slice(0, 10),
    tool: toolName,
  });

  return runWithContext(correlationId, async () => {
    const ctx = buildProductionContext(userId, correlationId);

    const result = await executeTool(
      defaultToolRegistry,
      ctx,
      toolName,
      parsed.arguments ?? {},
    );

    logInfo('api.tools.response', {
      correlationId,
      tool: toolName,
      success: result.success,
      latencyMs: Date.now() - startedAt,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  });
}