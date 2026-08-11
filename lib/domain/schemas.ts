// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas for the Kitchen Agent domain
//
// Every API route, tool handler, and repository validates its input/output
// against these schemas before processing or persisting. This ensures the
// structured data contract is enforced at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ── Ingredient ───────────────────────────────────────────────────────────────

export const ingredientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().positive().nullable(),
  unit: z.string().nullable(),
  preparation: z.string().optional(),
  condition: z.string().optional(),
  optional: z.boolean().default(false),
});

export type IngredientInput = z.input<typeof ingredientSchema>;

// ── Prep step ────────────────────────────────────────────────────────────────

export const prepStepSchema = z.object({
  id: z.string().min(1),
  stepNumber: z.number().int().positive(),
  instruction: z.string().min(1),
  spokenInstruction: z.string().min(1),
  estimatedSeconds: z.number().int().positive(),
  ingredientsUsed: z.array(z.string()).default([]),
  equipmentUsed: z.array(z.string()).default([]),
  safetyNote: z.string().optional(),
});

// ── Cooking step ─────────────────────────────────────────────────────────────

export const cookingStepSchema = z.object({
  id: z.string().min(1),
  stepNumber: z.number().int().positive(),
  instruction: z.string().min(1),
  spokenInstruction: z.string().min(1),
  estimatedSeconds: z.number().int().positive().optional(),
  timerSeconds: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  temperatureUnit: z.enum(['C', 'F']).optional(),
  heatLevel: z.enum(['low', 'medium-low', 'medium', 'medium-high', 'high']).optional(),
  ingredientsUsed: z.array(z.string()).default([]),
  equipmentUsed: z.array(z.string()).default([]),
  safetyNote: z.string().optional(),
});

// ── Recipe ───────────────────────────────────────────────────────────────────

export const recipeSchema = z.object({
  id: z.string().min(1),
  userId: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  servings: z.number().int().positive(),
  estimatedPrepMinutes: z.number().int().nonnegative(),
  estimatedCookMinutes: z.number().int().nonnegative(),
  totalMinutes: z.number().int().positive(),
  ingredients: z.array(ingredientSchema).min(1),
  equipment: z.array(z.string()).default([]),
  prepSteps: z.array(prepStepSchema).default([]),
  cookingSteps: z.array(cookingStepSchema).default([]),
  dietaryTags: z.array(z.string()).default([]),
  allergens: z.array(z.string()).default([]),
  safetyNotes: z.array(z.string()).default([]),
  // generatedAt/updatedAt are SERVER metadata — the model is never asked for
  // them (the generation prompt's schema omits them), so real model output
  // arrives without them. The function default stamps Date.now() at parse
  // time while keeping the fields REQUIRED in the output type (consumers
  // like transform.ts read them unconditionally).
  generatedAt: z.number().int().positive().default(() => Date.now()),
  updatedAt: z.number().int().positive().default(() => Date.now()),
});

// ── Cooking session ──────────────────────────────────────────────────────────

export const sessionPhaseSchema = z.enum([
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
]);

export const sessionStatusSchema = z.enum([
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ERROR_RECOVERY',
  'ABANDONED',
]);

export const sessionStateSchema = z.object({
  phase: sessionPhaseSchema,
  prepStepIndex: z.number().int().nonnegative(),
  cookingStepIndex: z.number().int().nonnegative(),
  activeTimerIds: z.array(z.string()).default([]),
});

export const recoveryContextSchema = z.object({
  errorCode: z.string().min(1),
  errorMessage: z.string(),
  previousState: sessionStateSchema.optional(),
  currentPhase: sessionPhaseSchema,
  currentStepIndex: z.number().int().nonnegative(),
  failedTool: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  recoverable: z.boolean(),
});

export const cookingSessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  recipeId: z.string().optional(),
  status: sessionStatusSchema,
  currentPhase: sessionPhaseSchema,
  currentPrepStepIndex: z.number().int().nonnegative(),
  currentCookingStepIndex: z.number().int().nonnegative(),
  previousState: sessionStateSchema.optional(),
  resumableState: sessionStateSchema.optional(),
  activeTimerIds: z.array(z.string()).default([]),
  availableIngredients: z.array(ingredientSchema).default([]),
  recoveryContext: recoveryContextSchema.optional(),
  pendingSubstitution: z.string().optional(),
  pendingPantryItems: z
    .array(z.object({
      itemId: z.string().min(1),
      name: z.string().min(1),
      quantity: z.number().positive().optional(),
      unit: z.string().optional(),
    }))
    .optional(),
  startedAt: z.number().int().positive(),
  lastActivityAt: z.number().int().positive(),
  pausedAt: z.number().int().positive().optional(),
  completedAt: z.number().int().positive().optional(),
  version: z.number().int().positive(),
});

// ── Cooking session event ────────────────────────────────────────────────────

