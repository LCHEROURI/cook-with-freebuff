// ─────────────────────────────────────────────────────────────────────────────
// lib/domain/guide.ts — client-safe API response shapes for guided cooking
//
// These are the shapes /api/cook returns to the browser. They live in the
// domain layer (pure types, no server imports) so a 'use client' module can
// import them without crossing the client/server boundary. The server module
// (lib/server/guide-service.ts) re-exports them for its own consumers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient, SessionPhase } from './types';

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
