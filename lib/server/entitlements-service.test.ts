import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('upgrades user to Pro upon purchase', async () => {
    const upgraded = await service.upgradeToPro('user-123', {
      platform: 'google_play',
      purchaseToken: 'tok_play_123',
      orderId: 'GPA.1234-5678',
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'pro',
        status: 'active',
        platform: 'google_play',
        purchaseToken: 'tok_play_123',
      }),
      { merge: true },
    );
  });
});
