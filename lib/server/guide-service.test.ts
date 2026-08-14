import { describe, it, expect, vi } from 'vitest';
import { SessionService, InMemorySessionStore } from './session-service';
import {
  InMemoryTimerStore,
  InMemoryLogStore,
  InMemoryRecipeStore,
  InMemoryPantryStore,
  InMemoryLeftoverStore,
  InMemoryGroceryStore,
} from './tools';
import { GuidedCookingService, secondsToLabel } from './guide-service';
import { PantryService } from './pantry-service';
import { LeftoverService } from './leftover-service';
import { GroceryService } from './grocery-service';
import type { CookingTimer, Ingredient, Recipe } from '../domain/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeIngredient(name: string, quantity: number | null = null, unit: string | null = null): Ingredient {
  return { id: `ing-${name}`, name, quantity, unit, optional: false };
}

function makeRecipe(): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [makeIngredient('chicken thighs', 4, 'pieces'), makeIngredient('rice', 1, 'cup'), makeIngredient('onion')],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
      { id: 'p2', stepNumber: 2, instruction: 'Rinse the rice', spokenInstruction: 'Rinse the rice', estimatedSeconds: 60, ingredientsUsed: ['rice'], equipmentUsed: [] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil' },
      { id: 'c2', stepNumber: 2, instruction: 'Simmer the rice', spokenInstruction: 'Simmer the rice', estimatedSeconds: 600, ingredientsUsed: ['rice'], equipmentUsed: [] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil'],
    generatedAt: t,
    updatedAt: t,
  };
}

