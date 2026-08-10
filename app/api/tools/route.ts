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
import { defaultToolRegistry, executeTool } from '@/lib/server/tools';
import { buildProductionContext } from '@/lib/server/stores';

const TOOL_BODY_SCHEMA = {
  tool: (v: unknown): v is string => typeof v === 'string' && v.length > 0,
  // arguments validated per-tool by the executor
};

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

  const parsed = body as { tool?: unknown; arguments?: unknown; correlationId?: unknown };
  if (!TOOL_BODY_SCHEMA.tool(parsed.tool)) {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Missing "tool" string', recoverable: false } },
      { status: 400 },
    );
  }

  const correlationId = typeof parsed.correlationId === 'string' ? parsed.correlationId : undefined;
  const ctx = buildProductionContext(userId, correlationId);

  const result = await executeTool(
    defaultToolRegistry,
    ctx,
    parsed.tool,
    parsed.arguments ?? {},
  );

  return NextResponse.json(result, { status: result.success ? 200 : 400 });
}