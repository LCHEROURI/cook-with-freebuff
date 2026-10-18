// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/server/admin', () => ({
  resolveUserId: vi.fn(),
}));

vi.mock('@/lib/server/app-check', () => ({
  gateAppCheck: vi.fn(async () => null),
}));

vi.mock('@/lib/server/entitlements-service', () => ({
  entitlementsService: {
    getEntitlement: vi.fn(),
    upgradeToPro: vi.fn(),
  },
}));

vi.mock('@/lib/server/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/server/play-billing-verifier', () => ({
  verifyPlayPurchase: vi.fn(async () => ({
    valid: true,
    orderId: 'GPA.1234-5678',
    expiresAtMs: 2000,
  })),
}));

import { GET, POST } from './route';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { entitlementsService } from '@/lib/server/entitlements-service';
import { verifyPlayPurchase } from '@/lib/server/play-billing-verifier';

function createRequest(method: 'GET' | 'POST', body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      authorization: 'Bearer valid-token',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  return new Request('http://localhost/api/billing', init);
}

describe('/api/billing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateAppCheck).mockResolvedValue(null);
    vi.mocked(resolveUserId).mockResolvedValue('user-1');
  });

  describe('GET', () => {
    it('blocks request when App Check fails', async () => {
      vi.mocked(gateAppCheck).mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
      const res = await GET(createRequest('GET'));
      expect(res.status).toBe(403);
      expect(resolveUserId).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
      vi.mocked(resolveUserId).mockResolvedValueOnce(null);
      const res = await GET(createRequest('GET'));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns user entitlement data', async () => {
      const mockEntitlement = {
        userId: 'user-1',
        tier: 'free' as const,
        status: 'active' as const,
        usage: {
          voiceSecondsUsed: 120,
          recipesGeneratedCount: 2,
          visionScansCount: 1,
          cycleStartMs: 1000,
        },
        updatedAtMs: 1000,
      };
      vi.mocked(entitlementsService.getEntitlement).mockResolvedValueOnce(mockEntitlement);

      const res = await GET(createRequest('GET'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual(mockEntitlement);
      expect(entitlementsService.getEntitlement).toHaveBeenCalledWith('user-1');
    });
  });

  describe('POST', () => {
    it('blocks request when App Check fails', async () => {
      vi.mocked(gateAppCheck).mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
      const res = await POST(createRequest('POST', { purchaseToken: 'tok_123' }));
      expect(res.status).toBe(403);
      expect(resolveUserId).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
      vi.mocked(resolveUserId).mockResolvedValueOnce(null);
      const res = await POST(createRequest('POST', { purchaseToken: 'tok_123' }));
      expect(res.status).toBe(401);
    });

    it('returns 400 when body is invalid JSON', async () => {
      const badReq = new Request('http://localhost/api/billing', {
        method: 'POST',
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        body: 'bad-json{',
      });
      const res = await POST(badReq);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_BODY');
    });

    it('returns 400 when purchaseToken is missing', async () => {
      const res = await POST(createRequest('POST', { action: 'verify_purchase' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('MISSING_PURCHASE_TOKEN');
    });

    it('upgrades user to Pro on valid purchase token', async () => {
      const mockProEntitlement = {
        userId: 'user-1',
        tier: 'pro' as const,
        status: 'active' as const,
        platform: 'google_play' as const,
        purchaseToken: 'play_token_abc',
        usage: {
          voiceSecondsUsed: 120,
          recipesGeneratedCount: 2,
          visionScansCount: 1,
          cycleStartMs: 1000,
        },
        updatedAtMs: 2000,
      };
      vi.mocked(entitlementsService.upgradeToPro).mockResolvedValueOnce(mockProEntitlement);

      const res = await POST(
        createRequest('POST', {
          action: 'verify_purchase',
          purchaseToken: 'play_token_abc',
          orderId: 'GPA.1234-5678',
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.tier).toBe('pro');
      expect(entitlementsService.upgradeToPro).toHaveBeenCalledWith('user-1', {
        platform: 'google_play',
        purchaseToken: 'play_token_abc',
        orderId: 'GPA.1234-5678',
        expiresAtMs: 2000,
      });
    });

    it('returns 400 when Google Play purchase verification is rejected', async () => {
      vi.mocked(verifyPlayPurchase).mockResolvedValueOnce({
        valid: false,
        error: 'SUBSCRIPTION_EXPIRED',
      });

      const res = await POST(
        createRequest('POST', {
          purchaseToken: 'play_token_expired',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_PURCHASE');
      expect(entitlementsService.upgradeToPro).not.toHaveBeenCalled();
    });

    it('returns 500 when upgradeToPro throws', async () => {
      vi.mocked(entitlementsService.upgradeToPro).mockRejectedValueOnce(new Error('Firestore error'));

      const res = await POST(
        createRequest('POST', {
          purchaseToken: 'play_token_abc',
        }),
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('UPGRADE_FAILED');
    });

    it('returns 400 on unknown action', async () => {
      const res = await POST(
        createRequest('POST', {
          action: 'cancel_all',
          purchaseToken: 'tok',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_ACTION');
    });
  });
});
