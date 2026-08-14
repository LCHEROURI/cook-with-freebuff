// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vision/scan — scan a photo for ingredients
//
// Body: { image: "<base64 data URI>" }
// Auth: Bearer <Firebase ID token>
//
// Returns recognized ingredients that can be fed directly into the recipe
// starter. Camera/upload happens entirely in the browser; this route only
// receives the image bytes and returns structured results.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { createGeminiVisionScanner } from '@/lib/ai/gemini-vision';
import { resolveGeminiModel } from '@/lib/server/model-config';
import { logError } from '@/lib/server/logger';

// Vision model resolves from Remote Config first, then VISION_MODEL, then the
// hardcoded default — so a vision model change needs no redeploy.
const scanner = createGeminiVisionScanner({ resolveModel: () => resolveGeminiModel('vision') });

export async function POST(req: Request) {
  const appCheck = await gateAppCheck(req, { consume: true });
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

  let body: { image?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON', recoverable: false } },
      { status: 400 },
    );
  }

  if (typeof body.image !== 'string' || !body.image.trim()) {
    return NextResponse.json(
      { success: false, error: { code: 'MISSING_IMAGE', message: 'Provide an image as a base64 data URI in the "image" field', recoverable: true } },
      { status: 400 },
    );
  }

  // Reject oversized images (6 MiB base64 ≈ 4.5 MiB raw).
  if (body.image.length > 8_000_000) {
    return NextResponse.json(
      { success: false, error: { code: 'IMAGE_TOO_LARGE', message: 'Image is too large. Use a photo under 6 MB.', recoverable: true } },
      { status: 400 },
    );
  }

  try {
    const results = await scanner.detectIngredients(body.image);
    return NextResponse.json({ success: true, data: { ingredients: results } });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not scan the image';
    logError('api.vision.scan', { userId, error: message.slice(0, 300) });
    return NextResponse.json(
      { success: false, error: { code: 'SCAN_FAILED', message, recoverable: true } },
      { status: 400 },
    );
  }
}
