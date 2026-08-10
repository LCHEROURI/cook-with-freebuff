// ─────────────────────────────────────────────────────────────────────────────
// Guided cooking service (K6 — "Cook With Me")
//
// Delivers exactly ONE manageable physical action at a time. Never reads a
// whole procedure. The recipe — persisted in the recipe store, never
// conversational memory — is the source of truth for step counts and phase
// boundaries:
//
//   PREP_GUIDANCE → COOKING_GUIDANCE → PLATING → COMPLETED
//
// Every prep step must be completed before cooking begins. When a cooking step
// carries `timerSeconds` the service auto-starts a backend-tracked timer and
// only reports it after backend success. Timer completion is surfaced as an
// explicit alert and recovers the session to the exact step.
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionService } from './session-service';
import type { TimerStore, RecipeStore } from './tools/types';
import type {
  CookingSession,
  CookingStep,
  CookingTimer,
  Ingredient,
  Recipe,
  SessionPhase,
} from '../domain/types';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface ActiveTimerInfo {
  timerId: string;
  label: string;
  durationSeconds: number;
  endsAt: number;
  remainingSeconds: number;
}

export interface TimerAlert {
  timerId: string;
  label: string;
  message: string;
}

export interface TimerStartedInfo {
  timerId: string;
  label: string;
  durationSeconds: number;
  endsAt: number;
}

/** The single action the cook should do right now. */
export interface GuideAction {
  found: boolean;
  sessionId?: string;
  phase: SessionPhase;
  status?: string;
  /** Recipe context for the header. */
  recipeId?: string;
  recipeTitle?: string;
  /** 1-based step number within the current phase. */
  stepNumber?: number;
  totalSteps?: number;
  /** The ONE instruction. Always spokenInstruction when available. */
  instruction?: string;
  stepId?: string;
  safetyNote?: string;
  /** Auto-started when the current cooking step carries timerSeconds. */
  timerStarted?: TimerStartedInfo;
  activeTimers: ActiveTimerInfo[];
  /** Set when a timer finished during this call (checkTimers / completion). */
  alert?: string;
  paused?: boolean;
}

/** Full state for the cooking UI (includes expandable recipe content). */
export interface GuideSnapshot extends GuideAction {
  availableIngredients: Ingredient[];
  recipe?: {
    id: string;
    title: string;
    servings: number;
    ingredients: Ingredient[];
    equipment: string[];
    prepSteps: { stepNumber: number; instruction: string }[];
    cookingSteps: { stepNumber: number; instruction: string; timerSeconds?: number }[];
    safetyNotes: string[];
  };
}

