// ============================================================================
// lib/server/store-seam.ts — the cutover machinery (spec 0005 phase 3).
//
// Three stages per store, enforced in this order:
//
//   1. Firestore only    — today's behavior; no SQL Connect involvement.
//   2. Dual-write        — writes go to Firestore (authoritative) and the
//                          SQL Connect twin (best-effort: a twin failure is
//                          logged loudly but never breaks the user path;
//                          the backfill reconciles any drift). Reads stay on
//                          Firestore. This is the backfill window.
//   3. Flip reads        — reads move to the twin while dual-write continues,
//                          so instances that have not yet redeployed still
//                          land their writes in both backends during a
//                          rolling deploy.
//
// The fence: a store cannot be flipped unless dual-write is enabled for it.
// Enforced at boot (module evaluation), so a misconfigured deploy fails
// loudly instead of silently dropping writes accepted during rollout.
//
// The event plane is independent of the session plane: createEvent and
// listSessionEvents can cut over (or dual-write) separately from session
// rows and correlation markers, because splitSessionStore routes them to
// different backends while keeping marker mutations atomic with session
// updates on the session plane.
// ============================================================================

import 'server-only';
import type {
  CookingSession,
  CookingSessionEvent,
  CookingTimer,
  Recipe,
  AgentToolLog,
  PantryItem,
  DietaryProfile,
  Leftover,
  GroceryItem,
} from '../domain/types';
import type { SessionStore } from './session-service';
import type {
  TimerStore,
  LogStore,
  RecipeStore,
  PantryStore,
  DietaryProfileStore,
  LeftoverStore,
  GroceryStore,
} from './tools/types';

export type ReadSource = 'primary' | 'secondary';

/**
 * Run a secondary (twin) write without letting its failure break the user
 * path. Firestore stays authoritative during dual-write; a twin failure is
 * logged loudly (the backfill and the verification queries reconcile drift),
 * and the primary result is returned regardless.
 */
async function bestEffort(
  store: string,
  op: string,
  identity: Record<string, string>,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    // Keep the primary path available, but emit a machine-readable drift
    // record containing enough identity for the backfill to reconcile the
    // exact row. Do not include the complete payload: recipes and profiles
    // can contain user data, and logs are not a durable retry queue.
    console.error('[dual-write] secondary write failed', {
      event: 'sqlconnect_dual_write_drift',
      store,
      operation: op,
      ...identity,
      error: err instanceof Error ? err.message : String(err),
      primary: 'firestore',
      action: 'backfill_required',
    });
  }
}

/**
 * Parse a comma separated store list from the environment. Whitespace around
 * entries and empty entries (a trailing comma, a double comma) are tolerated
 * so a hand-edited config value cannot half-select a store by surprise.
 */
export function parseStoreList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * The cutover fence: a store listed in STORES_ON_SQLCONNECT (flip reads) must
 * also be listed in STORES_DUAL_WRITE, or boot fails. This enforces the spec's
 * stage order — dual-write during cutover, backfill, then flip — so reads can
 * never move to the twin while other instances (or the backfill window) still
 * write to Firestore only.
 */
export function assertCutoverFence(flip: Set<string>, dual: Set<string>): void {
  for (const store of flip) {
    if (!dual.has(store)) {
      throw new Error(
        `STORES_ON_SQLCONNECT includes "${store}" but STORES_DUAL_WRITE does not. ` +
          'A store cannot switch reads to SQL Connect without the dual-write stage ' +
          '(enable dual-write, backfill, verify, then flip reads): writes accepted ' +
          'during a rolling deploy would land only in Firestore and vanish from ' +
          'SQL Connect reads.',
      );
    }
  }
}

// ── Dual-write wrappers: simple stores ───────────────────────────────────────
//
// Writes: primary (authoritative) then secondary (best-effort).
// Reads: from `readsFrom`, so flipping reads is the same wrapper with a
// different argument — one code path per store, two stages.

export function dualTimerStore(
  primary: TimerStore,
  secondary: TimerStore,
  readsFrom: ReadSource,
): TimerStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    createTimer: async (timer: CookingTimer) => {
      await primary.createTimer(timer);
      await bestEffort('timers', 'createTimer', { id: timer.id, sessionId: timer.sessionId }, () => secondary.createTimer(timer));
    },
    getTimer: (id) => reads().getTimer(id),
    updateTimer: async (id, partial) => {
      await primary.updateTimer(id, partial);
      await bestEffort('timers', 'updateTimer', { id }, () => secondary.updateTimer(id, partial));
    },
    listActiveTimers: (sessionId) => reads().listActiveTimers(sessionId),
    rebaseActiveTimers: async (sessionId, elapsedMs) => {
      await primary.rebaseActiveTimers(sessionId, elapsedMs);
      await bestEffort('timers', 'rebaseActiveTimers', { sessionId }, () =>
        secondary.rebaseActiveTimers(sessionId, elapsedMs),
      );
    },
  };
}

