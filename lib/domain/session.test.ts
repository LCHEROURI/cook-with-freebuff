import { describe, it, expect } from 'vitest';
import {
  canTransition,
  transitionSessionState,
  isResumable,
  type SessionPhase,
} from './session';

describe('state machine — canTransition', () => {
  it('allows the happy path from IDLE to COMPLETED', () => {
    const path: [SessionPhase, SessionPhase][] = [
      ['IDLE', 'COLLECTING_INGREDIENTS'],
      ['COLLECTING_INGREDIENTS', 'CONFIRMING_INGREDIENTS'],
      ['CONFIRMING_INGREDIENTS', 'COLLECTING_REQUIREMENTS'],
      ['COLLECTING_REQUIREMENTS', 'GENERATING_RECIPE'],
      ['GENERATING_RECIPE', 'VALIDATING_RECIPE'],
      ['VALIDATING_RECIPE', 'RECIPE_READY'],
      ['RECIPE_READY', 'PREP_GUIDANCE'],
      ['PREP_GUIDANCE', 'COOKING_GUIDANCE'],
      ['COOKING_GUIDANCE', 'PLATING'],
      ['PLATING', 'COMPLETED'],
    ];
    for (const [from, to] of path) {
      expect(canTransition(from as SessionPhase, to as SessionPhase).ok).toBe(true);
    }
  });

  it('allows going back to COLLECTING_INGREDIENTS from CONFIRMING_INGREDIENTS', () => {
    expect(canTransition('CONFIRMING_INGREDIENTS', 'COLLECTING_INGREDIENTS').ok).toBe(true);
  });

  it('rejects direct IDLE → PREP_GUIDANCE', () => {
    const result = canTransition('IDLE', 'PREP_GUIDANCE');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rejected transition');
  });

  it('rejects direct COLLECTING_INGREDIENTS → COOKING_GUIDANCE', () => {
    const result = canTransition('COLLECTING_INGREDIENTS', 'COOKING_GUIDANCE');
    expect(result.ok).toBe(false);
  });

  it('allows staying in the same phase (no-op)', () => {
    expect(canTransition('PREP_GUIDANCE', 'PREP_GUIDANCE').ok).toBe(true);
  });

  it('rejects COMPLETED → PREP_GUIDANCE', () => {
    const result = canTransition('COMPLETED', 'PREP_GUIDANCE');
    expect(result.ok).toBe(false);
  });

  it('allows COMPLETED → IDLE (start over)', () => {
    expect(canTransition('COMPLETED', 'IDLE').ok).toBe(true);
  });
});

describe('state machine — pause / resume', () => {
  it('allows pausing from PREP_GUIDANCE and COOKING_GUIDANCE', () => {
    expect(canTransition('PREP_GUIDANCE', 'PAUSED').ok).toBe(true);
    expect(canTransition('COOKING_GUIDANCE', 'PAUSED').ok).toBe(true);
    expect(canTransition('WAITING_FOR_TIMER', 'PAUSED').ok).toBe(true);
  });

  it('allows resuming from PAUSED to guidance phases', () => {
    expect(canTransition('PAUSED', 'PREP_GUIDANCE').ok).toBe(true);
    expect(canTransition('PAUSED', 'COOKING_GUIDANCE').ok).toBe(true);
    expect(canTransition('PAUSED', 'WAITING_FOR_TIMER').ok).toBe(true);
  });

  it('does not allow PAUSED → GENERATING_RECIPE', () => {
    expect(canTransition('PAUSED', 'GENERATING_RECIPE').ok).toBe(false);
  });
});

describe('state machine — timer', () => {
  it('allows transitioning to and from WAITING_FOR_TIMER', () => {
    expect(canTransition('COOKING_GUIDANCE', 'WAITING_FOR_TIMER').ok).toBe(true);
    expect(canTransition('WAITING_FOR_TIMER', 'COOKING_GUIDANCE').ok).toBe(true);
  });
});

describe('state machine — substitution', () => {
  it('allows substitution from guidance phases', () => {
    expect(canTransition('PREP_GUIDANCE', 'SUBSTITUTION_REQUIRED').ok).toBe(true);
    expect(canTransition('COOKING_GUIDANCE', 'SUBSTITUTION_REQUIRED').ok).toBe(true);
  });

  it('allows restoring from SUBSTITUTION_REQUIRED', () => {
    expect(canTransition('SUBSTITUTION_REQUIRED', 'PREP_GUIDANCE').ok).toBe(true);
    expect(canTransition('SUBSTITUTION_REQUIRED', 'COOKING_GUIDANCE').ok).toBe(true);
  });
});

