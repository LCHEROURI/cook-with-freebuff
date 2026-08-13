// ============================================================================
// lib/server/timer-rebase.test.ts — lock the all-or-nothing rebase contract.
//
// Codex P1 (PR #27 review): a rebase that fails midway must leave the timer
// store untouched — a partial rebase would leave inconsistent countdowns AND
// poison the retry (a retry would shift the already-shifted timers a second
// time). rebaseTimersAfterResume now computes every shift before writing and
// rolls back the writes that already landed when any write fails, so the
// caller can re-pause + retry resume and the rebase runs from the ORIGINAL
// endsAt exactly once.
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

/** A timer store that fails the Nth updateTimer call. */
class FlakyTimerStore extends InMemoryTimerStore {
  failOnUpdate: number | null = null;
  private updates = 0;

  override async updateTimer(id: string, partial: Partial<CookingTimer>): Promise<void> {
    this.updates += 1;
    if (this.failOnUpdate !== null && this.updates === this.failOnUpdate) {
      throw new Error('simulated write failure');
    }
    return super.updateTimer(id, partial);
  }
}

describe('rebaseTimersAfterResume — all-or-nothing', () => {
  it('shifts every timer forward by the paused duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const timers = new InMemoryTimerStore();
      await timers.createTimer(makeTimer('t1', 's1', NOW + 60_000));
      await timers.createTimer(makeTimer('t2', 's1', NOW + 120_000));

      // Paused at PAUSE_AT (= NOW−2m): both timers shift by exactly 2m.
      await rebaseTimersAfterResume(timers, 's1', PAUSE_AT);
      const [t1, t2] = await timers.listActiveTimers('s1');
      expect(t1.endsAt).toBe(NOW + 60_000 + 120_000);
      expect(t2.endsAt).toBe(NOW + 120_000 + 120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back the already-written timers when a later write fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const timers = new FlakyTimerStore();
      await timers.createTimer(makeTimer('t1', 's1', NOW + 60_000));
      await timers.createTimer(makeTimer('t2', 's1', NOW + 120_000));
      await timers.createTimer(makeTimer('t3', 's1', NOW + 180_000));

      // The SECOND write fails (t1 already shifted, t2/t3 untouched). The
      // store must end up exactly as it started — t1 rolled back.
      timers.failOnUpdate = 2;
      await expect(
        rebaseTimersAfterResume(timers, 's1', PAUSE_AT),
      ).rejects.toThrow('simulated write failure');

      const after = await timers.listActiveTimers('s1');
      const byId = new Map(after.map((t) => [t.id, t.endsAt]));
      expect(byId.get('t1')).toBe(NOW + 60_000); // rolled back
      expect(byId.get('t2')).toBe(NOW + 120_000); // never written
      expect(byId.get('t3')).toBe(NOW + 180_000); // never written
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retry after the rollback shifts from the ORIGINAL endsAt exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const timers = new FlakyTimerStore();
      await timers.createTimer(makeTimer('t1', 's1', NOW + 60_000));
      await timers.createTimer(makeTimer('t2', 's1', NOW + 120_000));

      // First attempt fails on the second write (t1 rolled back).
      timers.failOnUpdate = 2;
      await expect(
        rebaseTimersAfterResume(timers, 's1', PAUSE_AT),
      ).rejects.toThrow();

      // Retry (store healthy again): both timers shift by the full paused
      // duration — t1 must NOT be double-shifted by the failed attempt.
      timers.failOnUpdate = null;
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
