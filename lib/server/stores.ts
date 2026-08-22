// ─────────────────────────────────────────────────────────────────────────────
// Production wiring
//
// Binds the Firestore repositories to the tool-layer store interfaces and
// builds the ToolContext used by the API route. Server-only.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import * as repo from './repositories';
import { SessionService } from './session-service';
import type { SessionStore } from './session-service';
import type {
  ToolContext,
  TimerStore,
  LogStore,
  RecipeStore,
  RecipeGenerationStore,
  PantryStore,
  DietaryProfileStore,
  LeftoverStore,
  GroceryStore,
} from './tools/types';
import { registerGeminiProviders } from '../ai/register';
import { resolveGeminiModel, logModelResolutionSources, type GeminiModelRole } from './model-config';

// Register concrete AI providers (no-op when GOOGLE_AI_API_KEY is missing).
// Model names resolve from Firebase Remote Config first, then env, then the
// hardcoded default — so a model version can change without a redeploy.
registerGeminiProviders({}, { resolveModel: (role) => resolveGeminiModel(role as GeminiModelRole) });

// Log which source supplies each model name (Remote Config / env / default)
// once at startup. Fire-and-forget: the self-check never throws and never
// blocks boot, it only emits one `model_source` line per role for the log.
void logModelResolutionSources();

export const firestoreSessionStore: SessionStore = {
  getSession: (id) => repo.getSession(id),
  createSession: (s) => repo.createSession(s),
  updateSession: (id, partial, expectedVersion, marker) =>
    repo.updateSession(id, partial, expectedVersion, marker),
  getActiveSession: (userId) => repo.getActiveSession(userId),
  createEvent: (e) => repo.createEvent(e),
  listSessionEvents: (sessionId) => repo.listSessionEvents(sessionId),
  hasCorrelationMarker: (id) => repo.hasCorrelationMarker(id),
  markCorrelationMarker: (id) => repo.markCorrelationMarker(id),
  clearCorrelationMarker: (id) => repo.clearCorrelationMarker(id),
};

export const firestoreTimerStore: TimerStore = {
  createTimer: (t) => repo.createTimer(t),
  getTimer: (id) => repo.getTimer(id),
  updateTimer: (id, partial) => repo.updateTimer(id, partial),
  listActiveTimers: (sessionId) => repo.listActiveTimers(sessionId),
  rebaseActiveTimers: (sessionId, elapsedMs) => repo.rebaseActiveTimers(sessionId, elapsedMs),
};

export const firestoreLogStore: LogStore = {
  createLog: (log) => repo.createToolLog(log),
};

export const firestoreRecipeStore: RecipeStore = {
  createRecipe: (r) => repo.createRecipe(r),
  getRecipe: (id) => repo.getRecipe(id),
  updateRecipe: (r) => repo.updateRecipe(r),
  listRecipes: (userId) => repo.listRecipes(userId),
  deleteRecipe: (id) => repo.deleteRecipe(id),
};

export const firestoreRecipeGenerationStore: RecipeGenerationStore = {
  claim: (input) => repo.claimRecipeGeneration(input),
  complete: (input) => repo.completeRecipeGeneration(input),
  fail: (input) => repo.failRecipeGeneration(input),
};

export const firestorePantryStore: PantryStore = {
  listItems: (userId) => repo.listPantryItems(userId),
  getItem: (id) => repo.getPantryItem(id),
  upsertItem: (item) => repo.createPantryItem(item),
  deleteItem: (id) => repo.deletePantryItem(id),
};

export const firestoreDietaryProfileStore: DietaryProfileStore = {
  getProfile: (userId) => repo.getDietaryProfile(userId),
  upsertProfile: (profile) => repo.upsertDietaryProfile(profile),
};

export const firestoreLeftoverStore: LeftoverStore = {
  createLeftover: (l) => repo.createLeftover(l),
  getLeftover: (id) => repo.getLeftover(id),
  listLeftovers: (userId) => repo.listLeftovers(userId),
  updateLeftover: (id, partial) => repo.updateLeftover(id, partial),
};

export const firestoreGroceryStore: GroceryStore = {
  createGroceryItem: (i) => repo.createGroceryItem(i),
  getGroceryItem: (id) => repo.getGroceryItem(id),
  listGroceryItems: (userId) => repo.listGroceryItems(userId),
  updateGroceryItem: (id, partial) => repo.updateGroceryItem(id, partial),
  deleteGroceryItem: (id) => repo.deleteGroceryItem(id),
};

/** Singleton session service over Firestore with durable markers. */
export const productionSessionService = new SessionService(firestoreSessionStore);

/** Build a ToolContext for an authenticated user. */
export function buildProductionContext(
  userId: string,
  correlationId?: string,
): ToolContext {
  return {
    userId,
    correlationId,
    sessionService: productionSessionService,
    timerStore: firestoreTimerStore,
    logStore: firestoreLogStore,
    recipeStore: firestoreRecipeStore,
    recipeGenerationStore: firestoreRecipeGenerationStore,
    pantryStore: firestorePantryStore,
    dietaryProfileStore: firestoreDietaryProfileStore,
    leftoverStore: firestoreLeftoverStore,
    groceryStore: firestoreGroceryStore,
  };
}
