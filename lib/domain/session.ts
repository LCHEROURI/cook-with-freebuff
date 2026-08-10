// ─────────────────────────────────────────────────────────────────────────────
// Cooking-session state machine
//
// Formal definition of the session lifecycle. The database — not conversational
// memory — is the source of truth: a refresh or reconnect can always restore the
// user to the same phase and step via CookingSession.resumableState.
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionState, SessionPhase } from './types';

export const SESSION_PHASES: readonly SessionPhase[] = [
  'IDLE',
  'COLLECTING_INGREDIENTS',
  'CONFIRMING_INGREDIENTS',
  'COLLECTING_REQUIREMENTS',
  'GENERATING_RECIPE',
  'VALIDATING_RECIPE',
  'RECIPE_READY',
  'PREP_GUIDANCE',
  'COOKING_GUIDANCE',
  'PLATING',
  'WAITING_FOR_TIMER',
  'PAUSED',
  'SUBSTITUTION_REQUIRED',
  'USER_CORRECTION',
  'SAFETY_WARNING',
  'COMPLETED',
  'ERROR_RECOVERY',
];

/**
 * Transition reason — the machine records *why* a transition happened so the
 * recovery path can restore the exact previous context.
 */
export type TransitionReason =
  | 'USER_INPUT'
  | 'AGENT_TOOL'
  | 'TIMER_COMPLETED'
  | 'SUBSCRIPTION_STATE_CHANGED'
  | 'ERROR'
  | 'RECOVERY'
  | 'SYSTEM';

export interface Transition {
  from: SessionPhase;
  to: SessionPhase;
  reason: TransitionReason;
}

/** Allowed transitions. Anything not listed here is rejected. */
export const ALLOWED_TRANSITIONS: readonly Transition[] = [
  // Happy path
  { from: 'IDLE', to: 'COLLECTING_INGREDIENTS', reason: 'USER_INPUT' },
  { from: 'COLLECTING_INGREDIENTS', to: 'CONFIRMING_INGREDIENTS', reason: 'USER_INPUT' },
  { from: 'CONFIRMING_INGREDIENTS', to: 'COLLECTING_REQUIREMENTS', reason: 'USER_INPUT' },
  { from: 'COLLECTING_REQUIREMENTS', to: 'GENERATING_RECIPE', reason: 'USER_INPUT' },
  { from: 'GENERATING_RECIPE', to: 'VALIDATING_RECIPE', reason: 'AGENT_TOOL' },
  { from: 'VALIDATING_RECIPE', to: 'RECIPE_READY', reason: 'AGENT_TOOL' },
  { from: 'VALIDATING_RECIPE', to: 'COLLECTING_REQUIREMENTS', reason: 'USER_INPUT' },
  { from: 'RECIPE_READY', to: 'PREP_GUIDANCE', reason: 'USER_INPUT' },

  // Guidance phases
  { from: 'PREP_GUIDANCE', to: 'COOKING_GUIDANCE', reason: 'AGENT_TOOL' },
  { from: 'COOKING_GUIDANCE', to: 'PLATING', reason: 'AGENT_TOOL' },
  { from: 'PLATING', to: 'COMPLETED', reason: 'AGENT_TOOL' },

  // Interruptions
  { from: 'PREP_GUIDANCE', to: 'PAUSED', reason: 'USER_INPUT' },
  { from: 'COOKING_GUIDANCE', to: 'PAUSED', reason: 'USER_INPUT' },
  { from: 'WAITING_FOR_TIMER', to: 'PAUSED', reason: 'USER_INPUT' },
  { from: 'PAUSED', to: 'PREP_GUIDANCE', reason: 'RECOVERY' },
  { from: 'PAUSED', to: 'COOKING_GUIDANCE', reason: 'RECOVERY' },
  { from: 'PAUSED', to: 'WAITING_FOR_TIMER', reason: 'RECOVERY' },

  // Timer
  { from: 'COOKING_GUIDANCE', to: 'WAITING_FOR_TIMER', reason: 'AGENT_TOOL' },
  { from: 'WAITING_FOR_TIMER', to: 'COOKING_GUIDANCE', reason: 'TIMER_COMPLETED' },

  // Substitution
  { from: 'PREP_GUIDANCE', to: 'SUBSTITUTION_REQUIRED', reason: 'USER_INPUT' },
  { from: 'COOKING_GUIDANCE', to: 'SUBSTITUTION_REQUIRED', reason: 'USER_INPUT' },
  { from: 'SUBSTITUTION_REQUIRED', to: 'PREP_GUIDANCE', reason: 'RECOVERY' },
  { from: 'SUBSTITUTION_REQUIRED', to: 'COOKING_GUIDANCE', reason: 'RECOVERY' },

  // Corrections
  { from: 'CONFIRMING_INGREDIENTS', to: 'COLLECTING_INGREDIENTS', reason: 'USER_INPUT' },
  { from: 'PREP_GUIDANCE', to: 'USER_CORRECTION', reason: 'USER_INPUT' },
  { from: 'COOKING_GUIDANCE', to: 'USER_CORRECTION', reason: 'USER_INPUT' },
  { from: 'USER_CORRECTION', to: 'PREP_GUIDANCE', reason: 'RECOVERY' },
  { from: 'USER_CORRECTION', to: 'COOKING_GUIDANCE', reason: 'RECOVERY' },
  { from: 'USER_CORRECTION', to: 'COLLECTING_REQUIREMENTS', reason: 'RECOVERY' },

  // Safety
  { from: 'COOKING_GUIDANCE', to: 'SAFETY_WARNING', reason: 'SYSTEM' },
  { from: 'PREP_GUIDANCE', to: 'SAFETY_WARNING', reason: 'SYSTEM' },
  { from: 'SAFETY_WARNING', to: 'COOKING_GUIDANCE', reason: 'RECOVERY' },
  { from: 'SAFETY_WARNING', to: 'PREP_GUIDANCE', reason: 'RECOVERY' },

  // Errors — any operational failure can transition to ERROR_RECOVERY
  // while preserving previous state. (Handled dynamically for all phases.)
  { from: 'COMPLETED', to: 'IDLE', reason: 'USER_INPUT' },
];

