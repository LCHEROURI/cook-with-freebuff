// ─────────────────────────────────────────────────────────────────────────────
// Recipe generation pipeline
//
// USER INPUT → STRUCTURED REQUEST → GENERATE → VALIDATE → CORRECT/CLARIFY →
// RECIPE READY
//
// Generation, validation, and presentation stay separate operations. The
// pipeline drives the session state machine: GENERATING_RECIPE →
// VALIDATING_RECIPE → RECIPE_READY (on success) or → COLLECTING_REQUIREMENTS
// (on validation failure / missing confirmations). The user never hears a
// recipe as approved until validation succeeds.
// ─────────────────────────────────────────────────────────────────────────────

import { recipeSchema } from '../domain/schemas';
import type { Recipe } from '../domain/types';
import type { RecipeRequest, RecipeValidationResult } from '../ai/types';
import { getRecipeGenerator, getRecipeValidator } from '../ai/provider';
import { validateRecipe } from './validate';
import type { SessionService } from '../server/session-service';

export interface PipelineSessionRef {
  id: string;
  version: number;
  service: SessionService;
}

export interface RecipeStoreLike {
  createRecipe(recipe: Recipe): Promise<void>;
}

export interface PipelineError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type PipelinePhase =
  | 'GENERATING_RECIPE'
  | 'VALIDATING_RECIPE'
  | 'RECIPE_READY'
  | 'COLLECTING_REQUIREMENTS'
  | 'ERROR';

export interface GenerationPipelineResult {
  recipe?: Recipe;
  validation?: RecipeValidationResult;
  phase: PipelinePhase;
  error?: PipelineError;
}

export interface GenerationPipelineOptions {
  request: RecipeRequest;
  session?: PipelineSessionRef;
  recipeStore?: RecipeStoreLike;
  correlationId?: string;
}

/**
 * Run the full generate → validate → decide pipeline.
 * Never throws: failures are returned as structured results.
 */
export async function runGenerationPipeline(
  options: GenerationPipelineOptions,
): Promise<GenerationPipelineResult> {
  const { request, session, recipeStore } = options;

  // 1. Enter GENERATING_RECIPE (state machine transition).
  let version = session?.version;
  if (session) {
    try {
      const s = await session.service.transitionTo(
        session.id,
        version!,
        'GENERATING_RECIPE',
        'USER_INPUT',
        { correlationId: options.correlationId },
      );
      version = s.version;
    } catch (e) {
      return { phase: 'ERROR', error: toError(e) };
    }
  }

  // 2. Generate through the provider boundary.
  const generator = getRecipeGenerator();
  if (!generator) {
    return {
      phase: 'ERROR',
      error: { code: 'GENERATION_UNAVAILABLE', message: 'No recipe generator provider is configured', recoverable: true },
    };
  }

  let recipe: Recipe;
  try {
    recipe = await generator.generate(request);
  } catch (e) {
    return { phase: 'ERROR', error: toError(e) };
  }

  // 3. Schema gate — the provider must return a structured Recipe.
  const parsed = recipeSchema.safeParse(recipe);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const validation: RecipeValidationResult = {
      valid: false,
      errors: [{ field: first?.path.join('.') ?? '(root)', message: first?.message ?? 'Invalid recipe', severity: 'error' }],
      warnings: [],
      missingConfirmations: [],
    };
    await settle(session, version, 'COLLECTING_REQUIREMENTS', options);
    return { recipe, validation, phase: 'COLLECTING_REQUIREMENTS' };
  }
  recipe = parsed.data;

  // 4. Enter VALIDATING_RECIPE.
  const afterGenerate = await settle(session, version, 'VALIDATING_RECIPE', options);
  if (afterGenerate && !afterGenerate.ok) {
    return { recipe, phase: 'ERROR', error: afterGenerate.error };
  }
  version = afterGenerate?.version;

  // 5. Validate — deterministic engine always, AI findings merged when present.
  const validation = validateRecipe(recipe, {
    availableIngredients: request.ingredientsAvailable.map((i) => i.name),
    availableEquipment: request.availableEquipment,
    allergies: request.allergies,
    dietaryRestrictions: request.dietaryRestrictions,
  });

  const aiValidator = getRecipeValidator();
  if (aiValidator) {
    try {
      const aiResult = await aiValidator.validate(recipe);
      validation.errors.push(...aiResult.errors);
      validation.warnings.push(...aiResult.warnings);
      validation.missingConfirmations.push(...aiResult.missingConfirmations);
      validation.valid = validation.errors.length === 0;
      validation.blockingErrors = validation.errors;
      validation.canPersist = validation.valid;
      validation.canList = validation.valid;
      validation.canLaunch = validation.valid;
      if (aiResult.correctedRecipe) {
        validation.correctedRecipe = aiResult.correctedRecipe;
      }
    } catch {
      // Deterministic result stands if the AI validator fails.
    }
  }

  // 6. Persist only after every blocking validation error has been ruled out.
  // Warnings and missing confirmations retain their existing nonblocking
  // persistence behavior; they are handled by the readiness decision below.
  if (recipeStore && validation.canPersist) {
    try {
      await recipeStore.createRecipe(recipe);
    } catch {
      // Persistence failure is non-fatal for generation; the recipe is still returned.
    }
  }

  // 7. Decide: approved only when valid AND nothing unconfirmed.
  const approved = validation.valid && validation.missingConfirmations.length === 0;
  const target: PipelinePhase = approved ? 'RECIPE_READY' : 'COLLECTING_REQUIREMENTS';
  const settled = await settle(session, version, target, options);
  if (settled && !settled.ok) {
    return { recipe, validation, phase: 'ERROR', error: settled.error };
  }

  return { recipe, validation, phase: approved ? 'RECIPE_READY' : 'COLLECTING_REQUIREMENTS' };
}

type SettleResult =
  | { ok: true; version: number }
  | { ok: false; error: PipelineError };

async function settle(
  session: PipelineSessionRef | undefined,
  version: number | undefined,
  phase: 'GENERATING_RECIPE' | 'VALIDATING_RECIPE' | 'RECIPE_READY' | 'COLLECTING_REQUIREMENTS',
  options: GenerationPipelineOptions,
): Promise<SettleResult | undefined> {
  if (!session) return undefined;
  try {
    const s = await session.service.transitionTo(
      session.id,
      version!,
      phase,
      phase === 'RECIPE_READY' || phase === 'VALIDATING_RECIPE' ? 'AGENT_TOOL' : 'USER_INPUT',
      { correlationId: options.correlationId },
    );
    return { ok: true, version: s.version };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

function toError(e: unknown): PipelineError {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string' &&
    'recoverable' in e
  ) {
    const err = e as { code: string; message: string; recoverable: boolean };
    return { code: err.code, message: err.message, recoverable: err.recoverable };
  }
  return { code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : String(e), recoverable: true };
}
