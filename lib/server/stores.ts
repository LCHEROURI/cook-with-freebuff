// ─────────────────────────────────────────────────────────────────────────────
// Production wiring
//
// Binds the Firestore repositories to the tool-layer store interfaces and
// builds the ToolContext used by the API route. Server-only.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import * as repo from './repositories';
import { SessionService, type CorrelationMarkerStore } from './session-service';
import type { SessionStore } from './session-service';
import type {
  ToolContext,
  TimerStore,
  LogStore,
  RecipeStore,
  PantryStore,
  DietaryProfileStore,
  LeftoverStore,
  GroceryStore,
} from './tools/types';
import { registerGeminiProviders } from '../ai/register';

// Register concrete AI providers (no-op when GOOGLE_AI_API_KEY is missing).
registerGeminiProviders();

export const firestoreSessionStore: SessionStore = {
  getSession: (id) => repo.getSession(id),
  createSession: (s) => repo.createSession(s),
  updateSession: (id, partial, expectedVersion) => repo.updateSession(id, partial, expectedVersion),
  getActiveSession: (userId) => repo.getActiveSession(userId),
  createEvent: (e) => repo.createEvent(e),
  listSessionEvents: (sessionId) => repo.listSessionEvents(sessionId),
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

/**
 * Durable idempotency markers: processed correlation IDs survive restarts so
 * the resume-rollback uniqueness holds across server restarts, not just within
 * one process (Codex P1 chain).
 */
export const firestoreCorrelationMarkerStore: CorrelationMarkerStore = {
  has: (id) => repo.hasCorrelationMarker(id),
  mark: (id) => repo.markCorrelationMarker(id),
  clear: (id) => repo.clearCorrelationMarker(id),
};

/** Singleton session service over Firestore with durable markers. */
export const productionSessionService = new SessionService(
  firestoreSessionStore,
  firestoreCorrelationMarkerStore,
);

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
    pantryStore: firestorePantryStore,
    dietaryProfileStore: firestoreDietaryProfileStore,
    leftoverStore: firestoreLeftoverStore,
    groceryStore: firestoreGroceryStore,
  };
}