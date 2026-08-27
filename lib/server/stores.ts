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
  LeftoverStore,
  GroceryStore,
} from './tools/types';
import { registerGeminiProviders } from '../ai/register';
import { resolveGeminiModel, logModelResolutionSources, type GeminiModelRole } from './model-config';
import * as sqlconnect from './sqlconnect-stores';
import {
  assertCutoverFence,
  dualDietaryProfileStore,
  dualEventStore,
  dualGroceryStore,
  dualLeftoverStore,
  dualLogStore,
  dualPantryStore,
  dualRecipeStore,
  dualSessionCore,
  dualTimerStore,
  parseStoreList,
  splitSessionStore,
  type ReadSource,
} from './store-seam';

// ── Cutover seam (spec 0005 phase 3) ─────────────────────────────────────────
//
// Two comma separated config values move a store through the spec's three
// stages with zero call-site edits (the store interfaces are identical, so
// the agent, tool, and session-service layers cannot tell which backend
// answered):
//
//   STORES_DUAL_WRITE=recipes,pantry  writes go to Firestore (authoritative)
//                                     AND the twin (best-effort, logged on
//                                     failure; the backfill reconciles
//                                     drift). Reads stay on Firestore. This
//                                     is the backfill window.
//   STORES_ON_SQLCONNECT=recipes      reads flip to the twin while dual-write
//                                     continues, so instances that have not
//                                     redeployed yet still write both
//                                     backends during a rolling deploy.
//
// FENCE: a store in STORES_ON_SQLCONNECT must also be in STORES_DUAL_WRITE,
// enforced at boot. Skipping the dual-write stage would let writes accepted
// during a backfill or a rolling deploy land in Firestore only and vanish
// from SQL Connect reads after cutover.
//
// Store keys: sessions, events, timers, logs, recipes, pantry,
// dietaryProfiles, leftovers, grocery. The event plane is independent of the
// session plane (splitSessionStore), so events can cut over before session
// rows and markers per the documented order; marker mutations stay atomic
// with session updates on the session plane.
const DUAL_WRITE_STORES = parseStoreList(process.env.STORES_DUAL_WRITE);
const FLIP_READS_STORES = parseStoreList(process.env.STORES_ON_SQLCONNECT);
assertCutoverFence(FLIP_READS_STORES, DUAL_WRITE_STORES);

function selectStore<T>(
  store: string,
  firestoreImpl: T,
  dual: (readsFrom: ReadSource) => T,
): T {
  // Flipped: dual-write continues (old instances) and reads come from the twin.
  if (FLIP_READS_STORES.has(store)) return dual('secondary');
  // Dual-write only: reads stay on Firestore while writes fan out to both.
  if (DUAL_WRITE_STORES.has(store)) return dual('primary');
  return firestoreImpl;
}

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

// The session store composes two independent planes: session rows, the
// version guard, and correlation markers on one side; session events on the
// other. Exporting the composed store lets the seam tests route calls
// through the real selection logic.
export const productionSessionStore: SessionStore = splitSessionStore(
  selectStore('sessions', firestoreSessionStore, (readsFrom) =>
    dualSessionCore(firestoreSessionStore, sqlconnect.sqlconnectSessionStore, readsFrom),
  ),
  selectStore('events', firestoreSessionStore, (readsFrom) =>
    dualEventStore(firestoreSessionStore, sqlconnect.sqlconnectSessionStore, readsFrom),
  ),
);

/** Singleton session service over the selected session store with durable markers. */
export const productionSessionService = new SessionService(productionSessionStore);

/** Build a ToolContext for an authenticated user. */
export function buildProductionContext(
  userId: string,
  correlationId?: string,
): ToolContext {
  return {
    userId,
    correlationId,
    sessionService: productionSessionService,
    timerStore: selectStore('timers', firestoreTimerStore, (readsFrom) =>
      dualTimerStore(firestoreTimerStore, sqlconnect.sqlconnectTimerStore, readsFrom),
    ),
    logStore: selectStore('logs', firestoreLogStore, () =>
      dualLogStore(firestoreLogStore, sqlconnect.sqlconnectLogStore),
    ),
    recipeStore: selectStore('recipes', firestoreRecipeStore, (readsFrom) =>
      dualRecipeStore(firestoreRecipeStore, sqlconnect.sqlconnectRecipeStore, readsFrom),
    ),
    pantryStore: selectStore('pantry', firestorePantryStore, (readsFrom) =>
      dualPantryStore(firestorePantryStore, sqlconnect.sqlconnectPantryStore, readsFrom),
    ),
    dietaryProfileStore: selectStore('dietaryProfiles', firestoreDietaryProfileStore, (readsFrom) =>
      dualDietaryProfileStore(
        firestoreDietaryProfileStore,
        sqlconnect.sqlconnectDietaryProfileStore,
        readsFrom,
      ),
    ),
    leftoverStore: selectStore('leftovers', firestoreLeftoverStore, (readsFrom) =>
      dualLeftoverStore(firestoreLeftoverStore, sqlconnect.sqlconnectLeftoverStore, readsFrom),
    ),
    groceryStore: selectStore('grocery', firestoreGroceryStore, (readsFrom) =>
      dualGroceryStore(firestoreGroceryStore, sqlconnect.sqlconnectGroceryStore, readsFrom),
    ),
  };
}