// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCookingSession } from './useCookingSession';

function mockFetch(responses: Array<{ success: boolean; data?: unknown; error?: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => ({
    ok: true,
    json: async () => responses[callIndex++ % responses.length],
  }));
}

describe('useCookingSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves completionSummary when timer poll returns COMPLETED without it', async () => {
    const completionSnapshot = {
      found: true,
      sessionId: 's1',
      phase: 'COMPLETED',
      recipeTitle: 'Chicken Rice',
      activeTimers: [],
      availableIngredients: [],
      completionSummary: {
        pantry: { adjusted: [{ name: 'chicken thighs', action: 'removed' as const, before: 4 }] },
        leftover: { id: 'l1', title: 'Chicken Rice', servings: 2 },
        grocery: { items: ['chicken thighs'] },
      },
    };

    const timerSnapshot = {
      found: true,
      sessionId: 's1',
      phase: 'COMPLETED',
      recipeTitle: 'Chicken Rice',
      activeTimers: [],
      availableIngredients: [],
      // No completionSummary — this is what a subsequent timer poll returns.
    };

    // First call: status (initial load), second call: done (completion), third call: timers (poll)
    const fetchMock = mockFetch([
      { success: true, data: completionSnapshot },   // status → initial
      { success: true, data: completionSnapshot },   // done → has summary
      { success: true, data: { alerts: [], snapshot: timerSnapshot } },  // timers → no summary
    ]);

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { setInterval: vi.fn((_fn: unknown, _ms: unknown) => 42), clearInterval: vi.fn() });

    const { result } = renderHook(() => useCookingSession({ pollMs: 999_999 }));

    // Wait for initial load
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    // After timer poll, completionSummary should be preserved
    expect(result.current.snapshot?.completionSummary).toBeDefined();
    expect(result.current.snapshot?.completionSummary?.pantry?.adjusted[0].name).toBe('chicken thighs');
  });
});
