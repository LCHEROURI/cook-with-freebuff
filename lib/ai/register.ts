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
import { registerRecipeGenerator, registerRecipeValidator } from './provider';

/**
 * Register Gemini providers. Returns true when registered (key present),
 * false when the key is missing (providers stay unregistered and tools
 * return *_UNAVAILABLE).
 */
export function registerGeminiProviders(opts: GeminiOptions = {}): boolean {
  const apiKey = opts.apiKey ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return false;

  registerRecipeGenerator('default', createGeminiRecipeGenerator(opts));
  registerRecipeValidator('default', createGeminiRecipeValidator(opts));
  return true;
}