export function dualLogStore(primary: LogStore, secondary: LogStore): LogStore {
  return {
    createLog: async (log: AgentToolLog) => {
      await primary.createLog(log);
      await bestEffort('logs', 'createLog', { id: log.id }, () => secondary.createLog(log));
    },
  };
}

export function dualRecipeStore(
  primary: RecipeStore,
  secondary: RecipeStore,
  readsFrom: ReadSource,
): RecipeStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    createRecipe: async (recipe: Recipe) => {
      await primary.createRecipe(recipe);
      await bestEffort('recipes', 'createRecipe', { id: recipe.id, ...(recipe.userId ? { userId: recipe.userId } : {}) }, () => secondary.createRecipe(recipe));
    },
    getRecipe: (id) => reads().getRecipe(id),
    updateRecipe: async (recipe: Recipe) => {
      await primary.updateRecipe(recipe);
      await bestEffort('recipes', 'updateRecipe', { id: recipe.id, ...(recipe.userId ? { userId: recipe.userId } : {}) }, () => secondary.updateRecipe(recipe));
    },
    listRecipes: (userId) => reads().listRecipes(userId),
    deleteRecipe: async (id: string) => {
      await primary.deleteRecipe(id);
      await bestEffort('recipes', 'deleteRecipe', { id }, () => secondary.deleteRecipe(id));
    },
  };
}

export function dualPantryStore(
  primary: PantryStore,
  secondary: PantryStore,
  readsFrom: ReadSource,
): PantryStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    listItems: (userId) => reads().listItems(userId),
    getItem: (id) => reads().getItem(id),
    upsertItem: async (item: PantryItem) => {
      await primary.upsertItem(item);
      await bestEffort('pantry', 'upsertItem', { id: item.id, userId: item.userId }, () => secondary.upsertItem(item));
    },
    deleteItem: async (id: string) => {
      await primary.deleteItem(id);
      await bestEffort('pantry', 'deleteItem', { id }, () => secondary.deleteItem(id));
    },
  };
}

export function dualDietaryProfileStore(
  primary: DietaryProfileStore,
  secondary: DietaryProfileStore,
  readsFrom: ReadSource,
): DietaryProfileStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    getProfile: (userId) => reads().getProfile(userId),
    upsertProfile: async (profile: DietaryProfile) => {
      await primary.upsertProfile(profile);
      await bestEffort('dietaryProfiles', 'upsertProfile', { userId: profile.userId }, () =>
        secondary.upsertProfile(profile),
      );
    },
  };
}

export function dualLeftoverStore(
  primary: LeftoverStore,
  secondary: LeftoverStore,
  readsFrom: ReadSource,
): LeftoverStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    createLeftover: async (leftover: Leftover) => {
      await primary.createLeftover(leftover);
      await bestEffort('leftovers', 'createLeftover', { id: leftover.id, userId: leftover.userId }, () => secondary.createLeftover(leftover));
    },
    getLeftover: (id) => reads().getLeftover(id),
    listLeftovers: (userId) => reads().listLeftovers(userId),
    updateLeftover: async (id, partial) => {
      await primary.updateLeftover(id, partial);
      await bestEffort('leftovers', 'updateLeftover', { id }, () =>
        secondary.updateLeftover(id, partial),
      );
    },
  };
}

export function dualGroceryStore(
  primary: GroceryStore,
  secondary: GroceryStore,
  readsFrom: ReadSource,
): GroceryStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    createGroceryItem: async (item: GroceryItem) => {
      await primary.createGroceryItem(item);
      await bestEffort('grocery', 'createGroceryItem', { id: item.id, userId: item.userId }, () => secondary.createGroceryItem(item));
    },
    getGroceryItem: (id) => reads().getGroceryItem(id),
    listGroceryItems: (userId) => reads().listGroceryItems(userId),
    updateGroceryItem: async (id, partial) => {
      await primary.updateGroceryItem(id, partial);
      await bestEffort('grocery', 'updateGroceryItem', { id }, () =>
        secondary.updateGroceryItem(id, partial),
      );
    },
    deleteGroceryItem: async (id: string) => {
      await primary.deleteGroceryItem(id);
      await bestEffort('grocery', 'deleteGroceryItem', { id }, () => secondary.deleteGroceryItem(id));
    },
  };
}

