// ─────────────────────────────────────────────────────────────────────────────
// Cooking-session service
//
// Operational layer that turns the K1 state machine definition into a
// deterministic, persistent backend service. Every transition is validated,
// persisted, and event-sourced. The database — not conversational memory —
// is the authority on session progress.
// ─────────────────────────────────────────────────────────────────────────────

import {
  canTransition,
  transitionSessionState,
} from '../domain/session';
import type {
  CookingSession,
  CookingSessionEvent,
  SessionState,
  SessionPhase,
  SessionEventType,
  Ingredient,
  EpochMs,
  RecoveryContext,
  PendingPantryItem,
} from '../domain/types';

// ── Store interface (abstracted for testability) ─────────────────────────────

export interface SessionStore {
  getSession(id: string): Promise<CookingSession | null>;
  createSession(session: CookingSession): Promise<void>;
  updateSession(
    id: string,
    partial: Partial<CookingSession>,
    expectedVersion: number,
    marker?: { mark?: string | string[]; clear?: string },
  ): Promise<CookingSession>;
  getActiveSession(userId: string): Promise<CookingSession | null>;
  createEvent(event: CookingSessionEvent): Promise<void>;
  listSessionEvents(sessionId: string): Promise<CookingSessionEvent[]>;
  hasCorrelationMarker(id: string): Promise<boolean>;
  markCorrelationMarker(id: string): Promise<void>;
  clearCorrelationMarker(id: string): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): EpochMs {
  return Date.now();
}

