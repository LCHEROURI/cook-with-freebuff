// ─────────────────────────────────────────────────────────────────────────────
// POST /api/voice/token — mint a Gemini Live ephemeral session token
//
// Auth: Bearer <Firebase ID token> (same as /api/tools and /api/agent).
//
// The browser NEVER sees GOOGLE_AI_API_KEY. It POSTs here, receives a
// short-lived, single-use token (`uses: 1`, 30-min session / 2-min start
// window), and connects the Live WebSocket with it via
// `BidiGenerateContentConstrained?access_token=<token>`.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';

const MINT_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';
const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const SESSION_TTL_MS = 30 * 60 * 1000; // messages allowed for 30 minutes
const START_TTL_MS = 2 * 60 * 1000; // must open the session within 2 minutes

export async function POST(req: Request) {
  const appCheck = await gateAppCheck(req, { consume: true });
  if (appCheck) return appCheck;

  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  const userId = await resolveUserId(bearer);
  if (!userId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', recoverable: false } },
      { status: 401 },
    );
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: { code: 'VOICE_UNAVAILABLE', message: 'Voice is not configured on the server right now.', recoverable: true } },
      { status: 503 },
    );
  }

  let minted: { name?: unknown; expireTime?: unknown };
  try {
    const res = await fetch(MINT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(Date.now() + START_TTL_MS).toISOString(),
      }),
    });
    minted = (await res.json()) as { name?: unknown; expireTime?: unknown };
    if (!res.ok || typeof minted.name !== 'string' || minted.name.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'UPSTREAM', message: 'Could not start a voice session right now.', recoverable: true } },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'UPSTREAM', message: 'Could not reach the voice service.', recoverable: true } },
      { status: 502 },
    );
  }

  // The ephemeral token is single-use and expires in minutes — safe to hand to
  // the client. The API key itself never leaves this route.
  return NextResponse.json({
    success: true,
    data: {
      token: minted.name,
      model: process.env.LIVE_MODEL ?? DEFAULT_LIVE_MODEL,
      expiresAt: typeof minted.expireTime === 'string' ? minted.expireTime : null,
    },
  });
}
