// ─────────────────────────────────────────────────────────────────────────────
// Recipe tools
//
// generate_recipe / validate_recipe go through the AI provider boundary
// (K4 wires concrete implementations). resize_recipe and replace_ingredient are
// deterministic pure transforms. find_substitution uses the substitution
// provider boundary (full workflow in K7).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
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

export const generateRecipeTool: ToolDefinition = {
  name: 'generate_recipe',
  description: 'Generate a structured recipe from a structured request (AI provider boundary).',
  inputSchema: z.object({ request: recipeRequestSchema }),
  async handler(ctx, args) {
    const generator = getRecipeGenerator();
    if (!generator) {
      return fail('GENERATION_UNAVAILABLE', 'No recipe generator provider is configured', true);
    }
    try {
      const recipe = await generator.generate(args.request);
      const parsed = recipeSchema.safeParse(recipe);
      if (!parsed.success) {
        return fail(
          'GENERATION_INVALID',
          `Generator returned an invalid recipe: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
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
        const owned = {
          ...parsed.data,
          userId: ctx.userId,
          proteinCategories: classifyProteins(parsed.data.ingredients),
          preferences: {
            servings: args.request.servings ?? null,
            allergies: args.request.allergies,
            dietaryRestrictions: args.request.dietaryRestrictions,
          },
          updatedAt: parsed.data.updatedAt,
        };
        await ctx.recipeStore.createRecipe(owned);
        return ok({ recipe: owned });
      }
      return ok({ recipe: parsed.data });
    } catch (e) {
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