// ── Dual-write wrappers: the session store's two planes ──────────────────────

/**
 * Dual-write the session plane (rows, version-guarded updates, correlation
 * markers). The secondary's expectedVersion is the version the caller
 * expected on the primary: kept in lockstep, the twin is at the same
 * version, so the guarded write advances it identically; a twin that lagged
 * (a previous secondary failure) conflicts and is logged for the backfill.
 *
 * Event methods delegate to the primary — unreachable when composed through
 * splitSessionStore, which routes the event plane separately.
 */
export function dualSessionCore(
  primary: SessionStore,
  secondary: SessionStore,
  readsFrom: ReadSource,
): SessionStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    getSession: (id) => reads().getSession(id),
    createSession: async (session: CookingSession) => {
      await primary.createSession(session);
      await bestEffort('sessions', 'createSession', { id: session.id, userId: session.userId }, () => secondary.createSession(session));
    },
    updateSession: async (
      id: string,
      partial: Partial<CookingSession>,
      expectedVersion: number,
      marker?: { mark?: string | string[]; clear?: string },
    ): Promise<CookingSession> => {
      const updated = await primary.updateSession(id, partial, expectedVersion, marker);
      await bestEffort('sessions', 'updateSession', { id }, () =>
        secondary.updateSession(id, partial, expectedVersion, marker),
      );
      return updated;
    },
    getActiveSession: (userId) => reads().getActiveSession(userId),
    createEvent: (event: CookingSessionEvent) => primary.createEvent(event),
    listSessionEvents: (sessionId) => primary.listSessionEvents(sessionId),
    hasCorrelationMarker: (id) => reads().hasCorrelationMarker(id),
    markCorrelationMarker: async (id) => {
      await primary.markCorrelationMarker(id);
      await bestEffort('sessions', 'markCorrelationMarker', { markerId: id }, () =>
        secondary.markCorrelationMarker(id),
      );
    },
    clearCorrelationMarker: async (id) => {
      await primary.clearCorrelationMarker(id);
      await bestEffort('sessions', 'clearCorrelationMarker', { markerId: id }, () =>
        secondary.clearCorrelationMarker(id),
      );
    },
  };
}

/**
 * Dual-write the event plane only. Unreachable methods delegate to the
 * primary; splitSessionStore routes only createEvent and listSessionEvents
 * here.
 */
export function dualEventStore(
  primary: SessionStore,
  secondary: SessionStore,
  readsFrom: ReadSource,
): SessionStore {
  const reads = () => (readsFrom === 'secondary' ? secondary : primary);
  return {
    getSession: (id) => primary.getSession(id),
    createSession: (session: CookingSession) => primary.createSession(session),
    updateSession: (
      id: string,
      partial: Partial<CookingSession>,
      expectedVersion: number,
      marker?: { mark?: string | string[]; clear?: string },
    ) => primary.updateSession(id, partial, expectedVersion, marker),
    getActiveSession: (userId) => primary.getActiveSession(userId),
    createEvent: async (event: CookingSessionEvent) => {
      await primary.createEvent(event);
      await bestEffort('events', 'createEvent', { id: event.id, sessionId: event.sessionId }, () => secondary.createEvent(event));
    },
    listSessionEvents: (sessionId) => reads().listSessionEvents(sessionId),
    hasCorrelationMarker: (id) => primary.hasCorrelationMarker(id),
    markCorrelationMarker: (id) => primary.markCorrelationMarker(id),
    clearCorrelationMarker: (id) => primary.clearCorrelationMarker(id),
  };
}

/**
 * Route the session plane and the event plane to different backends. The
 * session plane owns rows, the version guard, and correlation markers (so
 * marker mutations stay atomic with session updates); the event plane owns
 * createEvent and listSessionEvents only.
 */
export function splitSessionStore(sessions: SessionStore, events: SessionStore): SessionStore {
  return {
    getSession: (id) => sessions.getSession(id),
    createSession: (session) => sessions.createSession(session),
    updateSession: (id, partial, expectedVersion, marker) =>
      sessions.updateSession(id, partial, expectedVersion, marker),
    getActiveSession: (userId) => sessions.getActiveSession(userId),
    createEvent: (event) => events.createEvent(event),
    listSessionEvents: (sessionId) => events.listSessionEvents(sessionId),
    hasCorrelationMarker: (id) => sessions.hasCorrelationMarker(id),
    markCorrelationMarker: (id) => sessions.markCorrelationMarker(id),
    clearCorrelationMarker: (id) => sessions.clearCorrelationMarker(id),
  };
}
