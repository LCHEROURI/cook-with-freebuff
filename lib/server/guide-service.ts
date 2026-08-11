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
import type { PantryService, ConsumptionResult } from './pantry-service';
import type { LeftoverService } from './leftover-service';
import type { GroceryService } from './grocery-service';
import type {
  CookingSession,
  CookingStep,
  CookingTimer,
  Ingredient,
  Recipe,
  SessionPhase,
} from '../domain/types';
import { replaceIngredientInRecipe } from '../recipe/transform';
import { validateRecipe } from '../recipe/validate';
import { findSubstitutionCandidates, type SubstitutionCandidate } from '../recipe/substitute';
import { recipeSchema } from '../domain/schemas';
import { getSubstitutionService } from '../ai/provider';
import type { RecipeValidationResult } from '../ai/types';

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
  /**
   * Set while the session is in SAFETY_WARNING: the step's safety note is a
   * confirmation gate — the step is NOT completed until the cook acknowledges
   * it. The same step is shown (progress is preserved).
   */
  safetyGate?: { note: string };
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

// ── Error-recovery classification (K7 Part C) ────────────────────────────────

/** Bounded retry budget for transient failures. */
export const MAX_RETRIES = 2;

/** Codes that may safely be retried (bounded). */
const TRANSIENT_CODES = new Set([
  'NETWORK_ERROR',
  'NETWORK',
  'TIMEOUT',
  'MODEL_TIMEOUT',
  'GENERATION_UNAVAILABLE',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'SERVER_BUSY',
  'SUBSTITUTION_UNAVAILABLE',
]);

/** Codes that mean the user should provide better input. */
const USER_CORRECTABLE_CODES = new Set([
  'INVALID_ARGUMENTS',
  'INVALID_PHASE',
  'MISSING_INPUT',
  'NO_RECIPE',
  'WAITING_FOR_TIMER',
  'NOT_PAUSED',
  'NO_PENDING_SUBSTITUTION',
]);

export type RecoveryDecision =
  | { action: 'RETRY'; retryCount: number; failedTool?: string; snapshot: GuideSnapshot }
  | { action: 'GIVE_UP'; message: string; retryCount: number; failedTool?: string; snapshot: GuideSnapshot }
  | { action: 'QUESTION'; question: string; snapshot: GuideSnapshot }
  | { action: 'RELOAD'; snapshot: GuideSnapshot }
  | { action: 'FATAL'; message: string; snapshot: GuideSnapshot };