export const sessionEventTypeSchema = z.enum([
  'SESSION_STARTED',
  'INGREDIENT_ADDED',
  'INGREDIENT_REMOVED',
  'INGREDIENT_CORRECTED',
  'RECIPE_GENERATION_STARTED',
  'RECIPE_GENERATED',
  'RECIPE_VALIDATED',
  'RECIPE_VALIDATION_FAILED',
  'STEP_STARTED',
  'STEP_COMPLETED',
  'STEP_REPEATED',
  'STEP_REVERSED',
  'SESSION_PAUSED',
  'SESSION_RESUMED',
  'TIMER_STARTED',
  'TIMER_COMPLETED',
  'TIMER_CANCELLED',
  'SUBSTITUTION_REQUESTED',
  'SUBSTITUTION_APPLIED',
  'SAFETY_WARNING_TRIGGERED',
  'PANTRY_ITEM_CONFIRMED',
  'ERROR_OCCURRED',
  'ERROR_RECOVERED',
  'SESSION_COMPLETED',
]);

export const cookingSessionEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  type: sessionEventTypeSchema,
  data: z.record(z.unknown()).default({}),
  at: z.number().int().positive(),
  correlationId: z.string().optional(),
});

// ── Timer ────────────────────────────────────────────────────────────────────

export const timerStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'CANCELLED']);

export const cookingTimerSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  label: z.string().min(1).max(200),
  durationSeconds: z.number().int().positive(),
  startedAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  status: timerStatusSchema,
  stepId: z.string().optional(),
  completedAt: z.number().int().positive().optional(),
});

// ── Pantry item ──────────────────────────────────────────────────────────────

export const pantryItemSourceSchema = z.enum([
  'VOICE',
  'MANUAL',
  'RECIPE_USAGE',
  'BARCODE',
  'VISION',
  'IMPORT',
]);

export const pantryItemSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().positive().optional(),
  unit: z.string().optional(),
  confidence: z.number().min(0).max(1),
  source: pantryItemSourceSchema,
  lastConfirmedAt: z.number().int().positive(),
  expirationDate: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

// ── Leftovers (K10) ──────────────────────────────────────────────────────────

export const leftoverStatusSchema = z.enum(['ACTIVE', 'CONSUMED']);

export const leftoverSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  recipeId: z.string().optional(),
  title: z.string().min(1),
  servings: z.number().int().positive(),
  completedAt: z.number().int().positive(),
  storedAt: z.number().int().positive(),
  status: leftoverStatusSchema,
  notes: z.string().optional(),
});

// ── Grocery list (K10) ───────────────────────────────────────────────────────

export const groceryItemSourceSchema = z.enum(['MANUAL', 'PANTRY_DEPLETION', 'EXPIRATION']);
export const groceryItemStatusSchema = z.enum(['OPEN', 'BOUGHT', 'DISMISSED']);

export const groceryItemSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().positive().optional(),
  unit: z.string().optional(),
  source: groceryItemSourceSchema,
  status: groceryItemStatusSchema,
  pantryItemId: z.string().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

// ── Dietary profile ──────────────────────────────────────────────────────────

export const dietaryProfileSchema = z.object({
  userId: z.string().min(1),
  allergies: z.array(z.string()).default([]),
  dietaryRestrictions: z.array(z.string()).default([]),
  dislikedIngredients: z.array(z.string()).default([]),
  preferredCuisines: z.array(z.string()).default([]),
  defaultServings: z.number().int().positive().optional(),
  preferredEquipment: z.array(z.string()).default([]),
  updatedAt: z.number().int().positive(),
});

// ── Agent tool log ───────────────────────────────────────────────────────────

export const agentToolLogSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().optional(),
  tool: z.string().min(1),
  sanitizedArguments: z.record(z.unknown()).default({}),
  result: z.object({
    success: z.boolean(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  latencyMs: z.number().int().nonnegative(),
  at: z.number().int().positive(),
  correlationId: z.string().optional(),
});

// ── Recipe request (K3 ingredient collection → K4 generation) ────────────────

export const recipeRequestSchema = z.object({
  ingredientsAvailable: z.array(ingredientSchema).min(1),
  servings: z.number().int().positive().optional(),
  maxTimeMinutes: z.number().int().positive().optional(),
  dietaryRestrictions: z.array(z.string()).default([]),
  allergies: z.array(z.string()).default([]),
  cuisinePreferences: z.array(z.string()).default([]),
  dislikedIngredients: z.array(z.string()).default([]),
  availableEquipment: z.array(z.string()).default([]),
  skillLevel: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
});

export type RecipeRequestInput = z.input<typeof recipeRequestSchema>;

// ── Tool result envelope ─────────────────────────────────────────────────────

export const toolResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      recoverable: z.boolean(),
    })
    .optional(),
});

export type ToolResult<T = unknown> = z.input<typeof toolResultSchema> & {
  data?: T;
};