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
import {
  getRecipeGenerator,
  getRecipeValidator,
  getSubstitutionService,
} from '../../ai/provider';
import { ok, fail, toToolError } from './types';
import type { ToolDefinition } from './types';
import type { Recipe, Ingredient } from '../../domain/types';

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
        await ctx.recipeStore.createRecipe(parsed.data);
      }
      return ok({ recipe: parsed.data });
    } catch (e) {
      return toToolError(e);
    }
  },
};

export const validateRecipeTool: ToolDefinition = {
  name: 'validate_recipe',
  description: 'Validate a generated recipe (schema, consistency, safety, actionability).',
  inputSchema: z.object({ recipe: recipeSchema }),
  async handler(ctx, args) {
    const validator = getRecipeValidator();
    if (!validator) {
      return fail('VALIDATION_UNAVAILABLE', 'No recipe validator provider is configured', true);
    }
    try {
      const result = await validator.validate(args.recipe);
      return ok(result);
    } catch (e) {
      return toToolError(e);
    }
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