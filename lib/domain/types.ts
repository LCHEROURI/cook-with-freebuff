// ─────────────────────────────────────────────────────────────────────────────
// Kitchen Agent — core domain types
//
// The domain model is the single source of truth for the application's
// structured data. Nothing is stored as prose; recipes, sessions, ingredients,
// steps, timers, pantry items, dietary profiles and tool logs are all typed
// objects persisted in Firestore.
// ─────────────────────────────────────────────────────────────────────────────

/** Firebase Auth user id. */
export type UserId = string;

/** Timestamp in milliseconds since epoch (server-safe across clients). */
export type EpochMs = number;

// ── Recipe ───────────────────────────────────────────────────────────────────

export interface Ingredient {
  id: string;
  name: string;
  /** Unknown quantities are explicitly null — never invented. */
  quantity: number | null;
  unit: string | null;
  /** e.g. "diced", "minced" */
  preparation?: string;
  /** e.g. "ripe", "chilled", "at room temperature" */
  condition?: string;
  optional: boolean;
}

export interface PrepStep {
  id: string;
  stepNumber: number;
  instruction: string;
  spokenInstruction: string;
  estimatedSeconds: number;
  ingredientsUsed: string[];
  equipmentUsed: string[];
}

export interface CookingStep {
  id: string;
  stepNumber: number;
  instruction: string;
  spokenInstruction: string;
  estimatedSeconds?: number;
  timerSeconds?: number;
  temperature?: number;
  temperatureUnit?: 'C' | 'F';
  heatLevel?: 'low' | 'medium-low' | 'medium' | 'medium-high' | 'high';
  ingredientsUsed: string[];
  equipmentUsed: string[];
  safetyNote?: string;
}

export interface Recipe {
  id: string;
  userId?: string;
  title: string;
  description?: string;
  servings: number;
  estimatedPrepMinutes: number;
  estimatedCookMinutes: number;
  totalMinutes: number;
  ingredients: Ingredient[];
  equipment: string[];
  prepSteps: PrepStep[];
  cookingSteps: CookingStep[];
  dietaryTags: string[];
  allergens: string[];
  safetyNotes: string[];
  generatedAt: EpochMs;
  updatedAt: EpochMs;
}

// ── Cooking session ──────────────────────────────────────────────────────────

export type SessionPhase =
  | 'IDLE'
  | 'COLLECTING_INGREDIENTS'
  | 'CONFIRMING_INGREDIENTS'
  | 'COLLECTING_REQUIREMENTS'
  | 'GENERATING_RECIPE'
  | 'VALIDATING_RECIPE'
  | 'RECIPE_READY'
  | 'PREP_GUIDANCE'
  | 'COOKING_GUIDANCE'
  | 'PLATING'
  | 'WAITING_FOR_TIMER'
  | 'PAUSED'
  | 'SUBSTITUTION_REQUIRED'
  | 'USER_CORRECTION'
  | 'SAFETY_WARNING'
  | 'COMPLETED'
  | 'ERROR_RECOVERY';

export type SessionStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ERROR_RECOVERY'
  | 'ABANDONED';

export interface CookingSession {
  id: string;
  userId: string;
  recipeId?: string;
  status: SessionStatus;
  currentPhase: SessionPhase;
  currentPrepStepIndex: number;
  currentCookingStepIndex: number;
  previousState?: SessionState;
  resumableState?: SessionState;
  activeTimerIds: string[];
  /** Ingredients the user has told us they have (collected via voice/tools). */
  availableIngredients: Ingredient[];
  startedAt: EpochMs;
  lastActivityAt: EpochMs;
  pausedAt?: EpochMs;
  completedAt?: EpochMs;
  version: number;
}

export interface SessionState {
  phase: SessionPhase;
  prepStepIndex: number;
  cookingStepIndex: number;
  activeTimerIds: string[];
}

// ── Cooking session events (event sourcing / audit trail) ───────────────────

export type SessionEventType =
  | 'SESSION_STARTED'
  | 'INGREDIENT_ADDED'
  | 'INGREDIENT_REMOVED'
  | 'INGREDIENT_CORRECTED'
  | 'RECIPE_GENERATION_STARTED'
  | 'RECIPE_GENERATED'
  | 'RECIPE_VALIDATED'
  | 'RECIPE_VALIDATION_FAILED'
  | 'STEP_STARTED'
  | 'STEP_COMPLETED'
  | 'STEP_REPEATED'
  | 'STEP_REVERSED'
  | 'SESSION_PAUSED'
  | 'SESSION_RESUMED'
  | 'TIMER_STARTED'
  | 'TIMER_COMPLETED'
  | 'TIMER_CANCELLED'
  | 'SUBSTITUTION_REQUESTED'
  | 'SUBSTITUTION_APPLIED'
  | 'SAFETY_WARNING_TRIGGERED'
  | 'ERROR_OCCURRED'
  | 'ERROR_RECOVERED'
  | 'SESSION_COMPLETED';

export interface CookingSessionEvent {
  id: string;
  sessionId: string;
  userId: string;
  type: SessionEventType;
  /** Structured payload — never secrets. */
  data: Record<string, unknown>;
  at: EpochMs;
  correlationId?: string;
}

// ── Timer ────────────────────────────────────────────────────────────────────

export type TimerStatus = 'RUNNING' | 'COMPLETED' | 'CANCELLED';

export interface CookingTimer {
  id: string;
  userId: string;
  sessionId: string;
  label: string;
  durationSeconds: number;
  startedAt: EpochMs;
  endsAt: EpochMs;
  status: TimerStatus;
  /** Optional recipe step this timer belongs to. */
  stepId?: string;
  completedAt?: EpochMs;
}

// ── Pantry ───────────────────────────────────────────────────────────────────

export type PantryItemSource =
  | 'VOICE'
  | 'MANUAL'
  | 'RECIPE_USAGE'
  | 'BARCODE'
  | 'VISION'
  | 'IMPORT';

export interface PantryItem {
  id: string;
  userId: string;
  name: string;
  quantity?: number;
  unit?: string;
  /** 0..1 — how confident we are this entry is still accurate. */
  confidence: number;
  source: PantryItemSource;
  lastConfirmedAt: EpochMs;
  expirationDate?: EpochMs;
  notes?: string;
}

// ── Dietary profile ──────────────────────────────────────────────────────────

export interface DietaryProfile {
  userId: string;
  allergies: string[];
  dietaryRestrictions: string[];
  dislikedIngredients: string[];
  preferredCuisines: string[];
  defaultServings?: number;
  preferredEquipment: string[];
  updatedAt: EpochMs;
}

// ── Agent tool log ───────────────────────────────────────────────────────────

export interface AgentToolLog {
  id: string;
  userId: string;
  sessionId?: string;
  tool: string;
  /** Sanitized — no keys, tokens or unnecessary PII. */
  sanitizedArguments: Record<string, unknown>;
  result: {
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
  };
  latencyMs: number;
  at: EpochMs;
  correlationId?: string;
}