function newId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function sessionStateFromSession(session: CookingSession): SessionState {
  return {
    phase: session.currentPhase,
    prepStepIndex: session.currentPrepStepIndex,
    cookingStepIndex: session.currentCookingStepIndex,
    activeTimerIds: [...session.activeTimerIds],
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export class VersionConflictError extends SessionError {
  constructor(sessionId: string, expected: number, actual: number) {
    super(
      `Session ${sessionId} version conflict: expected ${expected}, got ${actual}`,
      'VERSION_CONFLICT',
      true,
    );
    this.name = 'VersionConflictError';
  }
}

// ── Session service ──────────────────────────────────────────────────────────

export class SessionService {
  constructor(private readonly store: SessionStore) {}

  /**
   * Forget a correlation ID so its operation becomes retryable again. Used
   * after a compensating rollback (resume → rebase failure → re-pause): the
   * ORIGINAL resume ID was marked processed by the transition that then got
   * rolled back, so a client retry with that same ID would otherwise be
   * swallowed as a duplicate while the session sits PAUSED — and the handler
   * would still rebase its timers a second time (Codex P1, PR #51 review).
   */
  async clearProcessed(correlationId?: string): Promise<void> {
    if (correlationId) await this.store.clearCorrelationMarker(correlationId);
  }

  private async hasBeenProcessed(correlationId?: string): Promise<boolean> {
    return correlationId ? this.store.hasCorrelationMarker(correlationId) : false;
  }

  private async markProcessed(correlationId?: string): Promise<void> {
    if (correlationId) await this.store.markCorrelationMarker(correlationId);
  }
  /**
   * Create a new cooking session for a user.
   * Starts at IDLE and immediately transitions to COLLECTING_INGREDIENTS.
   */
  async createSession(
    userId: string,
    options?: { recipeId?: string; correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const existing = await this.store.getActiveSession(userId);
      if (existing) return existing;
    }

    const id = newId();
    const t = now();
    const session: CookingSession = {
      id,
      userId,
      recipeId: options?.recipeId,
      status: 'ACTIVE',
      currentPhase: 'IDLE',
      currentPrepStepIndex: 0,
      currentCookingStepIndex: 0,
      activeTimerIds: [],
      availableIngredients: [],
      startedAt: t,
      lastActivityAt: t,
      version: 1,
    };

    await this.store.createSession(session);

    // Emit SESSION_STARTED event
    await this.store.createEvent({
      id: newId(),
      sessionId: id,
      userId,
      type: 'SESSION_STARTED',
      data: { recipeId: options?.recipeId ?? null },
      at: t,
      correlationId: options?.correlationId,
    });

    // Auto-transition IDLE → COLLECTING_INGREDIENTS. The OUTER create id and
    // the derived idle-transition id both ride the same transaction, so a
    // committed create always carries both markers (Codex P1, PR #58 review:
    // a separate outer-mark write could fail after the transition committed,
    // leaving a retried createSession to spawn a second session).
    const updated = await this.transitionTo(id, 1, 'COLLECTING_INGREDIENTS', 'USER_INPUT', {
      correlationId: options?.correlationId ? `idle->${options.correlationId}` : undefined,
      additionalMarks: options?.correlationId ? [options.correlationId] : undefined,
    });

    return updated;
  }

  /**
   * Transition the session to a new phase.
   * Validates the transition, persists the new state, logs the event.
   * Returns the updated session.
   */
  async transitionTo(
    sessionId: string,
    expectedVersion: number,
    to: SessionPhase,
    reason: 'USER_INPUT' | 'AGENT_TOOL' | 'TIMER_COMPLETED' | 'RECOVERY' | 'SYSTEM',
    options?: {
      correlationId?: string;
      pausedAt?: number;
      /**
       * Correlation ID to FORGET in the same transaction as this transition
       * (the resume-rollback path: the re-pause must clear the ORIGINAL resume
       * marker atomically — Codex P1, PR #58 review — or a pause that commits
       * without its clear would swallow the client's retry as a duplicate
       * while the session sits PAUSED).
       */
      clearCorrelationId?: string;
      /** Additional correlation IDs to mark in the same transaction. */
      additionalMarks?: string[];
    },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new SessionError('Session not found', 'NOT_FOUND', false);
    }

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const from = session.currentPhase;

    // Check the transition is allowed
    const check = canTransition(from, to);
    if (!check.ok) {
      throw new SessionError(
        check.error ?? `Cannot transition from ${from} to ${to}`,
        'INVALID_TRANSITION',
        true,
      );
    }

    // Compute the new state
    const currentState = sessionStateFromSession(session);
    const { state, resumableState, previousState } = transitionSessionState(currentState, from, to);

    // Compute the event type
    const eventType = this.eventTypeForTransition(from, to);

    // Build the partial update
    const partial: Partial<CookingSession> = {
      currentPhase: state.phase as SessionPhase,
      currentPrepStepIndex: state.prepStepIndex,
      currentCookingStepIndex: state.cookingStepIndex,
      activeTimerIds: state.activeTimerIds,
    };

    if (resumableState) {
      partial.resumableState = resumableState;
    }
    if (previousState) {
      partial.previousState = previousState;
    }

    // Update status based on phase
    if (to === 'PAUSED') {
      partial.status = 'PAUSED';
      // Default anchor is now; a caller may restore an EARLIER pause (the
      // resume-failure rollback re-pauses with the ORIGINAL pausedAt so the
      // frozen remainder and a clean retry survive).
      partial.pausedAt = options?.pausedAt ?? now();
    } else if (to === 'COMPLETED') {
      partial.status = 'COMPLETED';
      partial.completedAt = now();
    } else if (to === 'ERROR_RECOVERY') {
      partial.status = 'ERROR_RECOVERY';
    } else if (from === 'PAUSED' || from === 'ERROR_RECOVERY') {
      partial.status = 'ACTIVE';
    }

    // The marker (and any rollback clear) rides the SAME transaction as the
    // session update — a committed transition always carries its marker, so a
    // client retry dedupes instead of re-running the transition (Codex P1,
    // PR #58 review: previously the marker was a separate write that could
    // fail after the transition had already committed).
    const marks = [options?.correlationId, ...(options?.additionalMarks ?? [])].filter(
      (x): x is string => Boolean(x),
    );
    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: marks.length > 0 ? marks : undefined,
      clear: options?.clearCorrelationId,
    });

    // Log the event
    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: eventType,
      data: {
        from,
        to,
        reason,
        phase: to,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Complete the current step (advance to the next step). (advance to the next step).
   * For PREP_GUIDANCE: advances prepStepIndex.
   * For COOKING_GUIDANCE: advances cookingStepIndex.
   * If all steps are complete, transitions to the next phase.
   */
  async completeCurrentStep(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const phase = session.currentPhase;

    if (phase !== 'PREP_GUIDANCE' && phase !== 'COOKING_GUIDANCE') {
      throw new SessionError(
        `Cannot complete step in phase ${phase}`,
        'INVALID_PHASE',
        true,
      );
    }

    // We need the recipe to know how many steps there are, but we don't have
    // it loaded here. The caller passes the total steps.
    // For now, this is a base implementation — the actual step check is done
    // by the AI tool layer which has the recipe context.
    // We just advance the index and log the event.

    const partial: Partial<CookingSession> = {};
    let eventType: SessionEventType = 'STEP_COMPLETED';

    if (phase === 'PREP_GUIDANCE') {
      partial.currentPrepStepIndex = session.currentPrepStepIndex + 1;
    } else {
      partial.currentCookingStepIndex = session.currentCookingStepIndex + 1;
    }

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: eventType,
      data: {
        phase,
        previousPrepStepIndex: session.currentPrepStepIndex,
        previousCookingStepIndex: session.currentCookingStepIndex,
        newPrepStepIndex: updated.currentPrepStepIndex,
        newCookingStepIndex: updated.currentCookingStepIndex,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Repeat the current step (stay at the same index).
   */
  async repeatCurrentStep(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    // Log the event without changing state
    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: 'STEP_REPEATED',
      data: {
        phase: session.currentPhase,
        prepStepIndex: session.currentPrepStepIndex,
        cookingStepIndex: session.currentCookingStepIndex,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    await this.markProcessed(options?.correlationId);
    return session;
  }

  /**
   * Go back to the previous step.
   * Will not go below 0.
   */
  async previousStep(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const phase = session.currentPhase;
    if (phase !== 'PREP_GUIDANCE' && phase !== 'COOKING_GUIDANCE') {
      throw new SessionError(
        `Cannot go back in phase ${phase}`,
        'INVALID_PHASE',
        true,
      );
    }

    const partial: Partial<CookingSession> = {};

    if (phase === 'PREP_GUIDANCE') {
      const newIndex = Math.max(0, session.currentPrepStepIndex - 1);
      partial.currentPrepStepIndex = newIndex;
    } else {
      const newIndex = Math.max(0, session.currentCookingStepIndex - 1);
      partial.currentCookingStepIndex = newIndex;
    }

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: 'STEP_REVERSED',
      data: {
        phase,
        fromPrepStepIndex: session.currentPrepStepIndex,
        fromCookingStepIndex: session.currentCookingStepIndex,
        toPrepStepIndex: updated.currentPrepStepIndex,
        toCookingStepIndex: updated.currentCookingStepIndex,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Pause the session. Captures the current state as resumableState.
   * `clearCorrelationId` forgets that marker in the SAME transaction as the
   * pause (the resume-rollback path — Codex P1, PR #58 review).
   */
  async pauseSession(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string; pausedAt?: number; clearCorrelationId?: string },
  ): Promise<CookingSession> {
    return this.transitionTo(sessionId, expectedVersion, 'PAUSED', 'USER_INPUT', options);
  }

  /**
   * Resume from a paused state. Restores the resumableState.
   */
  async resumeSession(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.currentPhase !== 'PAUSED') {
      throw new SessionError(
        `Session is not paused (phase: ${session.currentPhase})`,
        'NOT_PAUSED',
        true,
      );
    }

    const resumable = session.resumableState;
    if (!resumable) {
      throw new SessionError(
        'No resumable state found — cannot resume',
        'NO_RESUMABLE_STATE',
        false,
      );
    }

    // Transition back to the resumable phase
    return this.transitionTo(sessionId, expectedVersion, resumable.phase, 'RECOVERY', options);
  }

  /**
   * Handle an error — transition to ERROR_RECOVERY while preserving state.
   */
  async handleError(
    sessionId: string,
    expectedVersion: number,
    errorCode: string,
    errorMessage: string,
    options?: { correlationId?: string; failedTool?: string; recoverable?: boolean; retryCount?: number },
  ): Promise<CookingSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.currentPhase === 'ERROR_RECOVERY') {
      throw new SessionError('Already in error recovery', 'ALREADY_IN_ERROR_RECOVERY', true);
    }

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const from = session.currentPhase;

    // ERROR_RECOVERY is reachable from any operational phase
    const currentState = sessionStateFromSession(session);
    const { resumableState } = transitionSessionState(currentState, from, 'ERROR_RECOVERY');

    const recoveryContext: RecoveryContext = {
      errorCode,
      errorMessage,
      previousState: currentState,
      currentPhase: from,
      currentStepIndex: from === 'COOKING_GUIDANCE' || from === 'WAITING_FOR_TIMER'
        ? session.currentCookingStepIndex
        : session.currentPrepStepIndex,
      failedTool: options?.failedTool,
      // Carry the existing retry budget forward so repeated failures stay
      // bounded (K7 Part C).
      retryCount: options?.retryCount ?? session.recoveryContext?.retryCount ?? 0,
      recoverable: options?.recoverable ?? true,
    };

    const partial: Partial<CookingSession> = {
      currentPhase: 'ERROR_RECOVERY',
      status: 'ERROR_RECOVERY',
      resumableState: resumableState ?? currentState,
      previousState: currentState,
      recoveryContext,
    };

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: 'ERROR_OCCURRED',
      data: {
        from,
        errorCode,
        errorMessage,
        recoverable: true,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Recover from ERROR_RECOVERY — restore the previous state.
   */
  async recoverFromError(
    sessionId: string,
    expectedVersion: number,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.currentPhase !== 'ERROR_RECOVERY') {
      throw new SessionError(
        `Session is not in error recovery (phase: ${session.currentPhase})`,
        'NOT_IN_ERROR_RECOVERY',
        true,
      );
    }

    const resumable = session.resumableState ?? session.previousState;
    if (!resumable) {
      throw new SessionError(
        'No previous state found — cannot recover',
        'NO_RECOVERY_STATE',
        false,
      );
    }

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    // Note: recoveryContext is deliberately NOT cleared here — the K7 retry
    // budget must carry across repeated failures.
    const partial: Partial<CookingSession> = {
      currentPhase: resumable.phase,
      currentPrepStepIndex: resumable.prepStepIndex,
      currentCookingStepIndex: resumable.cookingStepIndex,
      activeTimerIds: resumable.activeTimerIds,
      status: 'ACTIVE',
      previousState: undefined,
      resumableState: undefined,
    };

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: 'ERROR_RECOVERED',
      data: {
        recoveredPhase: resumable.phase,
        prepStepIndex: resumable.prepStepIndex,
        cookingStepIndex: resumable.cookingStepIndex,
      },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Update session metadata without a phase transition (e.g. attach a
   * recipeId to an existing session when guided cooking launches).
   */
  async updateSessionMetadata(
    sessionId: string,
    expectedVersion: number,
    metadata: {
      recipeId?: string;
      recoveryContext?: RecoveryContext | null;
      pendingSubstitution?: string | null;
      pendingPantryItems?: PendingPantryItem[] | null;
    },
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const partial: Partial<CookingSession> = {};
    if (metadata.recipeId !== undefined) partial.recipeId = metadata.recipeId;
    if (metadata.recoveryContext !== undefined) {
      partial.recoveryContext = metadata.recoveryContext ?? undefined;
    }
    if (metadata.pendingSubstitution !== undefined) {
      partial.pendingSubstitution = metadata.pendingSubstitution ?? undefined;
    }
    if (metadata.pendingPantryItems !== undefined) {
      partial.pendingPantryItems = metadata.pendingPantryItems ?? undefined;
    }

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });
    return updated;
  }

  /**
   * Get a session by id.
   */
  async getSession(sessionId: string): Promise<CookingSession | null> {
    return this.store.getSession(sessionId);
  }

  /**
   * Get the active session for a user.
   */
  async getActiveSession(userId: string): Promise<CookingSession | null> {
    return this.store.getActiveSession(userId);
  }

  /**
   * Get all events for a session.
   */
  async getSessionEvents(sessionId: string): Promise<CookingSessionEvent[]> {
    return this.store.listSessionEvents(sessionId);
  }

  /**
   * End a session (mark as COMPLETED or ABANDONED).
   */
  async endSession(
    sessionId: string,
    expectedVersion: number,
    options?: { completed?: boolean; correlationId?: string },
  ): Promise<CookingSession> {
    if (options?.completed) {
      return this.transitionTo(sessionId, expectedVersion, 'COMPLETED', 'AGENT_TOOL', options);
    }

    // Abandon — set status to ABANDONED
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const partial: Partial<CookingSession> = {
      status: 'ABANDONED',
      lastActivityAt: now(),
    };

    const updated = await this.store.updateSession(sessionId, partial, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(),
      sessionId,
      userId: session.userId,
      type: 'SESSION_COMPLETED',
      data: { reason: 'abandoned' },
      at: now(),
      correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Update the session's available-ingredient list (K3 ingredient tools).
   *
   * REPLACE overwrites the whole list; UPSERT merges by normalized name
   * (new entries win). Emits INGREDIENT_ADDED / INGREDIENT_REMOVED /
   * INGREDIENT_CORRECTED events describing the diff.
   */
  async updateAvailableIngredients(
    sessionId: string,
    expectedVersion: number,
    ingredients: Ingredient[],
    mode: 'REPLACE' | 'UPSERT',
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);

    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const phase = session.currentPhase;
    if (
      phase !== 'COLLECTING_INGREDIENTS' &&
      phase !== 'CONFIRMING_INGREDIENTS' &&
      phase !== 'USER_CORRECTION'
    ) {
      throw new SessionError(
        `Cannot edit ingredients in phase ${phase}`,
        'INVALID_PHASE',
        true,
      );
    }

    const normalize = (name: string) => name.toLowerCase().trim();
    let next: Ingredient[];

    if (mode === 'REPLACE') {
      next = ingredients;
    } else {
      const merged = new Map<string, Ingredient>();
      for (const ing of session.availableIngredients) {
        merged.set(normalize(ing.name), ing);
      }
      for (const ing of ingredients) {
        merged.set(normalize(ing.name), ing);
      }
      next = Array.from(merged.values());
    }

    const updated = await this.store.updateSession(sessionId, { availableIngredients: next }, expectedVersion, {
      mark: options?.correlationId,
    });

    const prev = new Map(session.availableIngredients.map((i) => [normalize(i.name), i]));
    const nextNames = new Set(next.map((i) => normalize(i.name)));

    if (mode === 'REPLACE') {
      await this.store.createEvent({
        id: newId(),
        sessionId,
        userId: session.userId,
        type: 'INGREDIENT_CORRECTED',
        data: { action: 'replace', count: next.length, names: next.map((i) => i.name) },
        at: now(),
        correlationId: options?.correlationId,
      });
    } else {
      const added = next.filter((i) => !prev.has(normalize(i.name)));
      const removed = session.availableIngredients.filter((i) => !nextNames.has(normalize(i.name)));
      const changed = next.filter((i) => {
        const p = prev.get(normalize(i.name));
        return p && (p.quantity !== i.quantity || p.unit !== i.unit);
      });
      if (added.length > 0) {
        await this.store.createEvent({
          id: newId(), sessionId, userId: session.userId, type: 'INGREDIENT_ADDED',
          data: { names: added.map((i) => i.name) }, at: now(), correlationId: options?.correlationId,
        });
      }
      if (removed.length > 0) {
        await this.store.createEvent({
          id: newId(), sessionId, userId: session.userId, type: 'INGREDIENT_REMOVED',
          data: { names: removed.map((i) => i.name) }, at: now(), correlationId: options?.correlationId,
        });
      }
      if (changed.length > 0) {
        await this.store.createEvent({
          id: newId(), sessionId, userId: session.userId, type: 'INGREDIENT_CORRECTED',
          data: { names: changed.map((i) => i.name) }, at: now(), correlationId: options?.correlationId,
        });
      }
    }

    return updated;
  }

  /**
   * Attach a running timer id to the session (logs TIMER_STARTED).
   */
  async attachTimer(
    sessionId: string,
    expectedVersion: number,
    timerId: string,
    options?: { correlationId?: string },
  ): Promise<CookingSession> {
    if (await this.hasBeenProcessed(options?.correlationId)) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
      return session;
    }

    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const active = session.activeTimerIds.includes(timerId)
      ? session.activeTimerIds
      : [...session.activeTimerIds, timerId];

    const updated = await this.store.updateSession(sessionId, { activeTimerIds: active }, expectedVersion, {
      mark: options?.correlationId,
    });

    await this.store.createEvent({
      id: newId(), sessionId, userId: session.userId, type: 'TIMER_STARTED',
      data: { timerId }, at: now(), correlationId: options?.correlationId,
    });

    return updated;
  }

  /**
   * Detach a timer id from the session (no event — the caller logs the outcome).
   */
  async detachTimer(
    sessionId: string,
    expectedVersion: number,
    timerId: string,
  ): Promise<CookingSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
    if (session.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion, session.version);
    }

    const active = session.activeTimerIds.filter((id) => id !== timerId);
    return this.store.updateSession(sessionId, { activeTimerIds: active }, expectedVersion);
  }

  /**
   * Append a session event without mutating session state.
   * Used by timer completion/cancellation and other tool-level audit writes.
   */
  async logSessionEvent(
    sessionId: string,
    type: SessionEventType,
    data: Record<string, unknown>,
    options?: { correlationId?: string },
  ): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new SessionError('Session not found', 'NOT_FOUND', false);
    await this.store.createEvent({
      id: newId(), sessionId, userId: session.userId, type, data,
      at: now(), correlationId: options?.correlationId,
    });
    // Event-only op: no session write exists to ride the marker on, so the
    // standalone mark stays (a duplicate event log is benign — the P1s target
    // session-transition/marker divergence, which cannot happen here).
    await this.markProcessed(options?.correlationId);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private eventTypeForTransition(from: SessionPhase, to: SessionPhase): SessionEventType {
    if (to === 'PAUSED') return 'SESSION_PAUSED';
    if (from === 'PAUSED') return 'SESSION_RESUMED';
    if (to === 'COMPLETED') return 'SESSION_COMPLETED';
    if (to === 'ERROR_RECOVERY') return 'ERROR_OCCURRED';
    // `to !== 'ERROR_RECOVERY'` is guaranteed by the preceding early-return.
    if (from === 'ERROR_RECOVERY') return 'ERROR_RECOVERED';
    if (to === 'SUBSTITUTION_REQUIRED') return 'SUBSTITUTION_REQUESTED';
    if (from === 'SUBSTITUTION_REQUIRED') return 'SUBSTITUTION_APPLIED';
    if (to === 'GENERATING_RECIPE') return 'RECIPE_GENERATION_STARTED';
    if (from === 'GENERATING_RECIPE' && to === 'VALIDATING_RECIPE') return 'RECIPE_GENERATED';
    if (to === 'RECIPE_READY' && from === 'VALIDATING_RECIPE') return 'RECIPE_VALIDATED';
    if (from === 'VALIDATING_RECIPE' && to === 'COLLECTING_REQUIREMENTS') return 'RECIPE_VALIDATION_FAILED';
    if (to === 'SAFETY_WARNING') return 'SAFETY_WARNING_TRIGGERED';
    if (to === 'COLLECTING_INGREDIENTS' && from === 'IDLE') return 'SESSION_STARTED';
    // Default: STEP_STARTED for guidance phases
    if (to === 'PREP_GUIDANCE' || to === 'COOKING_GUIDANCE') return 'STEP_STARTED';
    return 'STEP_COMPLETED';
  }
}

// ── In-memory store (for testing) ────────────────────────────────────────────

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, CookingSession>();
  private events: CookingSessionEvent[] = [];
  private markers = new Set<string>();

  async getSession(id: string): Promise<CookingSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async createSession(session: CookingSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async updateSession(
    id: string,
    partial: Partial<CookingSession>,
    expectedVersion: number,
    marker?: { mark?: string | string[]; clear?: string },
  ): Promise<CookingSession> {
    const current = this.sessions.get(id);
    if (!current) throw new Error(`Session ${id} not found`);
    if (current.version !== expectedVersion) {
      throw new Error(`Version conflict: expected ${expectedVersion}, got ${current.version}`);
    }
    const updated: CookingSession = {
      ...current,
      ...partial,
      version: current.version + 1,
      lastActivityAt: now(),
    };
    this.sessions.set(id, updated);
    // Marker ops apply atomically with the session write (mirrors the
    // Firestore tx): a version conflict above throws BEFORE any marker is
    // touched, so a failed update never leaves a stray marker.
    const marks = marker?.mark ? (Array.isArray(marker.mark) ? marker.mark : [marker.mark]) : [];
    for (const m of marks) this.markers.add(m);
    if (marker?.clear) this.markers.delete(marker.clear);
    return { ...updated };
  }

  async getActiveSession(userId: string): Promise<CookingSession | null> {
    const active = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId && (s.status === 'ACTIVE' || s.status === 'PAUSED'))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return active[0] ?? null;
  }

  async createEvent(event: CookingSessionEvent): Promise<void> {
    this.events.push({ ...event });
  }

  async listSessionEvents(sessionId: string): Promise<CookingSessionEvent[]> {
    return this.events
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => a.at - b.at);
  }

  async hasCorrelationMarker(id: string): Promise<boolean> {
    return this.markers.has(id);
  }

  async markCorrelationMarker(id: string): Promise<void> {
    this.markers.add(id);
  }

  async clearCorrelationMarker(id: string): Promise<void> {
    this.markers.delete(id);
  }
}