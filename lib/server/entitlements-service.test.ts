import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

import { EntitlementsService } from './entitlements-service';
import { TIER_LIMITS, type UserEntitlement } from '@/lib/domain/entitlements';

describe('EntitlementsService', () => {
  let mockDocData: Partial<UserEntitlement> | null = null;
  let mockSet: ReturnType<typeof vi.fn>;
  let mockUpdate: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockDb: any;
  let service: EntitlementsService;

  beforeEach(() => {
    mockDocData = null;
    mockSet = vi.fn().mockImplementation((data) => {
      mockDocData = { ...mockDocData, ...data };
      return Promise.resolve();
    });
    mockUpdate = vi.fn().mockImplementation((data) => {
      mockDocData = { ...mockDocData, ...data };
      return Promise.resolve();
    });
    mockGet = vi.fn().mockImplementation(() => ({
      exists: mockDocData !== null,
      data: () => mockDocData,
    }));

    mockDb = {
      collection: vi.fn().mockReturnValue({
        doc: vi.fn().mockReturnValue({
          get: mockGet,
          set: mockSet,
          update: mockUpdate,
        }),
      }),
      runTransaction: vi.fn().mockImplementation(async (cb) => {
        return cb({
          get: mockGet,
          set: mockSet,
          update: mockUpdate,
        });
      }),
    };

    service = new EntitlementsService(() => mockDb);
  });

  it('initializes default free tier for a new user', async () => {
    const entitlement = await service.getEntitlement('user-123');
    expect(entitlement.tier).toBe('free');
    expect(entitlement.status).toBe('active');
    expect(entitlement.usage.voiceSecondsUsed).toBe(0);
    expect(mockSet).toHaveBeenCalled();
  });

  it('checks voice quota for free tier and allows within budget', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 100,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const result = await service.checkVoiceQuota('user-123', 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(TIER_LIMITS.free.voiceSecondsPerCycle - 100);
  });

  it('rejects voice request when quota is exhausted', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: TIER_LIMITS.free.voiceSecondsPerCycle,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const result = await service.checkVoiceQuota('user-123', 30);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('VOICE_QUOTA_EXCEEDED');
    expect(result.remaining).toBe(0);
  });

  it('always allows voice quota for pro tier', async () => {
    mockDocData = {
      userId: 'user-pro',
      tier: 'pro',
      status: 'active',
      usage: {
        voiceSecondsUsed: 999999,
        recipesGeneratedCount: 9999,
        visionScansCount: 9999,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const result = await service.checkVoiceQuota('user-pro', 300);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('pro');
  });

  it('checks and rejects recipe quota when limit is reached', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 0,
        recipesGeneratedCount: TIER_LIMITS.free.recipeGenerationsPerCycle,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const result = await service.checkRecipeQuota('user-123');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('RECIPE_QUOTA_EXCEEDED');
  });

  it('atomically reserves recipe quota and rolls back on failure', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 0,
        recipesGeneratedCount: 2,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const reservation = await service.reserveRecipeQuota('user-123');
    expect(reservation.allowed).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        'usage.recipesGeneratedCount': 3,
      }),
    );

    // Rollback decrements
    await reservation.rollback();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('atomically reserves voice duration and rolls back on failure', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 600,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    const reservation = await service.reserveVoiceQuota('user-123', 300);
    expect(reservation.allowed).toBe(true);
    expect(reservation.issuedSeconds).toBe(300);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        'usage.voiceSecondsUsed': 900,
      }),
    );

    await reservation.rollback();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('upgrades user to Pro upon purchase using update', async () => {
    mockDocData = {
      userId: 'user-123',
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 0,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    };

    await service.upgradeToPro('user-123', {
      platform: 'google_play',
      purchaseToken: 'tok_play_123',
      orderId: 'GPA.1234-5678',
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'pro',
        status: 'active',
        platform: 'google_play',
        purchaseToken: 'tok_play_123',
      }),
    );
  });

  describe('APP_OWNER_UID recognition', () => {
    const originalOwnerUid = process.env.APP_OWNER_UID;

    beforeEach(() => {
      process.env.APP_OWNER_UID = 'owner-uid-123';
    });

    afterEach(() => {
      process.env.APP_OWNER_UID = originalOwnerUid;
    });

    it('initializes default Pro tier for APP_OWNER_UID when no document exists', async () => {
      const entitlement = await service.getEntitlement('owner-uid-123');
      expect(entitlement.tier).toBe('pro');
      expect(entitlement.status).toBe('active');
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: 'pro',
          status: 'active',
        }),
      );
    });

    it('promotes APP_OWNER_UID to Pro if an existing document was recorded as free', async () => {
      mockDocData = {
        userId: 'owner-uid-123',
        tier: 'free',
        status: 'active',
        usage: {
          voiceSecondsUsed: 1200,
          recipesGeneratedCount: 10,
          visionScansCount: 5,
          cycleStartMs: Date.now(),
        },
        updatedAtMs: Date.now(),
      };

      const entitlement = await service.getEntitlement('owner-uid-123');
      expect(entitlement.tier).toBe('pro');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: 'pro',
          status: 'active',
        }),
      );
    });

    it('allows voice quota reservation for APP_OWNER_UID even when usage exceeds free limit', async () => {
      mockDocData = {
        userId: 'owner-uid-123',
        tier: 'free',
        status: 'active',
        usage: {
          voiceSecondsUsed: 1500,
          recipesGeneratedCount: 10,
          visionScansCount: 5,
          cycleStartMs: Date.now(),
        },
        updatedAtMs: Date.now(),
      };

      const reservation = await service.reserveVoiceQuota('owner-uid-123', 300);
      expect(reservation.allowed).toBe(true);
      expect(reservation.tier).toBe('pro');
      expect(reservation.remaining).toBe(Infinity);
    });
  });
});

