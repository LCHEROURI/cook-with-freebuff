// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePlayBilling } from './usePlayBilling';

vi.mock('@/lib/firebase/app-check', () => ({
  appCheckHeaders: vi.fn(async () => ({ 'x-firebase-appcheck': 'mock-ac-token' })),
  appCheckLimitedUseHeaders: vi.fn(async () => ({ 'x-firebase-appcheck': 'mock-ac-limited' })),
}));

describe('usePlayBilling', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('initializes with default free tier and idle state', () => {
    const { result } = renderHook(() => usePlayBilling({ autoFetch: false }));

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
    expect(result.current.entitlement).toBeNull();
    expect(result.current.isPlayBillingAvailable).toBe(false);
  });

  it('fetches entitlements on mount when getToken is provided', async () => {
    const mockEntitlement = {
      userId: 'user-1',
      tier: 'pro' as const,
      status: 'active' as const,
      usage: {
        voiceSecondsUsed: 10,
        recipesGeneratedCount: 1,
        visionScansCount: 0,
        cycleStartMs: 12345,
      },
      updatedAtMs: 12345,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: mockEntitlement }),
    });

    const { result } = renderHook(() =>
      usePlayBilling({
        getToken: () => 'mock-id-token',
        autoFetch: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.isPro).toBe(true);
    });

    expect(result.current.tier).toBe('pro');
    expect(result.current.entitlement).toEqual(mockEntitlement);
  });

  it('detects digital goods service when present on window', async () => {
    const mockService = {
      getDetails: vi.fn(),
      listPurchases: vi.fn(),
    };
    (window as unknown as { getDigitalGoodsService: unknown }).getDigitalGoodsService = vi
      .fn()
      .mockResolvedValue(mockService);

    const { result } = renderHook(() => usePlayBilling({ autoFetch: false }));

    await waitFor(() => {
      expect(result.current.isPlayBillingAvailable).toBe(true);
    });

    delete (window as unknown as { getDigitalGoodsService?: unknown }).getDigitalGoodsService;
  });


  it('fails gracefully when purchaseSubscription is called without Digital Goods API', async () => {
    const { result } = renderHook(() =>
      usePlayBilling({
        getToken: () => 'mock-token',
        autoFetch: false,
      }),
    );

    let purchaseResult: { success: boolean; error?: string } | undefined;
    await act(async () => {
      purchaseResult = await result.current.purchaseSubscription();
    });

    expect(purchaseResult?.success).toBe(false);
    expect(purchaseResult?.error).toContain('Android App');
  });
});
