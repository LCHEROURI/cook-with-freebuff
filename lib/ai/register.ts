// ─────────────────────────────────────────────────────────────────────────────
// Provider registration (bootstrap)
//
// Registers the concrete Gemini providers under the 'default' name when a
// Google AI API key is present in the environment. Safe to call on every
// server boot — no-ops when the key is missing.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createGeminiRecipeGenerator,
  createGeminiRecipeValidator,
  type GeminiOptions,
} from './gemini';
import { createGeminiConversationAgent } from './conversation';
import { findSubstitutionCandidates } from '../recipe/substitute';
import {
  registerRecipeGenerator,
  registerRecipeValidator,
  registerConversationAgent,
  registerSubstitutionService,
} from './provider';

/**
 * Register providers.
 *
 * The deterministic substitution engine is always registered — substitutions
 * must work without an AI key (K7). The Gemini providers are registered only
 * when a Google AI API key is present; without it, generation/validation tools
 * return *_UNAVAILABLE.
 */
export function registerGeminiProviders(
  opts: GeminiOptions = {},
  deps: { resolveModel?: (role: string) => Promise<string | undefined> } = {},
): boolean {
  // Deterministic substitution is key-independent.
  registerSubstitutionService('default', {
    async findSubstitution({ unavailableIngredient, recipe, availablePantry }) {
      return findSubstitutionCandidates(recipe, unavailableIngredient, availablePantry);
    },
  });

  const apiKey = opts.apiKey ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return false;

  // Remote Config model resolver (injected by lib/server/stores.ts); an
  // explicit opts.resolveModel wins for tests/direct callers.
  const resolveModel = opts.resolveModel ?? deps.resolveModel;

  registerRecipeGenerator('default', createGeminiRecipeGenerator({ ...opts, resolveModel }));
  registerRecipeValidator('default', createGeminiRecipeValidator({ ...opts, resolveModel }));
  registerConversationAgent('default', createGeminiConversationAgent({ ...opts, resolveModel }));
  return true;
}