function conciseQuestion(code: string, message?: string): string {
  switch (code) {
    case 'NO_RECIPE':
      return 'This recipe is missing — can you confirm which recipe we are cooking?';
    case 'WAITING_FOR_TIMER':
      return 'A timer is still running — should I wait for it to finish?';
    case 'NO_PENDING_SUBSTITUTION':
      return 'What would you like to substitute?';
    default:
      return message ? `${message} — what would you like to do?` : 'Can you rephrase that?';
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export class GuidedCookingService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly timerStore: TimerStore,
    private readonly recipeStore?: RecipeStore,
    /** Optional pantry (K8) — adjusts inventory when a recipe is completed. */
    private readonly pantryService?: PantryService,
    /** Optional leftover tracking (K10) — logs a leftover when a meal completes. */
    private readonly leftoverService?: LeftoverService,
    /** Optional grocery list (K10) — auto-adds depleted + expired items. */
    private readonly groceryService?: GroceryService,
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
    // Object-level authorization (K9 Part B): a recipe is owner-scoped — one
    // user must never launch (and thereby read) another user's recipe. The
    // admin SDK read bypasses Firestore rules, so this check is the gate.
    if (recipe.userId && recipe.userId !== userId) {
      throw new GuideError('Recipe belongs to another user', 'FORBIDDEN', false);
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
      // The user is cooking this validated recipe — seed the availability list
      // so ingredient corrections stay viable (K7 Part B).
      session = await this.sessionService.updateAvailableIngredients(
        session.id,
        session.version,
        recipe.ingredients,
        'UPSERT',
        { correlationId: options?.correlationId },
      );
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
   * - A step with a safetyNote first surfaces a SAFETY_WARNING gate (progress
   *   preserved); the step completes only on the acknowledgment call.
   */
  async completeCurrentAction(
    userId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const recipe = await this.requireRecipe(session);

    // Safety confirmation gate: when the current step carries a safetyNote,
    // "done" does NOT complete it — it surfaces the note as a gate and keeps
    // progress. The step completes only after the cook acknowledges the gate
    // (a second "done" while in SAFETY_WARNING).
    if (session.currentPhase === 'PREP_GUIDANCE' || session.currentPhase === 'COOKING_GUIDANCE') {
      const step =
        session.currentPhase === 'PREP_GUIDANCE'
          ? recipe.prepSteps[session.currentPrepStepIndex]
          : recipe.cookingSteps[session.currentCookingStepIndex];
      if (step?.safetyNote) {
        const gated = await this.sessionService.transitionTo(
          session.id,
          session.version,
          'SAFETY_WARNING',
          'SYSTEM',
          { correlationId: options?.correlationId },
        );
        return this.buildSnapshot(userId, gated, recipe);
      }
    }

    switch (session.currentPhase) {
      case 'PREP_GUIDANCE':
        return this.advancePrep(userId, session, recipe, options);
      case 'COOKING_GUIDANCE':
        return this.advanceCooking(userId, session, recipe, options);
      case 'PLATING': {
        const updated = await this.sessionService.transitionTo(
          session.id,
          session.version,
          'COMPLETED',
          'AGENT_TOOL',
          { correlationId: options?.correlationId },
        );
        // K8/K10 completion hooks: adjust pantry inventory for the finished
        // recipe (uncertain quantities never reduced), log the meal as a
        // leftover, and auto-generate grocery lines for depleted + expired
        // items. All best-effort and non-fatal — the completion is durable.
        const consumed = await this.consumePantryForCompleted(userId, updated, recipe);
        await this.logLeftoverForCompleted(userId, updated, recipe);
        await this.syncGroceryForCompleted(userId, consumed);
        return this.buildSnapshot(userId, updated, recipe);
      }
      case 'SAFETY_WARNING': {
        // The cook acknowledged the gate — complete the gated step exactly as a
        // normal completion would (same phase boundaries, timer auto-start).
        // The advance helpers are called directly (not via this method) so the
        // gate cannot re-trigger on the same step.
        const resumable = session.resumableState;
        if (
          !resumable ||
          (resumable.phase !== 'PREP_GUIDANCE' && resumable.phase !== 'COOKING_GUIDANCE')
        ) {
          throw new GuideError('Safety state lost — cannot resume safely', 'NO_RESUMABLE_STATE', false);
        }
        const restored = await this.sessionService.transitionTo(
          session.id,
          session.version,
          resumable.phase,
          'RECOVERY',
          { correlationId: options?.correlationId },
        );
        return resumable.phase === 'PREP_GUIDANCE'
          ? this.advancePrep(userId, restored, recipe, options)
          : this.advanceCooking(userId, restored, recipe, options);
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

  /** Complete a prep step and advance (with the prep → cooking boundary). */
  private async advancePrep(
    userId: string,
    session: CookingSession,
    recipe: Recipe,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
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

  /** Complete a cooking step and advance (with the cooking → plating boundary). */
  private async advanceCooking(
    userId: string,
    session: CookingSession,
    recipe: Recipe,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
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

  // ── Start over (archive + fresh session) ───────────────────────────────────

  /**
   * "Start over" — the user-facing reset. Archives the current session
   * (ABANDONED, its running timers cancelled) and launches a FRESH session
   * pinned to the SAME recipe, so the cook can restart from prep step 1
   * without Firebase surgery. Returns the new session's snapshot.
   *
   * The old session is never deleted — it stays as an ABANDONED record (the
   * same archive verify-live's pre-run sweep uses), so nothing is lost.
   */
  async startOver(
    userId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const recipe = await this.requireRecipe(session);

    // Cancel the current session's running timers so no alert fires for the
    // archived session (the new session has its own lifecycle).
    const running = await this.timerStore.listActiveTimers(session.id);
    for (const timer of running) {
      await this.timerStore.updateTimer(timer.id, { status: 'CANCELLED', completedAt: Date.now() });
    }

    // Archive the current session (ABANDONED) — endSession is the only
    // sanctioned way to end a session (never a raw status write).
    await this.sessionService.endSession(session.id, session.version, {
      correlationId: options?.correlationId,
    });

    // Launch a fresh session pinned to the same recipe, starting at prep step 1.
    return this.launchCookWithMe(userId, recipe.id, undefined, {
      correlationId: options?.correlationId,
    });
  }

  // ── Substitution (K7 Part A) ──────────────────────────────────────────────

  /**
   * The cook is out of an ingredient. Preserve the exact session location and
   * enter SUBSTITUTION_REQUIRED. Returns honest candidates (deterministic map,
   * pantry-first); [] when nothing is known — never invented.
   */
  async requestSubstitution(
    userId: string,
    sessionId: string | undefined,
    unavailableIngredient: string,
    options?: { correlationId?: string },
  ): Promise<{ snapshot: GuideSnapshot; unavailableIngredient: string; candidates: SubstitutionCandidate[] }> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    if (session.currentPhase !== 'PREP_GUIDANCE' && session.currentPhase !== 'COOKING_GUIDANCE') {
      throw new GuideError(
        `Cannot substitute while ${session.currentPhase}`,
        'INVALID_PHASE',
        true,
      );
    }

    const transitioned = await this.sessionService.transitionTo(
      session.id,
      session.version,
      'SUBSTITUTION_REQUIRED',
      'USER_INPUT',
      { correlationId: options?.correlationId },
    );

    // Persist the pending ingredient so a later "use X" can confirm it.
    const updated = await this.sessionService.updateSessionMetadata(
      transitioned.id,
      transitioned.version,
      { pendingSubstitution: unavailableIngredient },
      { correlationId: options?.correlationId },
    );

    const recipe = await this.requireRecipeSafe(updated);
    const candidates = recipe
      ? await this.substitutionCandidates(recipe, unavailableIngredient, updated.availableIngredients.map((i) => i.name))
      : [];

    return {
      snapshot: await this.buildSnapshot(userId, updated, recipe ?? undefined),
      unavailableIngredient,
      candidates,
    };
  }

  /**
   * Confirm a substitution: replace the ingredient throughout the recipe,
   * persist, revalidate, log, and resume the EXACT step. Never silent — the
   * session must be in SUBSTITUTION_REQUIRED.
   */
  async applySubstitution(
    userId: string,
    sessionId: string | undefined,
    change: { unavailableIngredient?: string; replacement: string },
    options?: { correlationId?: string },
  ): Promise<{ snapshot: GuideSnapshot; from: string; to: string; validation: RecipeValidationResult }> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    if (session.currentPhase !== 'SUBSTITUTION_REQUIRED') {
      throw new GuideError(
        'There is no pending substitution to confirm',
        'NO_PENDING_SUBSTITUTION',
        true,
      );
    }

    // The unavailable ingredient may come from the request or the pending
    // session state ("use X" flow) — never silent either way.
    const from = change.unavailableIngredient || session.pendingSubstitution;
    if (!from) {
      throw new GuideError('Which ingredient should I substitute?', 'NO_PENDING_SUBSTITUTION', true);
    }

    const recipe = await this.requireRecipe(session);
    const updated = replaceIngredientInRecipe(recipe, from, change.replacement);
    const parsed = recipeSchema.safeParse(updated);
    if (!parsed.success) {
      throw new GuideError(
        `Replacement produced an invalid recipe: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
        'REPLACEMENT_INVALID',
        false,
      );
    }

    if (this.recipeStore) {
      await this.recipeStore.updateRecipe(parsed.data);
    }

    // Revalidate the affected recipe against what the cook has.
    const validation = validateRecipe(parsed.data, {
      availableIngredients: session.availableIngredients.map((i) => i.name),
    });

    await this.sessionService.logSessionEvent(session.id, 'SUBSTITUTION_APPLIED', {
      from,
      to: change.replacement,
      validationValid: validation.valid,
      validationErrors: validation.errors.length,
    }, { correlationId: options?.correlationId });

    // Clear the pending substitution, then resume the exact step (RECOVERY
    // transition restores the resumable phase).
    const cleared = await this.sessionService.updateSessionMetadata(
      session.id,
      session.version,
      { pendingSubstitution: null },
      { correlationId: options?.correlationId },
    );

    const resumable = session.resumableState;
    if (!resumable || (resumable.phase !== 'PREP_GUIDANCE' && resumable.phase !== 'COOKING_GUIDANCE')) {
      throw new GuideError('Substitution state lost — cannot resume safely', 'NO_RESUMABLE_STATE', false);
    }
    const restored = await this.sessionService.transitionTo(
      cleared.id,
      cleared.version,
      resumable.phase,
      'RECOVERY',
      { correlationId: options?.correlationId },
    );

    return {
      snapshot: await this.buildSnapshot(userId, restored, parsed.data),
      from,
      to: change.replacement,
      validation,
    };
  }

  // ── User correction (K7 Part B) ───────────────────────────────────────────

  /**
   * The cook corrects an ingredient mid-guidance ("No, I said two tomatoes").
   * Preserves the step, persists the correction, and decides whether the
   * recipe needs regeneration (revalidation failure) or can resume as-is.
   */
  async correctAvailableIngredients(
    userId: string,
    sessionId: string | undefined,
    ingredients: Ingredient[],
    mode: 'UPSERT' | 'REMOVE',
    options?: { correlationId?: string },
  ): Promise<{ snapshot: GuideSnapshot; revalidated: boolean; regenerating: boolean; validation?: RecipeValidationResult }> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    if (session.currentPhase !== 'PREP_GUIDANCE' && session.currentPhase !== 'COOKING_GUIDANCE') {
      throw new GuideError(
        `Cannot correct while ${session.currentPhase}`,
        'INVALID_PHASE',
        true,
      );
    }

    // Preserve location before persisting the correction.
    const interrupted = await this.sessionService.transitionTo(
      session.id,
      session.version,
      'USER_CORRECTION',
      'USER_INPUT',
      { correlationId: options?.correlationId },
    );

    const corrected = await this.sessionService.updateAvailableIngredients(
      interrupted.id,
      interrupted.version,
      ingredients,
      mode === 'REMOVE' ? 'REPLACE' : 'UPSERT',
      { correlationId: options?.correlationId },
    );

    // Decide whether the recipe is still viable with the corrected list.
    const recipe = await this.requireRecipeSafe(corrected);
    if (!recipe) {
      const restored = await this.restoreFromInterruption(corrected, options?.correlationId);
      return { snapshot: await this.buildSnapshot(userId, restored), revalidated: false, regenerating: false };
    }

    const validation = validateRecipe(recipe, {
      availableIngredients: corrected.availableIngredients.map((i) => i.name),
    });
    const regenerating = !validation.valid || validation.missingConfirmations.length > 0;

    if (regenerating) {
      // Recipe no longer viable — back to requirements to regenerate.
      const backToRequirements = await this.sessionService.transitionTo(
        corrected.id,
        corrected.version,
        'COLLECTING_REQUIREMENTS',
        'RECOVERY',
        { correlationId: options?.correlationId },
      );
      return {
        snapshot: await this.buildSnapshot(userId, backToRequirements),
        revalidated: true,
        regenerating: true,
        validation,
      };
    }

    const restored = await this.restoreFromInterruption(corrected, options?.correlationId);
    return {
      snapshot: await this.buildSnapshot(userId, restored, recipe),
      revalidated: true,
      regenerating: false,
      validation,
    };
  }

  // ── Error recovery (K7 Part C) ────────────────────────────────────────────

  /**
   * Classify and handle an error. Records ERROR_RECOVERY when needed, then
   * returns a bounded recovery decision:
   *   RETRY   — transient, retries remain (bounded at 2) — session restored
   *   GIVE_UP — transient but retries exhausted — session restored
   *   QUESTION — user-correctable — one concise question — session restored
   *   RELOAD  — state conflict — canonical state reloaded — session restored
   *   FATAL   — non-recoverable — session preserved in ERROR_RECOVERY
   */
  async recoverAfterError(
    userId: string,
    sessionId: string | undefined,
    error?: { code: string; message?: string; failedTool?: string; recoverable?: boolean },
    options?: { correlationId?: string },
  ): Promise<RecoveryDecision> {
    let session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);

    // Record the failure when the session is not already in ERROR_RECOVERY.
    if (session.currentPhase !== 'ERROR_RECOVERY') {
      if (!error) {
        throw new GuideError('No error was reported and the session is not in recovery', 'NOT_IN_ERROR_RECOVERY', true);
      }
      session = await this.sessionService.handleError(
        session.id,
        session.version,
        error.code,
        error.message ?? error.code,
        {
          correlationId: options?.correlationId,
          failedTool: error.failedTool,
          recoverable: error.recoverable ?? true,
        },
      );
    }

    const rc = session.recoveryContext;
    const code = rc?.errorCode ?? error?.code ?? 'UNKNOWN_ERROR';
    const failedTool = rc?.failedTool ?? error?.failedTool;
    const recoverable = rc?.recoverable ?? error?.recoverable ?? true;

    if (code === 'VERSION_CONFLICT') {
      const restored = await this.restoreFromInterruption(session, options?.correlationId);
      return { action: 'RELOAD', snapshot: await this.buildSnapshot(userId, restored) };
    }

    if (!recoverable) {
      return {
        action: 'FATAL',
        message: 'This operation cannot continue safely. Your session is preserved — say "help" to recover.',
        snapshot: await this.buildSnapshot(userId, session),
      };
    }

    if (USER_CORRECTABLE_CODES.has(code)) {
      const restored = await this.restoreFromInterruption(session, options?.correlationId);
      return {
        action: 'QUESTION',
        question: conciseQuestion(code, session.recoveryContext?.errorMessage),
        snapshot: await this.buildSnapshot(userId, restored),
      };
    }

    if (TRANSIENT_CODES.has(code)) {
      const retryCount = (rc?.retryCount ?? 0) + 1;
      if (retryCount > MAX_RETRIES) {
        const restored = await this.restoreFromInterruption(session, options?.correlationId);
        return {
          action: 'GIVE_UP',
          message: 'I am still having trouble with that. Let us pause here — say "help" and I will walk you through it.',
          retryCount,
          failedTool,
          snapshot: await this.buildSnapshot(userId, restored),
        };
      }

      // Persist the bumped retry count, then restore for the retry.
      const bumped = await this.sessionService.updateSessionMetadata(
        session.id,
        session.version,
        { recoveryContext: { ...rc!, retryCount } },
        { correlationId: options?.correlationId },
      );
      const restored = await this.restoreFromInterruption(bumped, options?.correlationId);
      return {
        action: 'RETRY',
        retryCount,
        failedTool,
        snapshot: await this.buildSnapshot(userId, restored),
      };
    }

    // Unknown code — treat as transient-once.
    const restored = await this.restoreFromInterruption(session, options?.correlationId);
    return { action: 'RETRY', retryCount: 1, failedTool, snapshot: await this.buildSnapshot(userId, restored) };
  }

  /** Clear a lingering recovery context after a successful retry. */
  async clearRecovery(
    userId: string,
    sessionId?: string,
    options?: { correlationId?: string },
  ): Promise<GuideSnapshot> {
    const session = await this.resolveSession(userId, sessionId);
    if (!session) throw new GuideError('No cooking session found for this user', 'SESSION_NOT_FOUND', true);
    const cleared = await this.sessionService.updateSessionMetadata(
      session.id,
      session.version,
      { recoveryContext: null },
      { correlationId: options?.correlationId },
    );
    return this.buildSnapshot(userId, cleared);
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
          safetyNote: step.safetyNote,
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
      case 'SUBSTITUTION_REQUIRED':
      case 'USER_CORRECTION':
      case 'SAFETY_WARNING':
      case 'PAUSED': {
        // Show the step the cook will return to after the interruption.
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
                ...(session.currentPhase === 'SAFETY_WARNING' && step.safetyNote
                  ? { safetyNote: step.safetyNote, safetyGate: { note: step.safetyNote } }
                  : {}),
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
                ...(session.currentPhase === 'SAFETY_WARNING' && step.safetyNote
                  ? { safetyNote: step.safetyNote, safetyGate: { note: step.safetyNote } }
                  : {}),
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

  // ── Completion hooks (K8 pantry + K10 leftovers/grocery) ───────────────────

  /**
   * Adjust pantry inventory for a completed recipe. Best-effort and
   * non-fatal: consumption only touches high-confidence, quantity-known
   * matches, so a failure here must never fail the completion itself.
   */
  private async consumePantryForCompleted(
    userId: string,
    session: CookingSession,
    recipe: Recipe,
  ): Promise<ConsumptionResult | null> {
    if (!this.pantryService) return null;
    try {
      return await this.pantryService.consumeForRecipe(userId, recipe, { sessionId: session.id });
    } catch {
      // Logged by the pantry service on the session when possible; the
      // completion is already durable — do not roll it back.
      return null;
    }
  }

  /**
   * K10 leftovers: log the finished meal as a leftover (ACTIVE), so "what's
   * in the fridge?" can answer from real memory. Best-effort, non-fatal.
   */
  private async logLeftoverForCompleted(
    userId: string,
    session: CookingSession,
    recipe: Recipe,
  ): Promise<void> {
    if (!this.leftoverService) return;
    try {
      await this.leftoverService.createLeftover(
        userId,
        { recipeId: recipe.id, title: recipe.title, servings: recipe.servings },
        { sessionId: session.id },
      );
    } catch {
      // Non-fatal — the completion is durable.
    }
  }

  /**
   * K10 grocery generation: items the recipe exhausted (action 'removed')
   * and pantry items past their expirationDate land on the grocery list
   * automatically. Best-effort, non-fatal.
   */
  private async syncGroceryForCompleted(
    userId: string,
    consumed: ConsumptionResult | null,
  ): Promise<void> {
    if (!this.groceryService || !this.pantryService) return;
    try {
      const depleted = (consumed?.adjusted ?? [])
        .filter((a) => a.action === 'removed')
        .map((a) => ({ name: a.name }));
      if (depleted.length > 0) {
        await this.groceryService.syncDepleted(userId, depleted);
      }
      const expired = await this.pantryService.expiredItems(userId);
      if (expired.length > 0) {
        await this.groceryService.syncExpired(userId, expired);
      }
    } catch {
      // Non-fatal — the completion is durable.
    }
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
    // The session's owner must also own the recipe (defense in depth for any
    // session created before the launch-time check existed).
    if (recipe.userId && recipe.userId !== session.userId) {
      throw new GuideError('Recipe belongs to another user', 'FORBIDDEN', false);
    }
    return recipe;
  }

  private async loadRecipe(recipeId: string): Promise<Recipe | null> {
    if (!this.recipeStore) return null;
    return this.recipeStore.getRecipe(recipeId);
  }

  private async requireRecipeSafe(session: CookingSession): Promise<Recipe | null> {
    if (!session.recipeId) return null;
    return this.loadRecipe(session.recipeId);
  }

  /** Merge deterministic + AI substitution candidates (never invented). */
  private async substitutionCandidates(
    recipe: Recipe,
    unavailable: string,
    pantry: string[],
  ): Promise<SubstitutionCandidate[]> {
    const service = getSubstitutionService();
    if (service) {
      try {
        return await service.findSubstitution({
          unavailableIngredient: unavailable,
          recipe,
          availablePantry: pantry,
        });
      } catch {
        // Deterministic fallback below.
      }
    }
    return findSubstitutionCandidates(recipe, unavailable, pantry);
  }

  /**
   * Restore a session out of an interruption to its exact resumable step.
   * ERROR_RECOVERY is restored directly (the machine has no outgoing table
   * entries); other interruptions use the allowed RECOVERY transitions.
   */
  private async restoreFromInterruption(
    session: CookingSession,
    correlationId?: string,
  ): Promise<CookingSession> {
    if (session.currentPhase === 'ERROR_RECOVERY') {
      return this.sessionService.recoverFromError(session.id, session.version, { correlationId });
    }
    const resumable = session.resumableState;
    if (!resumable) return session;
    if (
      resumable.phase === 'PREP_GUIDANCE' ||
      resumable.phase === 'COOKING_GUIDANCE' ||
      resumable.phase === 'COLLECTING_REQUIREMENTS'
    ) {
      return this.sessionService.transitionTo(session.id, session.version, resumable.phase, 'RECOVERY', {
        correlationId,
      });
    }
    return session;
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
