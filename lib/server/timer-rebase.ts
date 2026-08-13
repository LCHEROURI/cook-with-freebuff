// ─────────────────────────────────────────────────────────────────────────────
// lib/server/timer-rebase.ts — resume-side timer freeze honoring
//
// Pause genuinely freezes a session's timers: while PAUSED the snapshot
// reports the at-pause remainder (derived from pausedAt), and resume shifts
// each active timer's endsAt forward by the paused duration so the countdown
// continues from where it froze. Without the shift, a timer that expired
// during the pause would fire instantly on resume — the frozen display would
// have lied about the time the cook still had.
//
// Used by every resume path (guide-service.resume for /api/cook and the
// resume_cooking_session tool), so the AI and the UI can never disagree about
// what resume means.
// ─────────────────────────────────────────────────────────────────────────────

import type { TimerStore } from './tools/types';

/**
 * Shift a session's active timers by the paused duration so the frozen
 * at-pause remainder carries through resume. No-op when pausedAt is missing
 * or the pause lasted no time.
 *
 * All-or-nothing (Codex P1): every shift is computed BEFORE any write, and if
 * a write fails midway the already-applied shifts are rolled back to their
 * original endsAt. A partial rebase would leave inconsistent countdowns AND
 * poison the retry — a retry would shift the already-shifted timers a second
 * time. With rollback, a failed rebase leaves the store untouched, so the
 * caller can re-pause + retry resume and the rebase runs from the ORIGINAL
 * endsAt exactly once.
 */
export async function rebaseTimersAfterResume(
  timerStore: TimerStore,
  sessionId: string,
  pausedAt: number,
): Promise<void> {
  const elapsedMs = Date.now() - pausedAt;
  if (elapsedMs <= 0) return;
  const running = await timerStore.listActiveTimers(sessionId);
  if (running.length === 0) return;

  const original = new Map(running.map((t) => [t.id, t.endsAt]));
  const applied: string[] = [];
  try {
    for (const timer of running) {
      await timerStore.updateTimer(timer.id, { endsAt: timer.endsAt + elapsedMs });
      applied.push(timer.id);
    }
  } catch (e) {
    // Best-effort rollback of the writes that already landed, so the store is
    // untouched when the caller retries (a rollback failure itself means the
    // store is broken — surface the original rebase error regardless).
    await Promise.all(
      applied.map((id) =>
        timerStore.updateTimer(id, { endsAt: original.get(id)! }).catch(() => undefined),
      ),
    );
    throw e;
  }
}
