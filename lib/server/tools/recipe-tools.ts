// ─────────────────────────────────────────────────────────────────────────────
// Recipe tools
//
// generate_recipe / validate_recipe go through the AI provider boundary
// (K4 wires concrete implementations). resize_recipe and replace_ingredient are
// deterministic pure transforms. find_substitution uses the substitution
// provider boundary (full workflow in K7).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recipeSchema, recipeRequestSchema } from '../../domain/schemas';
import { scaleRecipe, replaceIngredientInRecipe } from '../../recipe/transform';
import { validateRecipe } from '../../recipe/validate';
import {
  getRecipeGenerator,
  getRecipeValidator,
  getSubstitutionService,
} from '../../ai/provider';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition } from './types';
import type { Recipe, Ingredient } from '../../domain/types';
import { classifyProteins } from '../../recipe/classify';
import { evaluateGeneratedRecipeSafety } from '../recipe-safety';
import { evaluateStoredRecipeSafety } from '../recipe-safety';
import { emptyProfile } from '../profile-service';
import {
  effectiveRecipeRequest,
  hashEffectiveSafetyContext,
  hashEffectiveRecipeRequest,
  recipeGenerationMarkerId,
} from '../recipe-generation';
import type { RecipeGenerationLeaseInput } from './types';

const GENERATION_LEASE_MS = 2 * 60 * 1000;