describe('state machine — error recovery', () => {
  it('allows ERROR_RECOVERY from any operational phase', () => {
    const operational: SessionPhase[] = [
      'COLLECTING_INGREDIENTS',
      'CONFIRMING_INGREDIENTS',
      'GENERATING_RECIPE',
      'VALIDATING_RECIPE',
      'PREP_GUIDANCE',
      'COOKING_GUIDANCE',
      'WAITING_FOR_TIMER',
      'PAUSED',
      'SUBSTITUTION_REQUIRED',
    ];
    for (const phase of operational) {
      expect(canTransition(phase, 'ERROR_RECOVERY').ok).toBe(true);
    }
  });
});

describe('state machine — user correction', () => {
  it('allows USER_CORRECTION from guidance phases', () => {
    expect(canTransition('PREP_GUIDANCE', 'USER_CORRECTION').ok).toBe(true);
    expect(canTransition('COOKING_GUIDANCE', 'USER_CORRECTION').ok).toBe(true);
  });

  it('allows restoring from USER_CORRECTION', () => {
    expect(canTransition('USER_CORRECTION', 'PREP_GUIDANCE').ok).toBe(true);
    expect(canTransition('USER_CORRECTION', 'COOKING_GUIDANCE').ok).toBe(true);
    expect(canTransition('USER_CORRECTION', 'COLLECTING_REQUIREMENTS').ok).toBe(true);
  });
});

describe('state machine — safety warning', () => {
  it('allows SAFETY_WARNING from guidance phases', () => {
    expect(canTransition('COOKING_GUIDANCE', 'SAFETY_WARNING').ok).toBe(true);
    expect(canTransition('PREP_GUIDANCE', 'SAFETY_WARNING').ok).toBe(true);
  });

  it('allows restoring from SAFETY_WARNING', () => {
    expect(canTransition('SAFETY_WARNING', 'COOKING_GUIDANCE').ok).toBe(true);
    expect(canTransition('SAFETY_WARNING', 'PREP_GUIDANCE').ok).toBe(true);
  });
});

describe('state machine — transitionSessionState', () => {
  const baseState = {
    phase: 'PREP_GUIDANCE' as SessionPhase,
    prepStepIndex: 2,
    cookingStepIndex: 0,
    activeTimerIds: ['timer-1'],
  };

  it('captures resumable state on pause', () => {
    const result = transitionSessionState(baseState, 'PREP_GUIDANCE', 'PAUSED');
    expect(result.state.phase).toBe('PAUSED');
    expect(result.resumableState).toBeDefined();
    expect(result.resumableState!.prepStepIndex).toBe(2);
  });

  it('captures resumable state on substitution', () => {
    const result = transitionSessionState(baseState, 'PREP_GUIDANCE', 'SUBSTITUTION_REQUIRED');
    expect(result.state.phase).toBe('SUBSTITUTION_REQUIRED');
    expect(result.resumableState).toBeDefined();
  });

  it('advances phase on step-forward transition', () => {
    const result = transitionSessionState(
      { ...baseState, phase: 'COOKING_GUIDANCE' },
      'COOKING_GUIDANCE',
      'PLATING',
    );
    expect(result.state.phase).toBe('PLATING');
    // No resumable state captured for forward transitions
    expect(result.resumableState).toBeUndefined();
  });

  it('throws on invalid transition', () => {
    expect(() =>
      transitionSessionState(baseState, 'PREP_GUIDANCE', 'IDLE'),
    ).toThrow('Rejected transition');
  });
});

describe('state machine — isResumable', () => {
  it('marks guidance and interruption phases as resumable', () => {
    expect(isResumable('PREP_GUIDANCE')).toBe(true);
    expect(isResumable('COOKING_GUIDANCE')).toBe(true);
    expect(isResumable('WAITING_FOR_TIMER')).toBe(true);
    expect(isResumable('SUBSTITUTION_REQUIRED')).toBe(true);
    expect(isResumable('USER_CORRECTION')).toBe(true);
    expect(isResumable('SAFETY_WARNING')).toBe(true);
  });

  it('marks collection and terminal phases as non-resumable', () => {
    expect(isResumable('IDLE')).toBe(false);
    expect(isResumable('COLLECTING_INGREDIENTS')).toBe(false);
    expect(isResumable('COMPLETED')).toBe(false);
  });
});