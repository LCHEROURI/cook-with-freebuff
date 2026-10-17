// ─────────────────────────────────────────────────────────────────────────────
// /api/billing — subscription entitlements & Google Play Billing verification
//
// GET   → returns user entitlements (tier, quotas, usage)
// POST  → verifies Play Store purchase token and upgrades to Chef Pro
// Auth: Bearer <Firebase ID token>
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { entitlementsService } from '@/lib/server/entitlements-service';
import { logError, logInfo } from '@/lib/server/logger';

export async function GET(req: Request) {
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

  const entitlement = await entitlementsService.getEntitlement(userId);
  return NextResponse.json({ success: true, data: entitlement });
}

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

  let body: { action?: unknown; purchaseToken?: unknown; orderId?: unknown; platform?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON', recoverable: false } },
      { status: 400 },
    );
  }

  const action = typeof body.action === 'string' ? body.action : 'verify_purchase';

  if (action === 'verify_purchase' || action === 'verify_play_purchase') {
    const purchaseToken = typeof body.purchaseToken === 'string' ? body.purchaseToken.trim() : null;
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : undefined;

    if (!purchaseToken) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_PURCHASE_TOKEN', message: 'Missing purchase token', recoverable: false } },
        { status: 400 },
      );
    }

    try {
      const updated = await entitlementsService.upgradeToPro(userId, {
        platform: 'google_play',
        purchaseToken,
        orderId,
      });
      logInfo('api.billing.upgrade', { userId, platform: 'google_play' });
      return NextResponse.json({ success: true, data: updated });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to process purchase';
      logError('api.billing.upgrade_failed', { userId, error: message });
      return NextResponse.json(
        { success: false, error: { code: 'UPGRADE_FAILED', message, recoverable: true } },
        { status: 500 },
      );
    }
  }

  return NextResponse.json(
    { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}`, recoverable: false } },
    { status: 400 },
  );
}
