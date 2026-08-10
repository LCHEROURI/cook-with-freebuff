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
  PantryStore,
  DietaryProfileStore,
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
};

export const firestoreLogStore: LogStore = {
  createLog: (log) => repo.createToolLog(log),
};

export const firestoreRecipeStore: RecipeStore = {
  createRecipe: (r) => repo.createRecipe(r),
  getRecipe: (id) => repo.getRecipe(id),
  updateRecipe: (r) => repo.updateRecipe(r),
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

/** Singleton session service over Firestore. */
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
    pantryStore: firestorePantryStore,
    dietaryProfileStore: firestoreDietaryProfileStore,
  };
}