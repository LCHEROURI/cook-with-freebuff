import { describe, it, expect, beforeEach } from 'vitest';
import { SessionService, InMemorySessionStore, SessionError, VersionConflictError } from './session-service';

describe('SessionService', () => {
  let service: SessionService;
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
    service = new SessionService(store);
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // All phases from COLLECTING_INGREDIENTS → target, in sequential order.
  const PHASE_PATH: Record<string, string[]> = {
    'CONFIRMING_INGREDIENTS': ['CONFIRMING_INGREDIENTS'],
    'COLLECTING_REQUIREMENTS': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS'],
    'GENERATING_RECIPE': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE'],
    'VALIDATING_RECIPE': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE'],
    'RECIPE_READY': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY'],
    'PREP_GUIDANCE': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE'],
    'COOKING_GUIDANCE': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE'],
    'PLATING': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE', 'PLATING'],
    'COMPLETED': ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE', 'VALIDATING_RECIPE', 'RECIPE_READY', 'PREP_GUIDANCE', 'COOKING_GUIDANCE', 'PLATING', 'COMPLETED'],
  };

  async function advanceToPhase(
    sessionId: string,
    startVersion: number,
    target: keyof typeof PHASE_PATH,
  ): Promise<{ id: string; version: number }> {
    const phases = PHASE_PATH[target];
    let version = startVersion;
    for (const phase of phases) {
      const reason = (
        phase === 'GENERATING_RECIPE' ||
        phase === 'VALIDATING_RECIPE' ||
        phase === 'PREP_GUIDANCE' ||
        phase === 'COOKING_GUIDANCE' ||
        phase === 'PLATING'
      ) ? 'AGENT_TOOL' as const : 'USER_INPUT' as const;

      const s = await service.transitionTo(sessionId, version, phase as any, reason);
      version = s.version;
    }
    return { id: sessionId, version };
  }

  // ── Create session ─────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('creates a session and auto-transitions IDLE → COLLECTING_INGREDIENTS', async () => {
      const session = await service.createSession('user-1');
      expect(session.userId).toBe('user-1');
      expect(session.currentPhase).toBe('COLLECTING_INGREDIENTS');
      expect(session.status).toBe('ACTIVE');
      expect(session.version).toBe(2);
    });

    it('emits SESSION_STARTED event on creation', async () => {
      const session = await service.createSession('user-1');
      const events = await service.getSessionEvents(session.id);
      expect(events.some((e) => e.type === 'SESSION_STARTED')).toBe(true);
    });

    it('returns existing session for duplicate correlationId', async () => {
      const session1 = await service.createSession('user-1', { correlationId: 'dup-1' });
      const session2 = await service.createSession('user-1', { correlationId: 'dup-1' });
      expect(session2.id).toBe(session1.id);
      expect(session2.version).toBe(session1.version);
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('happy path — IDLE → COMPLETED', () => {
    it('completes the full cooking lifecycle', async () => {
      const session = await service.createSession('user-1', { recipeId: 'recipe-1' });
      let s = session;

      const path: Array<{ phase: string; reason: 'USER_INPUT' | 'AGENT_TOOL' }> = [
        { phase: 'CONFIRMING_INGREDIENTS', reason: 'USER_INPUT' },
        { phase: 'COLLECTING_REQUIREMENTS', reason: 'USER_INPUT' },
        { phase: 'GENERATING_RECIPE', reason: 'USER_INPUT' },
        { phase: 'VALIDATING_RECIPE', reason: 'AGENT_TOOL' },
        { phase: 'RECIPE_READY', reason: 'AGENT_TOOL' },
        { phase: 'PREP_GUIDANCE', reason: 'USER_INPUT' },
        { phase: 'COOKING_GUIDANCE', reason: 'AGENT_TOOL' },
        { phase: 'PLATING', reason: 'AGENT_TOOL' },
        { phase: 'COMPLETED', reason: 'AGENT_TOOL' },
      ];

      for (const step of path) {
        s = await service.transitionTo(s.id, s.version, step.phase as any, step.reason);
        expect(s.currentPhase).toBe(step.phase);
      }

      expect(s.status).toBe('COMPLETED');
      expect(s.completedAt).toBeDefined();

      // Verify events
      const events = await service.getSessionEvents(s.id);
      expect(events.length).toBeGreaterThanOrEqual(10);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('SESSION_STARTED');
      expect(eventTypes).toContain('RECIPE_GENERATION_STARTED');
      expect(eventTypes).toContain('RECIPE_GENERATED');
      expect(eventTypes).toContain('RECIPE_VALIDATED');
      expect(eventTypes).toContain('SESSION_COMPLETED');
    });
  });

  // ── Invalid transitions ────────────────────────────────────────────────────

  describe('invalid transitions', () => {
    it('rejects COLLECTING_INGREDIENTS → COOKING_GUIDANCE', async () => {
      const session = await service.createSession('user-1');
      await expect(
        service.transitionTo(session.id, session.version, 'COOKING_GUIDANCE', 'USER_INPUT'),
      ).rejects.toThrow(SessionError);
    });

    it('rejects COLLECTING_INGREDIENTS → PREP_GUIDANCE', async () => {
      const session = await service.createSession('user-1');
      await expect(
        service.transitionTo(session.id, session.version, 'PREP_GUIDANCE', 'USER_INPUT'),
      ).rejects.toThrow(SessionError);
    });

    it('rejects PAUSED → GENERATING_RECIPE', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      const paused = await service.pauseSession(p.id, p.version);
      await expect(
        service.transitionTo(paused.id, paused.version, 'GENERATING_RECIPE', 'USER_INPUT'),
      ).rejects.toThrow(SessionError);
    });

    it('rejects resume when not paused', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      await expect(
        service.resumeSession(p.id, p.version),
      ).rejects.toThrow(/not paused/i);
    });
  });

  // ── Pause / Resume ─────────────────────────────────────────────────────────

  describe('pause / resume', () => {
    it('pauses from PREP_GUIDANCE and resumes', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      // Advance a couple of prep steps
      let s = await service.completeCurrentStep(p.id, p.version);
      s = await service.completeCurrentStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(2);

      // Pause
      s = await service.pauseSession(s.id, s.version);
      expect(s.currentPhase).toBe('PAUSED');
      expect(s.status).toBe('PAUSED');
      expect(s.pausedAt).toBeDefined();
      expect(s.resumableState).toBeDefined();
      expect(s.resumableState!.phase).toBe('PREP_GUIDANCE');
      expect(s.resumableState!.prepStepIndex).toBe(2);

      // Resume
      s = await service.resumeSession(s.id, s.version);
      expect(s.currentPhase).toBe('PREP_GUIDANCE');
      expect(s.status).toBe('ACTIVE');
      expect(s.currentPrepStepIndex).toBe(2);
    });

    it('pauses from COOKING_GUIDANCE and resumes', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'COOKING_GUIDANCE');

      let s = await service.pauseSession(p.id, p.version);
      expect(s.currentPhase).toBe('PAUSED');
      expect(s.resumableState!.phase).toBe('COOKING_GUIDANCE');

      s = await service.resumeSession(s.id, s.version);
      expect(s.currentPhase).toBe('COOKING_GUIDANCE');
    });
  });

  // ── Substitution interruption ──────────────────────────────────────────────

  describe('substitution interruption', () => {
    it('transitions to SUBSTITUTION_REQUIRED and resumes', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.transitionTo(p.id, p.version, 'SUBSTITUTION_REQUIRED', 'USER_INPUT');
      expect(s.currentPhase).toBe('SUBSTITUTION_REQUIRED');
      expect(s.resumableState!.phase).toBe('PREP_GUIDANCE');

      s = await service.transitionTo(s.id, s.version, 'PREP_GUIDANCE', 'RECOVERY');
      expect(s.currentPhase).toBe('PREP_GUIDANCE');
    });

    it('triggers SUBSTITUTION_REQUESTED event', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      const s = await service.transitionTo(p.id, p.version, 'SUBSTITUTION_REQUIRED', 'USER_INPUT');
      const events = await service.getSessionEvents(s.id);
      expect(events.some((e) => e.type === 'SUBSTITUTION_REQUESTED')).toBe(true);
    });
  });

  // ── Timer interruption ────────────────────────────────────────────────────

  describe('timer interruption', () => {
    it('transitions to WAITING_FOR_TIMER and back', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'COOKING_GUIDANCE');

      let s = await service.transitionTo(p.id, p.version, 'WAITING_FOR_TIMER', 'AGENT_TOOL');
      expect(s.currentPhase).toBe('WAITING_FOR_TIMER');

      s = await service.transitionTo(s.id, s.version, 'COOKING_GUIDANCE', 'TIMER_COMPLETED');
      expect(s.currentPhase).toBe('COOKING_GUIDANCE');
    });
  });

  // ── Step navigation ────────────────────────────────────────────────────────

  describe('step navigation', () => {
    it('completes a prep step and advances the index', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.completeCurrentStep(p.id, p.version);
      expect(s.currentPrepStepIndex).toBe(1);

      s = await service.completeCurrentStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(2);
    });

    it('repeats a step (stays at same index)', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      const s = await service.repeatCurrentStep(p.id, p.version);
      expect(s.currentPrepStepIndex).toBe(0);

      const events = await service.getSessionEvents(s.id);
      expect(events.some((e) => e.type === 'STEP_REPEATED')).toBe(true);
    });

    it('goes to previous step', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.completeCurrentStep(p.id, p.version);
      s = await service.completeCurrentStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(2);

      s = await service.previousStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(1);

      s = await service.previousStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(0);

      // Should not go below 0
      s = await service.previousStep(s.id, s.version);
      expect(s.currentPrepStepIndex).toBe(0);
    });

    it('rejects step navigation in non-guidance phases', async () => {
      const session = await service.createSession('user-1');
      await expect(
        service.completeCurrentStep(session.id, session.version),
      ).rejects.toThrow(SessionError);
    });
  });

  // ── Error recovery ─────────────────────────────────────────────────────────

  describe('error recovery', () => {
    it('transitions to ERROR_RECOVERY and recovers', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.completeCurrentStep(p.id, p.version);
      expect(s.currentPrepStepIndex).toBe(1);

      s = await service.handleError(s.id, s.version, 'MODEL_TIMEOUT', 'AI model timed out');
      expect(s.currentPhase).toBe('ERROR_RECOVERY');
      expect(s.status).toBe('ERROR_RECOVERY');
      expect(s.resumableState!.prepStepIndex).toBe(1);

      s = await service.recoverFromError(s.id, s.version);
      expect(s.currentPhase).toBe('PREP_GUIDANCE');
      expect(s.status).toBe('ACTIVE');
      expect(s.currentPrepStepIndex).toBe(1);
    });

    it('emits ERROR_OCCURRED and ERROR_RECOVERED events', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      let s = await service.handleError(p.id, p.version, 'NETWORK', 'Network error');
      s = await service.recoverFromError(s.id, s.version);
      const events = await service.getSessionEvents(s.id);
      expect(events.some((e) => e.type === 'ERROR_OCCURRED')).toBe(true);
      expect(events.some((e) => e.type === 'ERROR_RECOVERED')).toBe(true);
    });

    it('rejects recovery when not in ERROR_RECOVERY', async () => {
      const session = await service.createSession('user-1');
      await expect(
        service.recoverFromError(session.id, session.version),
      ).rejects.toThrow(/not in error recovery/i);
    });
  });

  // ── Double-submit prevention ───────────────────────────────────────────────

  describe('double-submit prevention', () => {
    it('prevents duplicate "done" via correlationId', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.completeCurrentStep(p.id, p.version, { correlationId: 'step1-done' });
      expect(s.currentPrepStepIndex).toBe(1);

      // Duplicate — should be idempotent
      s = await service.completeCurrentStep(s.id, s.version, { correlationId: 'step1-done' });
      expect(s.currentPrepStepIndex).toBe(1);
    });

    it('prevents duplicate transition via correlationId', async () => {
      const session = await service.createSession('user-1');
      let s = await service.transitionTo(session.id, session.version, 'CONFIRMING_INGREDIENTS', 'USER_INPUT', {
        correlationId: 'to-confirm',
      });
      expect(s.currentPhase).toBe('CONFIRMING_INGREDIENTS');

      // Duplicate
      s = await service.transitionTo(s.id, s.version, 'CONFIRMING_INGREDIENTS', 'USER_INPUT', {
        correlationId: 'to-confirm',
      });
      expect(s.currentPhase).toBe('CONFIRMING_INGREDIENTS');
    });

    it('accepts independent "done" calls with different correlationIds', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.completeCurrentStep(p.id, p.version, { correlationId: 'step1' });
      expect(s.currentPrepStepIndex).toBe(1);

      s = await service.completeCurrentStep(s.id, s.version, { correlationId: 'step2' });
      expect(s.currentPrepStepIndex).toBe(2);
    });
  });

  // ── Stale request rejection ────────────────────────────────────────────────

  describe('stale request rejection', () => {
    it('rejects transition with wrong version', async () => {
      const session = await service.createSession('user-1');
      await expect(
        service.transitionTo(session.id, 999, 'CONFIRMING_INGREDIENTS', 'USER_INPUT'),
      ).rejects.toThrow(VersionConflictError);
    });

    it('rejects step completion with wrong version', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      await expect(
        service.completeCurrentStep(p.id, 999),
      ).rejects.toThrow(VersionConflictError);
    });

    it('rejects pause with wrong version', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      await expect(
        service.pauseSession(p.id, 999),
      ).rejects.toThrow(VersionConflictError);
    });
  });

  // ── Recovery scenarios ─────────────────────────────────────────────────────

  describe('recovery scenarios', () => {
    it('simulates page refresh — reloads session from store', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      let s = await service.completeCurrentStep(p.id, p.version);
      const savedId = s.id;
      const savedVersion = s.version;

      // Simulate page refresh — new service instance
      const freshService = new SessionService(store);
      const reloaded = await freshService.getSession(savedId);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.currentPhase).toBe('PREP_GUIDANCE');
      expect(reloaded!.currentPrepStepIndex).toBe(1);
      expect(reloaded!.version).toBe(savedVersion);

      // Continue where we left off
      const continued = await freshService.completeCurrentStep(savedId, reloaded!.version);
      expect(continued.currentPrepStepIndex).toBe(2);
    });

    it('simulates browser restart — restores active session', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'COOKING_GUIDANCE');
      let s = await service.pauseSession(p.id, p.version);

      const freshService = new SessionService(store);
      const active = await freshService.getActiveSession('user-1');
      expect(active).not.toBeNull();
      expect(active!.currentPhase).toBe('PAUSED');

      const resumed = await freshService.resumeSession(active!.id, active!.version);
      expect(resumed.currentPhase).toBe('COOKING_GUIDANCE');
    });

    it('handles repeated "next" without double-advancing', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      // First call with correlationId
      const result1 = await service.completeCurrentStep(p.id, p.version, { correlationId: 'rapid-next' });
      expect(result1.currentPrepStepIndex).toBe(1);

      // Duplicate with same correlationId — idempotent
      const result2 = await service.completeCurrentStep(result1.id, result1.version, { correlationId: 'rapid-next' });
      expect(result2.currentPrepStepIndex).toBe(1);
    });

    it('handles stale "done" after previous step advanced', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      let s = await service.completeCurrentStep(p.id, p.version);
      expect(s.currentPrepStepIndex).toBe(1);

      // Stale request with old version
      await expect(
        service.completeCurrentStep(s.id, s.version - 1),
      ).rejects.toThrow(VersionConflictError);
    });

    it('simulates network interruption — retry succeeds after version resync', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      let s = await service.completeCurrentStep(p.id, p.version);
      const currentVersion = s.version;

      // Stale version fails
      await expect(
        service.completeCurrentStep(s.id, currentVersion - 1),
      ).rejects.toThrow(VersionConflictError);

      // After re-fetch, retry succeeds
      const freshSession = await service.getSession(s.id);
      const retry = await service.completeCurrentStep(s.id, freshSession!.version);
      expect(retry.currentPrepStepIndex).toBe(2);
    });
  });

  // ── End session ────────────────────────────────────────────────────────────

  describe('endSession', () => {
    it('completes a session via PLATING → COMPLETED', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PLATING');
      const s = await service.transitionTo(p.id, p.version, 'COMPLETED', 'AGENT_TOOL');
      expect(s.currentPhase).toBe('COMPLETED');
      expect(s.status).toBe('COMPLETED');
    });

    it('abandons a session', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      const s = await service.endSession(p.id, p.version, { completed: false });
      expect(s.status).toBe('ABANDONED');
    });
  });

  // ── User correction ────────────────────────────────────────────────────────

  describe('user correction', () => {
    it('handles USER_CORRECTION from PREP_GUIDANCE and resumes', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');

      let s = await service.transitionTo(p.id, p.version, 'USER_CORRECTION', 'USER_INPUT');
      expect(s.currentPhase).toBe('USER_CORRECTION');

      s = await service.transitionTo(s.id, s.version, 'PREP_GUIDANCE', 'RECOVERY');
      expect(s.currentPhase).toBe('PREP_GUIDANCE');
    });
  });

  // ── Safety warning ─────────────────────────────────────────────────────────

  describe('safety warning', () => {
    it('handles SAFETY_WARNING from COOKING_GUIDANCE and resumes', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'COOKING_GUIDANCE');

      let s = await service.transitionTo(p.id, p.version, 'SAFETY_WARNING', 'SYSTEM');
      expect(s.currentPhase).toBe('SAFETY_WARNING');

      s = await service.transitionTo(s.id, s.version, 'COOKING_GUIDANCE', 'RECOVERY');
      expect(s.currentPhase).toBe('COOKING_GUIDANCE');
    });
  });

  // ── Event sourcing ─────────────────────────────────────────────────────────

  describe('event sourcing', () => {
    it('records every significant transition as an event', async () => {
      const session = await service.createSession('user-1');
      let s = session;

      s = await service.transitionTo(s.id, s.version, 'CONFIRMING_INGREDIENTS', 'USER_INPUT');
      s = await service.transitionTo(s.id, s.version, 'COLLECTING_REQUIREMENTS', 'USER_INPUT');
      s = await service.transitionTo(s.id, s.version, 'GENERATING_RECIPE', 'USER_INPUT');

      const events = await service.getSessionEvents(s.id);
      expect(events.length).toBeGreaterThanOrEqual(4);

      for (let i = 1; i < events.length; i++) {
        expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
      }
    });

    it('events have proper types and data', async () => {
      const session = await service.createSession('user-1');
      const p = await advanceToPhase(session.id, session.version, 'PREP_GUIDANCE');
      const s = await service.pauseSession(p.id, p.version);

      const events = await service.getSessionEvents(s.id);
      const pauseEvent = events.find((e) => e.type === 'SESSION_PAUSED');
      expect(pauseEvent).toBeDefined();
      expect(pauseEvent!.data).toHaveProperty('from');
      expect(pauseEvent!.data).toHaveProperty('to');
      expect(pauseEvent!.data.to).toBe('PAUSED');
    });
  });
});