export const generateRecipeTool: ToolDefinition = {
  name: 'generate_recipe',
  description: 'Generate a structured recipe from a structured request (AI provider boundary).',
  inputSchema: z.object({ request: recipeRequestSchema }),
  async handler(ctx, args) {
    const generator = getRecipeGenerator();
    if (!generator) {
      return fail('GENERATION_UNAVAILABLE', 'No recipe generator provider is configured', true);
    }
    const profile = (await ctx.dietaryProfileStore?.getProfile(ctx.userId)) ?? emptyProfile(ctx.userId);
    const request = effectiveRecipeRequest(args.request, profile);
    const requestHash = hashEffectiveRecipeRequest(request);
    const safetyContextHash = hashEffectiveSafetyContext(request);
    const generationStore = ctx.recipeGenerationStore;
    let lease: RecipeGenerationLeaseInput | null = null;

    if (generationStore && ctx.recipeStore && ctx.correlationId) {
      lease = {
        markerId: recipeGenerationMarkerId(ctx.userId, ctx.correlationId),
        userId: ctx.userId,
        requestHash,
        safetyContextHash,
        requestedAllergies: args.request.allergies,
        requestedDietaryRestrictions: args.request.dietaryRestrictions,
        leaseToken: randomUUID(),
        now: Date.now(),
        leaseMs: GENERATION_LEASE_MS,
      };
      const claim = await generationStore.claim(lease);
      if (claim.status === 'conflict') {
        return fail('IDEMPOTENCY_CONFLICT', 'This request key was already used for different recipe inputs', false);
      }
      if (claim.status === 'in_progress') {
        return fail('GENERATION_IN_PROGRESS', 'An identical recipe request is already being generated', true);
      }
      if (claim.status === 'completed') {
        const recipe = await ctx.recipeStore.getRecipe(claim.recipeId);
        if (!recipe || recipe.userId !== ctx.userId) {
          return fail('GENERATION_RESULT_MISSING', 'The completed recipe is no longer available', true);
        }
        const safety = evaluateStoredRecipeSafety(recipe, profile);
        if (!safety.canList) {
          return fail(
            'RECIPE_UNSAFE',
            safety.blockingErrors[0]?.message ?? 'Stored recipe did not pass current safety validation',
            true,
          );
        }
        return ok({ recipe, safety, replayed: true });
      }
    }

    const failLease = async (code: string, message: string, recoverable: boolean) => {
      if (lease && generationStore) {
        const current = await generationStore.fail({ ...lease, now: Date.now() });
        if (!current) {
          return fail('GENERATION_SUPERSEDED', 'A newer generation attempt owns this request', true);
        }
      }
      return fail(code, message, recoverable);
    };

    try {
      const recipe = await generator.generate(request);
      const parsed = recipeSchema.safeParse(recipe);
      if (!parsed.success) {
        return failLease(
          'GENERATION_INVALID',
          `Generator returned an invalid recipe: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
          true,
        );
      }
      const owned = {
        ...parsed.data,
        userId: ctx.userId,
        proteinCategories: classifyProteins(parsed.data.ingredients),
        preferences: {
          servings: request.servings ?? null,
          allergies: request.allergies,
          dietaryRestrictions: request.dietaryRestrictions,
        },
        updatedAt: parsed.data.updatedAt,
      };
      const safety = evaluateGeneratedRecipeSafety(owned, request);
      if (!safety.canPersist) {
        return failLease(
          'RECIPE_UNSAFE',
          safety.blockingErrors[0]?.message ?? 'Generated recipe did not pass safety validation',
          true,
        );
      }
      const currentProfile = (await ctx.dietaryProfileStore?.getProfile(ctx.userId))
        ?? emptyProfile(ctx.userId);
      const currentRequest = effectiveRecipeRequest(args.request, currentProfile);
      const currentSafetyContextHash = hashEffectiveSafetyContext(currentRequest);
      const currentSafety = evaluateGeneratedRecipeSafety(owned, currentRequest);
      if (!currentSafety.canPersist && currentSafetyContextHash === safetyContextHash) {
        return failLease(
          'RECIPE_UNSAFE',
          currentSafety.blockingErrors[0]?.message ?? 'Generated recipe did not pass current safety validation',
          true,
        );
      }
      if (ctx.recipeStore) {
        // Object-level ownership (K9 Part B): stamp the recipe with the
        // generating user before persisting — without userId the recipe is
        // ownerless (Firestore rules would block even its owner from reading
        // it client-side) and no isolation exists. generatedAt/updatedAt are
        // filled by the schema's function defaults (server metadata).
        //
        // Also stamp the user-provided build constraints (servings, allergies,
        // dietary restrictions) from the request, so a saved recipe records
        // what it was built FOR — the /cook "Your recipes" rows surface them.
        if (lease && generationStore) {
          const completed = await generationStore.complete({
            ...lease,
            now: Date.now(),
            recipe: owned,
            currentSafetyContextHash,
          });
          if (completed.status === 'safety_context_changed') {
            return fail(
              'SAFETY_CONTEXT_CHANGED',
              'Your allergy or dietary profile changed during generation. Please try again.',
              true,
            );
          }
          if (completed.status === 'superseded') {
            return fail('GENERATION_SUPERSEDED', 'A newer generation attempt owns this request', true);
          }
        } else {
          if (!currentSafety.canPersist) {
            return fail(
              'RECIPE_UNSAFE',
              currentSafety.blockingErrors[0]?.message ?? 'Generated recipe did not pass current safety validation',
              true,
            );
          }
          await ctx.recipeStore.createRecipe(owned);
        }
        return ok({ recipe: owned, safety: currentSafety });
      }
      return ok({ recipe: owned, safety: currentSafety });
    } catch (e) {
      if (lease && generationStore) {
        try {
          const current = await generationStore.fail({ ...lease, now: Date.now() });
          if (!current) {
            return fail('GENERATION_SUPERSEDED', 'A newer generation attempt owns this request', true);
          }
        } catch {
          // Preserve the original provider/store error if failure recording is unavailable.
        }
      }
      return toToolError(e);
    }
  },
};

export const validateRecipeTool: ToolDefinition = {
  name: 'validate_recipe',
  description: 'Validate a recipe against the full K4 check list (deterministic engine, AI findings merged when configured).',
  inputSchema: z.object({
    recipe: recipeSchema,
    availableIngredients: z.array(z.string()).optional(),
    availableEquipment: z.array(z.string()).optional(),
    allergies: z.array(z.string()).optional(),
    dietaryRestrictions: z.array(z.string()).optional(),
  }),
  async handler(_ctx, args) {
    const engine = validateRecipe(args.recipe, {
      availableIngredients: args.availableIngredients,
      availableEquipment: args.availableEquipment,
      allergies: args.allergies,
      dietaryRestrictions: args.dietaryRestrictions,
    });

    // Layer AI semantic findings on top when a validator provider is configured.
    const aiValidator = getRecipeValidator();
    if (aiValidator) {
      try {
        const aiResult = await aiValidator.validate(args.recipe);
        engine.errors.push(...aiResult.errors);
        engine.warnings.push(...aiResult.warnings);
        engine.missingConfirmations.push(...aiResult.missingConfirmations);
        engine.valid = engine.errors.length === 0;
        if (aiResult.correctedRecipe) engine.correctedRecipe = aiResult.correctedRecipe;
      } catch {
        // Deterministic result stands if the AI validator fails.
      }
    }

    return ok(engine);
  },
};

export const resizeRecipeTool: ToolDefinition = {
  name: 'resize_recipe',
  description: 'Scale a recipe to a new serving count (deterministic quantity scaling).',
  inputSchema: z.object({
    recipe: recipeSchema,
    servings: z.number().int().positive(),
  }),
  async handler(_ctx, args) {
    try {
      const scaled = scaleRecipe(args.recipe, args.servings);
      return ok({ recipe: scaled });
    } catch (e) {
      return fail('INVALID_SERVINGS', e instanceof Error ? e.message : 'Invalid servings', false);
    }
  },
};

export const findSubstitutionTool: ToolDefinition = {
  name: 'find_substitution',
  description: 'Find viable alternatives for an unavailable ingredient (provider boundary).',
  inputSchema: z.object({
    unavailableIngredient: z.string().min(1),
    recipe: recipeSchema,
    availablePantry: z.array(z.string()).default([]),
  }),
  async handler(_ctx, args) {
    const service = getSubstitutionService();
    if (!service) {
      return fail('SUBSTITUTION_UNAVAILABLE', 'No substitution provider is configured', true);
    }
    try {
      const candidates = await service.findSubstitution({
        unavailableIngredient: args.unavailableIngredient,
        recipe: args.recipe,
        availablePantry: args.availablePantry,
      });
      return ok({ candidates });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const replaceIngredientTool: ToolDefinition = {
  name: 'replace_ingredient',
  description: 'Replace an ingredient throughout the recipe (deterministic) — never silent, always explicit.',
  inputSchema: z.object({
    recipe: recipeSchema,
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  async handler(_ctx, args) {
    const updated = replaceIngredientInRecipe(args.recipe, args.from, args.to);
    const parsed = recipeSchema.safeParse(updated);
    if (!parsed.success) {
      return fail('REPLACEMENT_INVALID', 'Replacement produced an invalid recipe', false);
    }
    return ok({ recipe: parsed.data });
  },
};

// ── Shared ingredient helper for future tools ────────────────────────────────

export type { Ingredient, Recipe };