/**
 * Phases that can be interrupted to PAUSED / SUBSTITUTION_REQUIRED /
 * USER_CORRECTION and restored — these carry a resumable state.
 */
export const RESUMABLE_PHASES: ReadonlySet<SessionPhase> = new Set([
  'PREP_GUIDANCE',
  'COOKING_GUIDANCE',
  'WAITING_FOR_TIMER',
  'SUBSTITUTION_REQUIRED',
  'USER_CORRECTION',
  'SAFETY_WARNING',
]);

export function isResumable(phase: SessionPhase): boolean {
  return RESUMABLE_PHASES.has(phase);
}

export interface TransitionResult {
  ok: boolean;
  to?: SessionPhase;
  error?: string;
}

/**
 * Validate a transition against the allowed-transition table.
 * Returns ok=true with the target phase when allowed, or an error string.
 */
export function canTransition(from: SessionPhase, to: SessionPhase): TransitionResult {
  if (from === to) {
    return { ok: true, to };
  }

  // ERROR_RECOVERY is reachable from any operational phase.
  if (to === 'ERROR_RECOVERY' && from !== 'ERROR_RECOVERY') {
    return { ok: true, to };
  }

  const allowed = ALLOWED_TRANSITIONS.find(
    (t) => t.from === from && t.to === to,
  );
  if (allowed) {
    return { ok: true, to };
  }

  return {
    ok: false,
    error: `Rejected transition: ${from} → ${to} is not in the allowed-transition table`,
  };
}

/**
 * Compute the next session state after a transition.
 * Preserves the resumable state across interruptions and restores it on resume.
 */
export function transitionSessionState(
  current: SessionState,
  from: SessionPhase,
  to: SessionPhase,
): { state: SessionState; resumableState?: SessionState; previousState?: SessionState } {
  const check = canTransition(from, to);
  if (!check.ok) {
    throw new Error(check.error);
  }

  // Capture the resumable state when entering an interruption.
  const interruption =
    to === 'PAUSED' ||
    to === 'SUBSTITUTION_REQUIRED' ||
    to === 'USER_CORRECTION' ||
    to === 'SAFETY_WARNING' ||
    to === 'ERROR_RECOVERY';

  const resume = from === 'PAUSED' || from === 'SUBSTITUTION_REQUIRED' || from === 'USER_CORRECTION' || from === 'SAFETY_WARNING';

  const next: SessionState = {
    phase: to,
    prepStepIndex: current.prepStepIndex,
    cookingStepIndex: current.cookingStepIndex,
    activeTimerIds: [...current.activeTimerIds],
  };

  if (interruption) {
    return { state: next, resumableState: current, previousState: current };
  }

  if (resume && current.phase === 'PAUSED') {
    // Restoring from a pause: the caller passes the persisted resumable state
    // through `current` — handled by the session service, not here.
  }

  return { state: next };
}
