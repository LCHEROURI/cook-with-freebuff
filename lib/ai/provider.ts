// ─────────────────────────────────────────────────────────────────────────────
// AI provider boundary
//
// Every AI capability (recipe generation, validation, conversation) is defined
// as an interface here. Concrete implementations (Google Gemini, OpenAI, etc.)
// live in separate files and are injected through this boundary.
//
// Business logic never imports a model SDK directly.
// ─────────────────────────────────────────────────────────────────────────────

import type { Recipe, RecipeRequest, RecipeValidationResult } from './types';

/**
 * Recipe generation service — takes a structured request and returns a
 * structured Recipe object. No prose-only output.
 */
export interface RecipeGenerator {
  generate(request: RecipeRequest): Promise<Recipe>;
}

/**
 * Recipe validation service — validates a generated recipe for consistency,
 * safety, and actionability. Returns errors, warnings, and a corrected recipe
 * where applicable.
 */
export interface RecipeValidator {
  validate(recipe: Recipe): Promise<RecipeValidationResult>;
}

/**
 * Ingredient substitution service — given an unavailable ingredient and the
 * current recipe context, returns viable alternatives.
 */
export interface SubstitutionService {
  findSubstitution(params: {
    unavailableIngredient: string;
    recipe: Recipe;
    availablePantry: string[];
  }): Promise<SubstitutionCandidate[]>;
}

export interface SubstitutionCandidate {
  ingredient: string;
  ratio: string;
  notes?: string;
}

/**
 * Conversational agent — handles natural language interaction, tool selection,
 * and spoken responses.
 */
export interface ConversationAgent {
  /** Process a user utterance and return a response + any tool calls. */
  process(params: {
    userId: string;
    sessionId?: string;
    utterance: string;
    context: ConversationContext;
  }): Promise<AgentResponse>;
}

export interface ConversationContext {
  currentPhase?: string;
  currentStep?: string;
  activeTimerIds?: string[];
  recipeSummary?: string;
  recentEvents?: string[];
}

export interface AgentResponse {
  message: string;
  toolCalls?: ToolCall[];
  shouldSpeak: boolean;
}

export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

// ── Provider registry ────────────────────────────────────────────────────────

const generators = new Map<string, RecipeGenerator>();
const validators = new Map<string, RecipeValidator>();
const substitutionProviders = new Map<string, SubstitutionService>();
const conversationProviders = new Map<string, ConversationAgent>();

export function registerRecipeGenerator(name: string, impl: RecipeGenerator): void {
  generators.set(name, impl);
}

export function registerRecipeValidator(name: string, impl: RecipeValidator): void {
  validators.set(name, impl);
}

export function registerSubstitutionService(name: string, impl: SubstitutionService): void {
  substitutionProviders.set(name, impl);
}

export function registerConversationAgent(name: string, impl: ConversationAgent): void {
  conversationProviders.set(name, impl);
}

/**
 * Clear all registered providers (tests).
 */
export function resetProviders(): void {
  generators.clear();
  validators.clear();
  substitutionProviders.clear();
  conversationProviders.clear();
}

export function getRecipeGenerator(name = 'default'): RecipeGenerator | undefined {
  return generators.get(name) ?? generators.get('default');
}

export function getRecipeValidator(name = 'default'): RecipeValidator | undefined {
  return validators.get(name) ?? validators.get('default');
}

export function getSubstitutionService(name = 'default'): SubstitutionService | undefined {
  return substitutionProviders.get(name) ?? substitutionProviders.get('default');
}

export function getConversationAgent(name = 'default'): ConversationAgent | undefined {
  return conversationProviders.get(name) ?? conversationProviders.get('default');
}