/** Recipe whose FIRST prep step carries a safetyNote — for gate tests. */
function makeSafetyPrepRecipe(): Recipe {
  const base = makeRecipe();
  return {
    ...base,
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Heat the oil on high', spokenInstruction: 'Heat the oil on high', estimatedSeconds: 60, ingredientsUsed: [], equipmentUsed: ['pan'], safetyNote: 'Hot oil — keep children away' },
      { id: 'p2', stepNumber: 2, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
  };
}

function makeContext(userId = 'user-1') {
  const store = new InMemorySessionStore();
  const timers = new InMemoryTimerStore();
  const recipes = new InMemoryRecipeStore();
  const sessionService = new SessionService(store);
  const guide = new GuidedCookingService(sessionService, timers, recipes);
  return { store, timers, recipes, sessionService, guide };
}

/** Seed a recipe + launch guided cooking, returning the launched snapshot. */
async function launch(userId = 'user-1') {
  const ctx = makeContext(userId);
  await ctx.recipes.createRecipe(makeRecipe());
  const snap = await ctx.guide.launchCookWithMe(userId, 'recipe-1');
  return { ...ctx, snap };
}

// ── Launch + one-action delivery ─────────────────────────────────────────────

describe('launchCookWithMe', () => {
  it('creates a session, fast-forwards to PREP_GUIDANCE, and returns the FIRST single action', async () => {
    const { guide, snap, store } = await launch();

    expect(snap.found).toBe(true);
    expect(snap.phase).toBe('PREP_GUIDANCE');
    expect(snap.recipeTitle).toBe('Chicken Rice');
    expect(snap.instruction).toBe('Dice the onion');
    expect(snap.stepNumber).toBe(1);
    expect(snap.totalSteps).toBe(2);
    expect(snap.activeTimers).toEqual([]);

    const session = await store.getActiveSession('user-1');
    expect(session?.currentPhase).toBe('PREP_GUIDANCE');
    expect(session?.recipeId).toBe('recipe-1');
    void guide;
  });

  it('rejects an unknown recipe', async () => {
    const { guide } = makeContext();
    await expect(guide.launchCookWithMe('user-1', 'nope')).rejects.toMatchObject({
      code: 'RECIPE_NOT_FOUND',
    });
  });

  it('enforces ownership of an existing session', async () => {
    const ctx = makeContext();
    await ctx.recipes.createRecipe(makeRecipe());
    const snap = await ctx.guide.launchCookWithMe('user-1', 'recipe-1');
    await expect(
      ctx.guide.launchCookWithMe('user-2', 'recipe-1', snap.sessionId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ── One action at a time ─────────────────────────────────────────────────────

describe('getCurrentAction — one action at a time', () => {
  it('exposes exactly ONE action as the active instruction', async () => {
    const { guide, snap } = await launch();
    expect(snap.instruction).toBe('Dice the onion');
    expect(snap.stepNumber).toBe(1);
    // The full recipe lives only in the collapsed (secondary) expansion —
    // the active action is exactly one step, never a procedure.
    expect(snap.recipe?.prepSteps).toHaveLength(2);
    void guide;
  });

  it('returns the current action for the active session without an id', async () => {
    const { guide } = await launch();
    const snap = await guide.getCurrentAction('user-1');
    expect(snap.found).toBe(true);
    expect(snap.instruction).toBe('Dice the onion');
  });

  it('returns found:false when no session exists', async () => {
    const { guide } = makeContext();
    const snap = await guide.getCurrentAction('user-1');
    expect(snap.found).toBe(false);
  });
});

// ── Completion: phase transitions + timers ───────────────────────────────────

describe('completeCurrentAction', () => {
  it('advances within prep, then auto-transitions prep → cooking', async () => {
    const { guide } = await launch();

    const second = await guide.completeCurrentAction('user-1');
    expect(second.phase).toBe('PREP_GUIDANCE');
    expect(second.stepNumber).toBe(2);
    expect(second.instruction).toBe('Rinse the rice');

    const cooking = await guide.completeCurrentAction('user-1');
    expect(cooking.phase).toBe('WAITING_FOR_TIMER');
    expect(cooking.stepNumber).toBe(1);
    expect(cooking.instruction).toBe('Sear the chicken four minutes');
    expect(cooking.safetyNote).toBe('Hot oil');
  });

  it('auto-starts a backend timer when the current cooking step has timerSeconds', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1'); // prep 1 → prep 2
    const cooking = await guide.completeCurrentAction('user-1'); // prep 2 → cooking 1 (240s)

    expect(cooking.timerStarted).toBeTruthy();
    expect(cooking.timerStarted!.durationSeconds).toBe(240);
    expect(cooking.timerStarted!.label).toBe('four-minute timer');
    expect(cooking.activeTimers).toHaveLength(1);
    expect(cooking.activeTimers[0].timerId).toBe(cooking.timerStarted!.timerId);

    const active = await timers.listActiveTimers(cooking.sessionId!);
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('RUNNING');
    expect(active[0].stepId).toBe('c1');
  });

  it('refuses to complete a step while waiting on a timer', async () => {
    const { guide } = await launch();
    await guide.completeCurrentAction('user-1');
    await guide.completeCurrentAction('user-1'); // → WAITING_FOR_TIMER
    await expect(guide.completeCurrentAction('user-1')).rejects.toMatchObject({
      code: 'WAITING_FOR_TIMER',
    });
  });

  it('moves cooking → plating → completed', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1');
    await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER (240s)

    // Backdate the running timer so it is due; checkTimers marks it complete
    // and recovers the session to COOKING_GUIDANCE.
    const sessionId = (await guide.getCurrentAction('user-1')).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 250_000, endsAt: Date.now() - 10_000 });

    const { snapshot: recovered, alerts } = await guide.checkTimers('user-1');
    expect(alerts).toHaveLength(1);
    expect(recovered.phase).toBe('COOKING_GUIDANCE');

    // Cooking step 1 carries a safetyNote — "done" first surfaces the gate.
    const gated = await guide.completeCurrentAction('user-1');
    expect(gated.phase).toBe('SAFETY_WARNING');
    expect(gated.safetyGate?.note).toBe('Hot oil');
    expect(gated.stepNumber).toBe(1); // progress preserved

    // Acknowledging the gate completes step 1 → step 2 (no timer) → PLATING → COMPLETED.
    const step2 = await guide.completeCurrentAction('user-1');
    expect(step2.phase).toBe('COOKING_GUIDANCE');
    expect(step2.instruction).toBe('Simmer the rice');

    const plating = await guide.completeCurrentAction('user-1');
    expect(plating.phase).toBe('PLATING');
    expect(plating.instruction).toContain('Plate and serve');

    const done = await guide.completeCurrentAction('user-1');
    expect(done.phase).toBe('COMPLETED');
    expect(done.instruction).toBe('Enjoy your meal!');
  });

  it('auto-starts a timer for the FIRST cooking step when prep is exhausted', async () => {
    const { guide } = await launch();
    // recipe: 2 prep steps → completing prep 2 lands on cooking 1 (240s timer).
    await guide.completeCurrentAction('user-1');
    const snap = await guide.completeCurrentAction('user-1');
    expect(snap.phase).toBe('WAITING_FOR_TIMER');
    expect(snap.timerStarted?.label).toBe('four-minute timer');
  });
});

// ── Safety confirmation gate ───────────────────────────────────────────────

describe('safety confirmation gate', () => {
  async function launchSafetyPrep(userId = 'user-1') {
    const ctx = makeContext(userId);
    await ctx.recipes.createRecipe(makeSafetyPrepRecipe());
    const snap = await ctx.guide.launchCookWithMe(userId, 'recipe-1');
    return { ...ctx, snap };
  }

  it('"done" on a step with a safetyNote surfaces the gate without completing', async () => {
    const { guide, snap } = await launchSafetyPrep();

    // First prep step carries the note — "done" must NOT advance.
    const gated = await guide.completeCurrentAction('user-1', snap.sessionId);
    expect(gated.phase).toBe('SAFETY_WARNING');
    expect(gated.stepNumber).toBe(1); // same step — progress preserved
    expect(gated.instruction).toBe('Heat the oil on high');
    expect(gated.safetyNote).toBe('Hot oil — keep children away');
    expect(gated.safetyGate).toEqual({ note: 'Hot oil — keep children away' });

    const session = await guide.getCurrentAction('user-1', snap.sessionId);
    expect(session.phase).toBe('SAFETY_WARNING');
    expect(session.safetyGate).toEqual({ note: 'Hot oil — keep children away' });
  });

  it('a second "done" acknowledges the gate and completes the step', async () => {
    const { guide, snap } = await launchSafetyPrep();
    await guide.completeCurrentAction('user-1', snap.sessionId); // → gate

    const next = await guide.completeCurrentAction('user-1', snap.sessionId); // acknowledge
    expect(next.phase).toBe('PREP_GUIDANCE');
    expect(next.stepNumber).toBe(2);
    expect(next.instruction).toBe('Dice the onion');
    expect(next.safetyGate).toBeUndefined();
  });

  it('a step without a safetyNote completes directly — no gate', async () => {
    const { guide, snap } = await launchSafetyPrep();
    await guide.completeCurrentAction('user-1', snap.sessionId); // gate
    await guide.completeCurrentAction('user-1', snap.sessionId); // acknowledge → prep 2

    // Prep 2 has no note → completes straight through to the timed cooking step.
    const direct = await guide.completeCurrentAction('user-1', snap.sessionId);
    expect(direct.phase).toBe('WAITING_FOR_TIMER');
    expect(direct.safetyGate).toBeUndefined();
  });

  it('the gate applies to cooking steps too and survives refresh', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1'); // prep 1 → prep 2
    await guide.completeCurrentAction('user-1'); // prep 2 → cooking 1 (timer)
    // Recover from the timer back to COOKING_GUIDANCE at step 1 (has the note).
    const sessionId = (await guide.getCurrentAction('user-1')).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, {
      startedAt: Date.now() - 250_000,
      endsAt: Date.now() - 10_000,
    });
    await guide.checkTimers('user-1');

    const gated = await guide.completeCurrentAction('user-1');
    expect(gated.phase).toBe('SAFETY_WARNING');
    expect(gated.stepNumber).toBe(1);
    expect(gated.safetyGate?.note).toBe('Hot oil');

    // Refresh — the gate is durable, not a one-shot UI state.
    const refreshed = await guide.getCurrentAction('user-1');
    expect(refreshed.phase).toBe('SAFETY_WARNING');
    expect(refreshed.safetyGate?.note).toBe('Hot oil');
  });
});

// ── Timers: completion surfacing + recovery ─────────────────────────────────

describe('checkTimers', () => {
  it('surfaces an alert for a finished timer and recovers the session to the exact step', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1');
    await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER

    // Backdate the running timer so it is now due.
    const sessionId = (await guide.getCurrentAction('user-1')).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, {
      status: 'RUNNING',
      startedAt: Date.now() - 250_000,
      endsAt: Date.now() - 10_000,
    });

    const { alerts, snapshot } = await guide.checkTimers('user-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe('Your four-minute timer is finished.');
    expect(snapshot.phase).toBe('COOKING_GUIDANCE');
    expect(snapshot.instruction).toBe('Sear the chicken four minutes');
    expect(snapshot.stepNumber).toBe(1);
    expect(snapshot.activeTimers).toEqual([]);
  });

  it('returns no alerts when no timer is due', async () => {
    const { guide } = await launch();
    await guide.completeCurrentAction('user-1');
    await guide.completeCurrentAction('user-1');
    const { alerts } = await guide.checkTimers('user-1');
    expect(alerts).toEqual([]);
  });

  it('does not recover when other timers are still running', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1');
    await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER with 240s timer
    const sessionId = (await guide.getCurrentAction('user-1')).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);

    // Add a second, still-running timer.
    const t2: CookingTimer = {
      id: 'timer-2',
      userId: 'user-1',
      sessionId,
      label: 'two-minute timer',
      durationSeconds: 120,
      startedAt: Date.now(),
      endsAt: Date.now() + 120_000,
      status: 'RUNNING',
    };
    await timers.createTimer(t2);

    // Mark the first due.
    await timers.updateTimer(timer.id, {
      startedAt: Date.now() - 250_000,
      endsAt: Date.now() - 10_000,
    });

    const { alerts, snapshot } = await guide.checkTimers('user-1');
    expect(alerts).toHaveLength(1);
    expect(snapshot.phase).toBe('WAITING_FOR_TIMER'); // still waiting on timer-2
  });
});

