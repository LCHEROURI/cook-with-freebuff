// ============================================================================
// lib/server/timer-rebase.test.ts — lock the atomic rebase contract.
//
// Codex P1 (PR #30 review): the resume rebase must be all-or-nothing. A
// per-timer update loop could leave some timers shifted and others not, and a
// compensating rollback of the already-written ones could itself fail during
// a continuing store outage — silently presenting the rebase as safely
// reverted when it was not. rebaseTimersAfterResume now delegates the shift
// to the store's atomic rebaseActiveTimers (Firestore batch / in-memory loop)
// and performs NO compensating writes of its own. The unit tests lock the
// contract at this module's boundary: elapsed-time guard, no partial state on
// failure, and exactly one atomic store call.
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { InMemoryTimerStore } from './tools/registry';
import { rebaseTimersAfterResume } from './timer-rebase';
import type { CookingTimer } from '../domain/types';

// Fixed clock: PAUSE_AT is 2 minutes before NOW, so a rebase with pausedAt
// PAUSE_AT shifts every timer by exactly 120s.
const NOW = 1_000_000_000_000;
const PAUSE_AT = NOW - 120_000;

function makeTimer(id: string, sessionId: string, endsAt: number): CookingTimer {
  return {
    id,
    userId: 'user-1',
    sessionId,
    label: 'four-minute timer',
    durationSeconds: 240,
    startedAt: endsAt - 240_000,
    endsAt,
    status: 'RUNNING',
  };
}

/** A store that fails the atomic rebase once (the whole batch, not one write). */
class FlakyRebaseStore extends InMemoryTimerStore {
  failNextRebase = false;

  override async rebaseActiveTimers(sessionId: string, elapsedMs: number): Promise<void> {
    if (this.failNextRebase) {
      this.failNextRebase = false;
      throw new Error('simulated atomic rebase failure');
    }
    return super.rebaseActiveTimers(sessionId, elapsedMs);
  }
}

describe('rebaseTimersAfterResume — atomic', () => {
  it('shifts every active timer forward by the paused duration in one store call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const timers = new InMemoryTimerStore();
      await timers.createTimer(makeTimer('t1', 's1', NOW + 60_000));
      await timers.createTimer(makeTimer('t2', 's1', NOW + 120_000));

      await rebaseTimersAfterResume(timers, 's1', PAUSE_AT);
      const [t1, t2] = await timers.listActiveTimers('s1');
      expect(t1.endsAt).toBe(NOW + 60_000 + 120_000);
      expect(t2.endsAt).toBe(NOW + 120_000 + 120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates to the atomic store call — never per-timer compensating writes', async () => {
    // The whole point of the atomic contract: no rollback loop exists here to
    // fail. rebaseTimersAfterResume performs exactly ONE store operation.
    const timers = {
      rebaseCalls: 0,
      updateTimerCalls: 0,
      rebaseActiveTimers: vi.fn(async () => {
        timers.rebaseCalls += 1;
      }),
      updateTimer: vi.fn(async () => {
        timers.updateTimerCalls += 1;
      }),
    };
    await rebaseTimersAfterResume(timers as unknown as import('./tools/types').TimerStore, 's1', PAUSE_AT);
    expect(timers.rebaseCalls).toBe(1);
    expect(timers.updateTimerCalls).toBe(0);
  });

  it('an atomic failure leaves the store untouched (no partial state, no rollback needed)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const timers = new FlakyRebaseStore();
      await timers.createTimer(makeTimer('t1', 's1', NOW + 60_000));
      await timers.createTimer(makeTimer('t2', 's1', NOW + 120_000));

      // The whole rebase fails atomically — nothing was written.
      timers.failNextRebase = true;
      await expect(rebaseTimersAfterResume(timers, 's1', PAUSE_AT)).rejects.toThrow(
        'simulated atomic rebase failure',
      );
      const after = await timers.listActiveTimers('s1');
      const byId = new Map(after.map((t) => [t.id, t.endsAt]));
      expect(byId.get('t1')).toBe(NOW + 60_000); // untouched
      expect(byId.get('t2')).toBe(NOW + 120_000); // untouched

      // Retry: healthy store, shift runs from the ORIGINAL endsAt exactly
      // once — no double shift from a half-applied first attempt.
      await rebaseTimersAfterResume(timers, 's1', PAUSE_AT);
      const [t1, t2] = await timers.listActiveTimers('s1');
      expect(t1.endsAt).toBe(NOW + 60_000 + 120_000);
      expect(t2.endsAt).toBe(NOW + 120_000 + 120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op with no active timers or no elapsed time', async () => {
    const timers = new InMemoryTimerStore();
    await expect(rebaseTimersAfterResume(timers, 's-empty', 1_000)).resolves.toBeUndefined();

    await timers.createTimer(makeTimer('t1', 's1', Date.now() + 60_000));
    // pausedAt in the future → no elapsed time → untouched.
    await rebaseTimersAfterResume(timers, 's1', Date.now() + 10_000);
    const [t1] = await timers.listActiveTimers('s1');
    expect(t1.endsAt).toBeGreaterThan(Date.now() + 59_000);
  });
});