export class GuideError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'GuideError';
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export class GuidedCookingService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly timerStore: TimerStore,
    private readonly recipeStore?: RecipeStore,
  ) {}

  // ── Launch ────────────────────────────────────────────────────────────────

  /**
   * Begin guided cooking for a recipe.
   *
   * - Creates a session when none exists (pinned to the recipe).
   * - Fast-forwards a session through the collection phases to RECIPE_READY
   *   (the recipe is already validated — no regeneration happens).
   * - Transitions RECIPE_READY → PREP_GUIDANCE and returns the first action.
   */
  async launchCookWithMe(
    userId: string,
    recipeId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
    if (!this.recipeStore) {
      throw new GuideError('Recipe store is not available', 'RECIPE_STORE_UNAVAILABLE', false);
    }
    const recipe = await this.recipeStore.getRecipe(recipeId);
    if (!recipe) {
      throw new GuideError(`Recipe ${recipeId} not found`, 'RECIPE_NOT_FOUND', true);
    }

    let session: CookingSession | null = null;
    if (sessionId) {
      session = await this.sessionService.getSession(sessionId);
      if (!session) throw new GuideError('Session not found', 'SESSION_NOT_FOUND', true);
      if (session.userId !== userId) {
        throw new GuideError('Session belongs to another user', 'FORBIDDEN', false);
      }
    }

    if (!session) {
      session = await this.sessionService.createSession(userId, {
        recipeId,
        correlationId: options?.correlationId,
      });
    }

    // Attach the recipe id if the session does not carry one yet.
    if (!session.recipeId) {
      const updated = await this.sessionService.updateSessionMetadata(
        session.id,
        session.version,
        { recipeId },
        { correlationId: options?.correlationId },
      );
      session = updated;
    }

    session = await this.fastForwardToRecipeReady(session, options?.correlationId);

    // RECIPE_READY → PREP_GUIDANCE (the guided experience begins).
    if (session.currentPhase !== 'PREP_GUIDANCE') {
      session = await this.sessionService.transitionTo(
        session.id,
        session.version,
        'PREP_GUIDANCE',
        'USER_INPUT',
        { correlationId: options?.correlationId },
      );
    }

    return this.buildSnapshot(userId, session);
  }

  // ── One-action delivery ───────────────────────────────────────────────────

  /** The single current action — the only thing the cook needs to hear. */
  async getCurrentAction(userId: string, sessionId?: string): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) return this.emptySnapshot();
    return this.buildSnapshot(userId, session);
  }

  // ── Completion / navigation ───────────────────────────────────────────────

  /**
   * Complete the current action and return the NEXT single action.
   * - Exhausted prep steps → PREP_GUIDANCE → COOKING_GUIDANCE.
   * - Exhausted cooking steps → COOKING_GUIDANCE → PLATING → (next call) COMPLETED.
   * - A new step with timerSeconds auto-starts a backend timer (WAITING_FOR_TIMER).
   */
  async completeCurrentAction(
    userId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const recipe = await this.requireRecipe(session);

    switch (session.currentPhase) {
      case 'PREP_GUIDANCE': {
        const nextIndex = session.currentPrepStepIndex + 1;
        let updated = await this.sessionService.completeCurrentStep(session.id, session.version, {
          correlationId: options?.correlationId,
        });
        if (nextIndex >= recipe.prepSteps.length) {
          updated = await this.sessionService.transitionTo(
            updated.id,
            updated.version,
            'COOKING_GUIDANCE',
            'AGENT_TOOL',
            { correlationId: options?.correlationId },
          );
        }
        // The first cooking step may carry a timer — auto-start it.
        const afterTimer = await this.maybeAutoStart(updated, recipe, options);
        const snap = await this.buildSnapshot(userId, afterTimer.session, recipe);
        if (afterTimer.timerStarted) snap.timerStarted = afterTimer.timerStarted;
        return snap;
      }
      case 'COOKING_GUIDANCE': {
        const nextIndex = session.currentCookingStepIndex + 1;
        let updated = await this.sessionService.completeCurrentStep(session.id, session.version, {
          correlationId: options?.correlationId,
        });
        if (nextIndex >= recipe.cookingSteps.length) {
          updated = await this.sessionService.transitionTo(
            updated.id,
            updated.version,
            'PLATING',
            'AGENT_TOOL',
            { correlationId: options?.correlationId },
          );
          return this.buildSnapshot(userId, updated, recipe);
        }
        const afterTimer = await this.maybeAutoStart(updated, recipe, options);
        const snap = await this.buildSnapshot(userId, afterTimer.session, recipe);
        if (afterTimer.timerStarted) snap.timerStarted = afterTimer.timerStarted;
        return snap;
      }
      case 'PLATING': {
        const updated = await this.sessionService.transitionTo(
          session.id,
          session.version,
          'COMPLETED',
          'AGENT_TOOL',
          { correlationId: options?.correlationId },
        );
        return this.buildSnapshot(userId, updated, recipe);
      }
      case 'WAITING_FOR_TIMER':
        throw new GuideError('A timer is still running — wait for it to finish first', 'WAITING_FOR_TIMER', true);
      default:
        throw new GuideError(
          `Cannot complete a step in phase ${session.currentPhase}`,
          'INVALID_PHASE',
          true,
        );
    }
  }

  /** Repeat the current action — progress is never altered. */
  async repeatAction(userId: string, sessionId?: string, options?: { correlationId?: string }): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const updated = await this.sessionService.repeatCurrentStep(session.id, session.version, {
      correlationId: options?.correlationId,
    });
    return this.buildSnapshot(userId, updated);
  }

  /** Go back one action — never below the first step. */
  async previousAction(userId: string, sessionId?: string, options?: { correlationId?: string }): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const updated = await this.sessionService.previousStep(session.id, session.version, {
      correlationId: options?.correlationId,
    });
    return this.buildSnapshot(userId, updated);
  }

  async pause(userId: string, sessionId?: string, options?: { correlationId?: string }): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const updated = await this.sessionService.pauseSession(session.id, session.version, {
      correlationId: options?.correlationId,
    });
    return this.buildSnapshot(userId, updated);
  }

  async resume(userId: string, sessionId?: string, options?: { correlationId?: string }): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const updated = await this.sessionService.resumeSession(session.id, session.version, {
      correlationId: options?.correlationId,
    });
    return this.buildSnapshot(userId, updated);
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  /**
   * Surface finished timers and recover the session.
   * Marks due timers COMPLETED, detaches them, and when the session was
   * WAITING_FOR_TIMER with no timers left returns it to COOKING_GUIDANCE.
   * Returns the alert(s) + the current action.
   */
  async checkTimers(
    userId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<{ alerts: TimerAlert[]; snapshot: GuideSnapshot }> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) {
      return { alerts: [], snapshot: this.emptySnapshot() };
    }

    const running = await this.timerStore.listActiveTimers(session.id);
    const nowMs = Date.now();
    const due = running.filter((t) => t.endsAt <= nowMs);

    const alerts: TimerAlert[] = [];
    let updated = session;

    for (const timer of due) {
      await this.timerStore.updateTimer(timer.id, { status: 'COMPLETED', completedAt: nowMs });
      await this.sessionService.logSessionEvent(session.id, 'TIMER_COMPLETED', { timerId: timer.id }, {
        correlationId: options?.correlationId,
      });
      alerts.push({
        timerId: timer.id,
        label: timer.label,
        message: `Your ${timer.label} is finished.`,
      });
      updated = await this.sessionService.detachTimer(updated.id, updated.version, timer.id);
    }

    // Recover a session that was waiting on the finished timer(s).
    if (alerts.length > 0 && updated.currentPhase === 'WAITING_FOR_TIMER') {
      const remaining = await this.timerStore.listActiveTimers(updated.id);
      if (remaining.length === 0) {
        updated = await this.sessionService.transitionTo(
          updated.id,
          updated.version,
          'COOKING_GUIDANCE',
          'TIMER_COMPLETED',
          { correlationId: options?.correlationId },
        );
      }
    }

    return { alerts, snapshot: await this.buildSnapshot(userId, updated) };
  }

  // ── Snapshot builder ──────────────────────────────────────────────────────

  private async buildSnapshot(
    userId: string,
    session: CookingSession,
    cachedRecipe?: Recipe,
  ): Promise<GuideSnapshot> {
    const recipe = cachedRecipe ?? (session.recipeId ? await this.loadRecipe(session.recipeId) : null);

    const base: GuideAction = {
      found: true,
      sessionId: session.id,
      phase: session.currentPhase,
      status: session.status,
      recipeId: session.recipeId,
      recipeTitle: recipe?.title,
      activeTimers: await this.activeTimers(session),
      paused: session.currentPhase === 'PAUSED',
    };

    const action = this.currentAction(session, recipe);
    Object.assign(base, action);

    return {
      ...base,
      availableIngredients: session.availableIngredients,
      recipe: recipe
        ? {
            id: recipe.id,
            title: recipe.title,
            servings: recipe.servings,
            ingredients: recipe.ingredients,
            equipment: recipe.equipment,
            prepSteps: recipe.prepSteps.map((s) => ({ stepNumber: s.stepNumber, instruction: s.instruction })),
            cookingSteps: recipe.cookingSteps.map((s) => ({
              stepNumber: s.stepNumber,
              instruction: s.instruction,
              timerSeconds: s.timerSeconds,
            })),
            safetyNotes: recipe.safetyNotes,
          }
        : undefined,
    };
  }

  /**
   * The ONE action for the session's current phase. Only the current step's
   * content is exposed — never the whole procedure.
   */
  private currentAction(
    session: CookingSession,
    recipe: Recipe | null,
  ): Partial<GuideAction> {
    switch (session.currentPhase) {
      case 'PREP_GUIDANCE': {
        if (!recipe) return {};
        const step = recipe.prepSteps[session.currentPrepStepIndex];
        if (!step) return {};
        return {
          stepNumber: step.stepNumber,
          totalSteps: recipe.prepSteps.length,
          instruction: step.spokenInstruction || step.instruction,
          stepId: step.id,
        };
      }
      case 'COOKING_GUIDANCE': {
        if (!recipe) return {};
        const step = recipe.cookingSteps[session.currentCookingStepIndex];
        if (!step) return {};
        return {
          stepNumber: step.stepNumber,
          totalSteps: recipe.cookingSteps.length,
          instruction: step.spokenInstruction || step.instruction,
          stepId: step.id,
          safetyNote: step.safetyNote,
        };
      }
      case 'WAITING_FOR_TIMER': {
        if (!recipe) return { instruction: 'Waiting for the timer…' };
        const step = recipe.cookingSteps[session.currentCookingStepIndex];
        if (!step) return { instruction: 'Waiting for the timer…' };
        return {
          stepNumber: step.stepNumber,
          totalSteps: recipe.cookingSteps.length,
          instruction: step.spokenInstruction || step.instruction,
          stepId: step.id,
          safetyNote: step.safetyNote,
        };
      }
      case 'PLATING':
        return { instruction: 'Plate and serve. Say "done" when it is plated.' };
      case 'COMPLETED':
        return { instruction: 'Enjoy your meal!' };
      case 'PAUSED': {
        // Show the step the cook will return to.
        const resumable = session.resumableState;
        if (resumable && recipe) {
          if (resumable.phase === 'PREP_GUIDANCE') {
            const step = recipe.prepSteps[resumable.prepStepIndex];
            if (step) {
              return {
                stepNumber: step.stepNumber,
                totalSteps: recipe.prepSteps.length,
                instruction: step.spokenInstruction || step.instruction,
                stepId: step.id,
              };
            }
          }
          if (resumable.phase === 'COOKING_GUIDANCE' || resumable.phase === 'WAITING_FOR_TIMER') {
            const step = recipe.cookingSteps[resumable.cookingStepIndex];
            if (step) {
              return {
                stepNumber: step.stepNumber,
                totalSteps: recipe.cookingSteps.length,
                instruction: step.spokenInstruction || step.instruction,
                stepId: step.id,
              };
            }
          }
        }
        return { instruction: 'Paused. Say "resume" when you are ready.' };
      }
      default:
        return {};
    }
  }

  // ── Timer auto-start ──────────────────────────────────────────────────────

  /**
   * When the current cooking step carries timerSeconds, start a backend
   * timer and enter WAITING_FOR_TIMER. Returns the started timer info, or
   * null when the step has no timer. Only returns success after every
   * backend write has succeeded.
   */
  private async autoStartTimerForStep(
    session: CookingSession,
    step: CookingStep,
    options?: { correlationId?: string },
  ): Promise<TimerStartedInfo | null> {
    if (!step.timerSeconds || step.timerSeconds <= 0) return null;

    const t = Date.now();
    const timer: CookingTimer = {
      id: newId(),
      userId: session.userId,
      sessionId: session.id,
      label: secondsToLabel(step.timerSeconds),
      durationSeconds: step.timerSeconds,
      startedAt: t,
      endsAt: t + step.timerSeconds * 1000,
      status: 'RUNNING',
      stepId: step.id,
    };
    await this.timerStore.createTimer(timer);

    let updated = session;
    if (updated.currentPhase === 'COOKING_GUIDANCE') {
      updated = await this.sessionService.transitionTo(
        updated.id,
        updated.version,
        'WAITING_FOR_TIMER',
        'AGENT_TOOL',
        { correlationId: options?.correlationId },
      );
    }
    await this.sessionService.attachTimer(updated.id, updated.version, timer.id, {
      correlationId: options?.correlationId,
    });

    return {
      timerId: timer.id,
      label: timer.label,
      durationSeconds: timer.durationSeconds,
      endsAt: timer.endsAt,
    };
  }

  /**
   * When the session is in COOKING_GUIDANCE and its current step carries
   * timerSeconds, auto-start the timer and return the refreshed session.
   */
  private async maybeAutoStart(
    session: CookingSession,
    recipe: Recipe,
    options?: { correlationId?: string },
  ): Promise<{ session: CookingSession; timerStarted: TimerStartedInfo | null }> {
    if (session.currentPhase !== 'COOKING_GUIDANCE') {
      return { session, timerStarted: null };
    }
    const step = recipe.cookingSteps[session.currentCookingStepIndex];
    if (!step?.timerSeconds) {
      return { session, timerStarted: null };
    }
    const timerStarted = await this.autoStartTimerForStep(session, step, options);
    const fresh = await this.sessionService.getSession(session.id);
    return { session: fresh ?? session, timerStarted };
  }

  // ── Resolution helpers ────────────────────────────────────────────────────

  private async resolveSession(userId: string, sessionId?: string): Promise<CookingSession | null> {
    const session = sessionId
      ? await this.sessionService.getSession(sessionId)
      : await this.sessionService.getActiveSession(userId);
    if (!session) return null;
    if (session.userId !== userId) {
      throw new GuideError('Session belongs to another user', 'FORBIDDEN', false);
    }
    return session;
  }

  private async requireRecipe(session: CookingSession): Promise<Recipe> {
    if (!session.recipeId) {
      throw new GuideError('This session has no recipe attached', 'NO_RECIPE', true);
    }
    const recipe = await this.loadRecipe(session.recipeId);
    if (!recipe) {
      throw new GuideError(`Recipe ${session.recipeId} not found`, 'RECIPE_NOT_FOUND', true);
    }
    return recipe;
  }

  private async loadRecipe(recipeId: string): Promise<Recipe | null> {
    if (!this.recipeStore) return null;
    return this.recipeStore.getRecipe(recipeId);
  }

  private async activeTimers(session: CookingSession): Promise<ActiveTimerInfo[]> {
    const timers = await this.timerStore.listActiveTimers(session.id);
    const nowMs = Date.now();
    return timers.map((t) => ({
      timerId: t.id,
      label: t.label,
      durationSeconds: t.durationSeconds,
      endsAt: t.endsAt,
      remainingSeconds: Math.max(0, Math.round((t.endsAt - nowMs) / 1000)),
    }));
  }

  /** Walk a session to RECIPE_READY along the allowed transition table. */
  private async fastForwardToRecipeReady(
    session: CookingSession,
    correlationId?: string,
  ): Promise<CookingSession> {
    const STEPS: { to: SessionPhase; reason: 'USER_INPUT' | 'AGENT_TOOL' }[] = [
      { to: 'CONFIRMING_INGREDIENTS', reason: 'USER_INPUT' },
      { to: 'COLLECTING_REQUIREMENTS', reason: 'USER_INPUT' },
      { to: 'GENERATING_RECIPE', reason: 'USER_INPUT' },
      { to: 'VALIDATING_RECIPE', reason: 'AGENT_TOOL' },
      { to: 'RECIPE_READY', reason: 'AGENT_TOOL' },
    ];

    let current = session;
    for (const step of STEPS) {
      if (current.currentPhase === step.to) continue;
      if (current.currentPhase === 'RECIPE_READY') break;
      current = await this.sessionService.transitionTo(
        current.id,
        current.version,
        step.to,
        step.reason,
        { correlationId },
      );
    }
    return current;
  }

  private emptySnapshot(): GuideSnapshot {
    return { found: false, phase: 'IDLE', activeTimers: [], availableIngredients: [] };
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function newId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

const NUMBER_WORDS: Record<number, string> = {
  1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
  7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve',
};

/** 240 → "four-minute timer", 30 → "30-second timer". */
export function secondsToLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}-second timer`;
  const mins = seconds / 60;
  const whole = Math.floor(mins);
  const frac = mins - whole;
  const word = NUMBER_WORDS[whole] ?? String(whole);
  const label = frac >= 0.5 ? `${word}-and-a-half-minute` : `${word}-minute`;
  return `${label} timer`;
}