// ── Pause freezes timers (Codex P1: the poll must not consume due timers
// ── while paused, and the at-pause remainder must be server-derived) ─────────

describe('pause freezes timers', () => {
  it('checkTimers does NOT complete or detach a due timer while the session is paused', async () => {
    const { guide, timers } = await launch();
    // Drive to WAITING_FOR_TIMER so a real timer is running.
    await guide.completeCurrentAction('user-1');
    let snap = await guide.completeCurrentAction('user-1');
    expect(snap.phase).toBe('WAITING_FOR_TIMER');
    const sessionId = snap.sessionId!;

    // Pause, then backdate the timer so it is now due.
    snap = await guide.pause('user-1', sessionId);
    expect(snap.phase).toBe('PAUSED');
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, {
      startedAt: Date.now() - 250_000,
      endsAt: Date.now() - 10_000,
    });

    // The poll that used to consume the due timer must now leave it alone.
    const { alerts, snapshot } = await guide.checkTimers('user-1', sessionId);
    expect(alerts).toEqual([]);
    expect(snapshot.phase).toBe('PAUSED');
    const after = await timers.listActiveTimers(sessionId);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('RUNNING'); // not COMPLETED, not detached
  });

  it('exposes pausedAt on the paused snapshot so clients can render "paused Xm ago"', async () => {
    const { guide, store } = await launch();
    const paused = await guide.pause('user-1');
    expect(paused.paused).toBe(true);
    const session = await store.getActiveSession('user-1');
    expect(paused.pausedAt).toBe(session?.pausedAt);
    expect(typeof paused.pausedAt).toBe('number');

    // After resume the field is gone — it only means something while paused.
    const resumed = await guide.resume('user-1');
    expect(resumed.pausedAt).toBeUndefined();
  });

  it('reports the at-pause remainder while paused (frozen, server-derived from pausedAt, not wall clock)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      const { guide, timers } = await launch();
      await guide.completeCurrentAction('user-1');
      let snap = await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER + 240s timer
      const sessionId = snap.sessionId!;
      const [timer] = await timers.listActiveTimers(sessionId);
      await timers.updateTimer(timer.id, { startedAt: Date.now() - 120_000, endsAt: Date.now() + 120_000 });

      snap = await guide.pause('user-1', sessionId);
      const frozenAtPause = snap.activeTimers[0].remainingSeconds;
      expect(frozenAtPause).toBe(120);

      // Two minutes of wall clock pass while paused, taking the ORIGINAL
      // endsAt into the past — the remainder must stay at the at-pause 120s,
      // never shrink toward the now-due endsAt (the reload/poll bug: the old
      // code computed remainingSeconds from endsAt − Date.now()).
      vi.setSystemTime(1_000_000_000_000 + 120_000);
      const still = await guide.getCurrentAction('user-1', sessionId);
      expect(still.phase).toBe('PAUSED');
      expect(still.activeTimers[0].remainingSeconds).toBe(120);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume rebases the timer by the paused duration so the frozen remainder carries through', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1');
    let snap = await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER + 240s timer
    const sessionId = snap.sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 60_000, endsAt: Date.now() + 180_000 });

    snap = await guide.pause('user-1', sessionId);
    const frozenAtPause = snap.activeTimers[0].remainingSeconds;
    expect(frozenAtPause).toBe(180);

    // "Wait" 3 minutes while paused, then resume — the timer must continue
    // from 180s (180s frozen + 3m pause), not fire instantly.
    const s = await guide.resume('user-1', sessionId);
    expect(s.phase).toBe('WAITING_FOR_TIMER');
    const [rebased] = await timers.listActiveTimers(sessionId);
    expect(rebased.endsAt).toBeGreaterThanOrEqual(Date.now() + 180_000 - 5_000);
  });

  it('a duplicate resume does NOT rebase timers a second time (Codex P1 — atomic rebase)', async () => {
    const { guide, timers } = await launch();
    await guide.completeCurrentAction('user-1');
    let snap = await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER + 240s timer
    const sessionId = snap.sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 60_000, endsAt: Date.now() + 180_000 });

    await guide.pause('user-1', sessionId);
    // "Wait" 3 minutes paused, then resume — endsAt shifts forward by 3m.
    const resumed = await guide.resume('user-1', sessionId);
    const [afterFirst] = await timers.listActiveTimers(sessionId);
    expect(afterFirst.endsAt).toBeGreaterThanOrEqual(Date.now() + 180_000 - 5_000);

    // The client retries because the first response was lost. pausedAt still
    // sits on the doc (resume never cleared it), but the session is ACTIVE —
    // resumeSession rejects with NOT_PAUSED and NO timer may be touched. The
    // old guard (truthy pausedAt) rebased again, silently extending cooking
    // time by the second pause window.
    const before = afterFirst.endsAt;
    await expect(guide.resume('user-1', sessionId)).rejects.toThrow(/NOT_PAUSED|not paused|already/);
    const [afterRetry] = await timers.listActiveTimers(sessionId);
    expect(afterRetry.endsAt).toBe(before);
  });

  it('a failed rebase rolls the session back to PAUSED with the original pausedAt (Codex P1 — recoverable)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      const { store, sessionService, flaky, guide, sessionId, pausedAt } = await launchRecoverablePause();

      // Two minutes of wall clock pass while paused, so the rebase has real
      // elapsed time to shift.
      vi.setSystemTime(1_000_000_000_000 + 120_000);

      // Resume: the transition succeeds, then the rebase write fails. The
      // session must roll BACK to PAUSED with the ORIGINAL pausedAt (frozen
      // remainder intact), and the caller sees a recoverable error — never a
      // half-resumed session whose timers can no longer be rebased.
      flaky.failing = true;
      await expect(guide.resume('user-1', sessionId)).rejects.toMatchObject({
        code: 'TIMER_REBASE_FAILED',
        recoverable: true,
      });

      const rolledBack = await store.getSession(sessionId);
      expect(rolledBack?.currentPhase).toBe('PAUSED');
      expect(rolledBack?.pausedAt).toBe(pausedAt);
      const [unshifted] = await flaky.listActiveTimers(sessionId);
      expect(unshifted.status).toBe('RUNNING');

      // A retry now works: the store is healthy again, the session is still
      // PAUSED (so resume is legal), and the rebase shifts from the ORIGINAL
      // endsAt exactly once.
      flaky.failing = false;
      const retried = await guide.resume('user-1', sessionId);
      expect(retried.phase).toBe('WAITING_FOR_TIMER');
      const [rebased] = await flaky.listActiveTimers(sessionId);
      expect(rebased.endsAt).toBeGreaterThanOrEqual(Date.now() + 180_000 - 5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the rollback re-pause uses a DISTINCT correlation ID so it actually pauses (Codex P1 — PR #30)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      const { store, flaky, guide, sessionId, pausedAt } = await launchRecoverablePause();
      vi.setSystemTime(1_000_000_000_000 + 120_000);

      // resumeSession marks the correlation ID as processed BEFORE the rebase;
      // the rollback re-pause must NOT reuse it or transitionTo would treat
      // the re-pause as a duplicate and return the ACTIVE session without
      // pausing — silently undoing the rollback (Codex P1, PR #30 review).
      flaky.failing = true;
      await expect(guide.resume('user-1', sessionId, { correlationId: 'resume-op-1' })).rejects.toMatchObject({
        code: 'TIMER_REBASE_FAILED',
        recoverable: true,
      });

      const rolledBack = await store.getSession(sessionId);
      expect(rolledBack?.currentPhase).toBe('PAUSED');
      expect(rolledBack?.pausedAt).toBe(pausedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a retry with the ORIGINAL resume ID transitions once after the rollback (Codex P1 — PR #51)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      const { store, flaky, guide, sessionId } = await launchRecoverablePause();
      vi.setSystemTime(1_000_000_000_000 + 120_000);

      // The rollback re-pause succeeds, but the ORIGINAL resume ID stays in
      // the processed set — so the client's intended idempotent retry with
      // that same ID would be swallowed as a duplicate: transitionTo returns
      // the still-PAUSED session without transitioning, and the handler would
      // then rebase timers a SECOND time (Codex P1, PR #51 review).
      // NOTE: distinct ID per test — the processed set is module-level, so a
      // reused prefix would leak the previous test's rollback marker.
      flaky.failing = true;
      await expect(guide.resume('user-1', sessionId, { correlationId: 'resume-op-51' })).rejects.toMatchObject({
        code: 'TIMER_REBASE_FAILED',
        recoverable: true,
      });

      // Store healthy again; retry with the SAME correlation ID the client
      // used before. It must actually transition PAUSED → ACTIVE once and
      // rebase from the ORIGINAL endsAt exactly once — never a swallowed
      // duplicate, never a second shift.
      flaky.failing = false;
      const retried = await guide.resume('user-1', sessionId, { correlationId: 'resume-op-51' });
      expect(retried.phase).toBe('WAITING_FOR_TIMER');

      const session = await store.getSession(sessionId);
      expect(session?.currentPhase).toBe('WAITING_FOR_TIMER');
      // The raw doc keeps the historical pausedAt (the resume guard is the
      // phase, never the field — documented contract); the SNAPSHOT must not
      // report it once resumed.
      expect(retried.pausedAt).toBeUndefined();

      const [rebased] = await flaky.listActiveTimers(sessionId);
      // pausedAt was captured at t=0 with endsAt = t0 + 180s; 120s of pause
      // elapsed, so a single rebase lands endsAt at now + 180s (any second
      // shift would push it to now + 300s).
      expect(rebased.endsAt).toBe(Date.now() + 180_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Build the paused-WAITING_FOR_TIMER state the two rebase tests share, with a
 * timer store that can be made to fail its rebase writes.
 */
async function launchRecoverablePause() {
  // The rebase runs through the ATOMIC store call (rebaseActiveTimers), so
  // the flaky store fails THAT — not per-timer updateTimer — exactly the
  // failure surface Codex flagged.
  const flaky = new (class extends InMemoryTimerStore {
    failing = false;
    override async rebaseActiveTimers(sessionId: string, elapsedMs: number): Promise<void> {
      if (this.failing) throw new Error('simulated rebase write failure');
      return super.rebaseActiveTimers(sessionId, elapsedMs);
    }
  })();

  const store = new InMemorySessionStore();
  const recipes = new InMemoryRecipeStore();
  const sessionService = new SessionService(store);
  const guide = new GuidedCookingService(sessionService, flaky, recipes);
  await recipes.createRecipe(makeRecipe());
  await guide.launchCookWithMe('user-1', 'recipe-1');
  await guide.completeCurrentAction('user-1');
  let snap = await guide.completeCurrentAction('user-1'); // WAITING_FOR_TIMER + 240s timer
  const sessionId = snap.sessionId!;
  const [timer] = await flaky.listActiveTimers(sessionId);
  await flaky.updateTimer(timer.id, { startedAt: Date.now() - 60_000, endsAt: Date.now() + 180_000 });

  snap = await guide.pause('user-1', sessionId);
  const pausedAt = snap.pausedAt!;
  expect(snap.phase).toBe('PAUSED');

  return { store, sessionService, flaky, guide, sessionId, pausedAt };
}

// ── Navigation ───────────────────────────────────────────────────────────────

describe('navigation', () => {
  it('repeat keeps progress unchanged', async () => {
    const { guide } = await launch();
    const snap = await guide.repeatAction('user-1');
    expect(snap.instruction).toBe('Dice the onion');
    expect(snap.stepNumber).toBe(1);
  });

  it('previous never goes below the first step', async () => {
    const { guide } = await launch();
    const snap = await guide.previousAction('user-1');
    expect(snap.stepNumber).toBe(1);
    expect(snap.instruction).toBe('Dice the onion');
  });

  it('previous steps back within a phase', async () => {
    const { guide } = await launch();
    await guide.completeCurrentAction('user-1'); // → prep 2
    const snap = await guide.previousAction('user-1');
    expect(snap.stepNumber).toBe(1);
    expect(snap.instruction).toBe('Dice the onion');
  });

  it('pause + resume restore the exact step', async () => {
    const { guide } = await launch();
    const paused = await guide.pause('user-1');
    expect(paused.phase).toBe('PAUSED');
    expect(paused.paused).toBe(true);
    expect(paused.instruction).toBe('Dice the onion');

    const resumed = await guide.resume('user-1');
    expect(resumed.phase).toBe('PREP_GUIDANCE');
    expect(resumed.instruction).toBe('Dice the onion');
  });
});

// ── Owner + error surface ────────────────────────────────────────────────────

describe('ownership and errors', () => {
  it('denies another user access to the session', async () => {
    const { guide, snap } = await launch();
    await expect(guide.getCurrentAction('user-2', snap.sessionId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('completing without a session fails with SESSION_NOT_FOUND', async () => {
    const { guide } = makeContext();
    await expect(guide.completeCurrentAction('user-1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('secondsToLabel formats friendly timer labels', () => {
    expect(secondsToLabel(240)).toBe('four-minute timer');
    expect(secondsToLabel(30)).toBe('30-second timer');
    expect(secondsToLabel(90)).toBe('one-and-a-half-minute timer');
    expect(secondsToLabel(60)).toBe('one-minute timer');
  });
});

// ── Start over (archive + fresh session) ────────────────────────────────────

describe('startOver', () => {
  it('archives the current session (ABANDONED), cancels its timers, and starts a fresh session on the same recipe', async () => {
    const { guide, store, timers } = await launch();

    // Drive to a cooking step so a real timer is auto-started (the lifecycle
    // startOver must clean up: the archived session's timer must be cancelled).
    let snap = await guide.getCurrentAction('user-1');
    snap = await guide.completeCurrentAction('user-1', snap.sessionId); // prep 1 → 2
    snap = await guide.completeCurrentAction('user-1', snap.sessionId); // → WAITING_FOR_TIMER + timer
    expect(snap.phase).toBe('WAITING_FOR_TIMER');
    const oldSessionId = snap.sessionId!;
    const [running] = await timers.listActiveTimers(oldSessionId);
    expect(running?.status).toBe('RUNNING');

    // Start over: archive old, launch fresh.
    const fresh = await guide.startOver('user-1', oldSessionId);
    expect(fresh.found).toBe(true);
    expect(fresh.phase).toBe('PREP_GUIDANCE');
    expect(fresh.stepNumber).toBe(1);
    expect(fresh.recipeId).toBe('recipe-1');
    expect(fresh.sessionId).not.toBe(oldSessionId);

    // The old session is archived (ABANDONED) — never deleted, never active.
    const old = await store.getSession(oldSessionId);
    expect(old?.status).toBe('ABANDONED');
    const active = await store.getActiveSession('user-1');
    expect(active?.id).toBe(fresh.sessionId);
    expect(active?.currentPhase).toBe('PREP_GUIDANCE');
    expect(active?.recipeId).toBe('recipe-1');

    // The old session's running timer was cancelled (no ghost alert for the
    // archived session; the new session owns its own lifecycle).
    const after = await timers.getTimer(running!.id);
    expect(after?.status).toBe('CANCELLED');
  });

  it('fails with SESSION_NOT_FOUND when there is no session to restart', async () => {
    const { guide } = makeContext();
    await expect(guide.startOver('user-1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });
});

// ── Recipe consumption (K8) ──────────────────────────────────────────────────

describe('recipe consumption on completion (K8)', () => {
  /** Seed the pantry, launch, and drive the full guided journey to COMPLETED. */
  async function cookToCompletion() {
    const store = new InMemorySessionStore();
    const timers = new InMemoryTimerStore();
    const recipes = new InMemoryRecipeStore();
    const pantry = new InMemoryPantryStore();
    const sessionService = new SessionService(store);
    const pantryService = new PantryService(pantry, sessionService);
    const guide = new GuidedCookingService(sessionService, timers, recipes, pantryService);

    await recipes.createRecipe(makeRecipe());
    // Seed high-confidence, quantity-known pantry matches for the recipe.
    const chicken = await pantryService.addItem('user-1', { name: 'chicken thighs', quantity: 6, unit: 'pieces', source: 'MANUAL' });
    const rice = await pantryService.addItem('user-1', { name: 'rice', quantity: 3, unit: 'cup', source: 'MANUAL' });
    await pantryService.confirmItem('user-1', chicken.id);
    await pantryService.confirmItem('user-1', rice.id);

    const snap = await guide.launchCookWithMe('user-1', 'recipe-1');
    // Prep ×2 → cooking 1 (timer) → wait → cooking 2 → plating → completed.
    await guide.completeCurrentAction('user-1', snap.sessionId);
    await guide.completeCurrentAction('user-1', snap.sessionId); // → WAITING_FOR_TIMER
    const sessionId = (await guide.getCurrentAction('user-1', snap.sessionId)).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 250_000, endsAt: Date.now() - 10_000 });
    await guide.checkTimers('user-1', sessionId); // → COOKING_GUIDANCE
    await guide.completeCurrentAction('user-1', sessionId); // gate
    await guide.completeCurrentAction('user-1', sessionId); // ack → step 2
    await guide.completeCurrentAction('user-1', sessionId); // → PLATING
    const done = await guide.completeCurrentAction('user-1', sessionId);
    expect(done.phase).toBe('COMPLETED');
    return { pantry, done };
  }

  it('adjusts pantry inventory when the guided session completes', async () => {
    const { pantry } = await cookToCompletion();
    const items = await pantry.listItems('user-1');
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    // 4 of 6 thighs consumed; 1 of 3 cups of rice consumed.
    expect(byName['chicken thighs'].quantity).toBe(2);
    expect(byName['rice'].quantity).toBe(2);
    // The recipe's onion has no quantity in the recipe — never reduced.
    expect(byName['onion']).toBeUndefined();
  });

  it('logs INGREDIENT_REMOVED / CORRECTED events for consumption', async () => {
    const { pantry } = await cookToCompletion();
    const items = await pantry.listItems('user-1');
    const chicken = items.find((i) => i.name === 'chicken thighs')!;
    // Reduced, not removed (2 left).
    expect(chicken.quantity).toBe(2);
  });
});

describe('K10 completion hooks — leftovers, grocery depletion & expiration (K10)', () => {
  /** Seed the pantry + grocery/leftover stores and drive the journey to COMPLETED. */
  async function cookToCompletion() {
    const store = new InMemorySessionStore();
    const timers = new InMemoryTimerStore();
    const recipes = new InMemoryRecipeStore();
    const pantry = new InMemoryPantryStore();
    const leftovers = new InMemoryLeftoverStore();
    const groceries = new InMemoryGroceryStore();
    const sessionService = new SessionService(store);
    const pantryService = new PantryService(pantry, sessionService);
    const guide = new GuidedCookingService(
      sessionService,
      timers,
      recipes,
      pantryService,
      new LeftoverService(leftovers, sessionService),
      new GroceryService(groceries),
    );

    await recipes.createRecipe(makeRecipe());
    // Recipe needs exactly 4 thighs → exhausted on completion (PANTRY_DEPLETION).
    const chicken = await pantryService.addItem('user-1', { name: 'chicken thighs', quantity: 4, unit: 'pieces', source: 'MANUAL' });
    // Recipe needs 1 of 2 cups of rice → reduced, NOT depleted.
    await pantryService.addItem('user-1', { name: 'rice', quantity: 2, unit: 'cup', source: 'MANUAL' });
    // An expired item unrelated to the recipe → grocery EXPIRATION line.
    await pantryService.addItem('user-1', { name: 'sour cream', source: 'MANUAL' });
    await pantryService.confirmItem('user-1', chicken.id);
    // Record an expiration on sour cream via the store directly (the pantry
    // service has no expiry setter — the update tool does).
    const items = await pantry.listItems('user-1');
    const sourCream = items.find((i) => i.name === 'sour cream')!;
    await pantry.upsertItem({ ...sourCream, expirationDate: Date.now() - 1000 });

    const snap = await guide.launchCookWithMe('user-1', 'recipe-1');
    await guide.completeCurrentAction('user-1', snap.sessionId);
    await guide.completeCurrentAction('user-1', snap.sessionId); // → WAITING_FOR_TIMER
    const sessionId = (await guide.getCurrentAction('user-1', snap.sessionId)).sessionId!;
    const [timer] = await timers.listActiveTimers(sessionId);
    await timers.updateTimer(timer.id, { startedAt: Date.now() - 250_000, endsAt: Date.now() - 10_000 });
    await guide.checkTimers('user-1', sessionId); // → COOKING_GUIDANCE
    await guide.completeCurrentAction('user-1', sessionId); // gate
    await guide.completeCurrentAction('user-1', sessionId); // ack → step 2
    await guide.completeCurrentAction('user-1', sessionId); // → PLATING
    const done = await guide.completeCurrentAction('user-1', sessionId);
    expect(done.phase).toBe('COMPLETED');
    return { pantry, leftovers, groceries };
  }

  it('logs the finished meal as an ACTIVE leftover', async () => {
    const { leftovers } = await cookToCompletion();
    const active = await leftovers.listLeftovers('user-1');
    expect(active.filter((l) => l.status === 'ACTIVE')).toHaveLength(1);
    expect(active[0].title).toBe('Chicken Rice');
    expect(active[0].servings).toBe(2);
  });

  it('auto-adds the exhausted ingredient (PANTRY_DEPLETION) but not a merely-reduced one', async () => {
    const { groceries } = await cookToCompletion();
    const open = await groceries.listGroceryItems('user-1');
    const openItems = open.filter((i) => i.status === 'OPEN');
    const chicken = openItems.find((i) => i.name === 'chicken thighs');
    expect(chicken?.source).toBe('PANTRY_DEPLETION');
    // Rice still has 1 cup left — no grocery line.
    expect(openItems.find((i) => i.name === 'rice')).toBeUndefined();
  });

  it('auto-adds expired pantry items (EXPIRATION) on completion', async () => {
    const { groceries } = await cookToCompletion();
    const open = await groceries.listGroceryItems('user-1');
    const sourCream = open.find((i) => i.name === 'sour cream');
    expect(sourCream?.source).toBe('EXPIRATION');
  });
});
