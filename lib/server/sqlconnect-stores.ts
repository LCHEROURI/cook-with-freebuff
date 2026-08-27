// ─────────────────────────────────────────────────────────────────────────────
// SQL Connect store twin — migration Phase 2 repository parity (spec 0005)
//
// Implements the SAME store interfaces the Firestore repositories satisfy
// (SessionStore from ./session-service; TimerStore/RecipeStore/... from
// ./tools/types), backed by the generated SQL Connect admin SDK in
// ./dataconnect (committed output of `dataconnect:compile`; regenerate with
// `cd dataconnect && npx firebase-tools dataconnect:compile`).
//
// NOT wired into stores.ts: the running app still uses Firestore. The
// cutover (spec 0005 phase 3) flips the binding behind the unchanged
// interfaces, so nothing above this layer changes.
//
// Contract parity with repositories.ts:
// - Every write is zod-validated at the boundary BEFORE any I/O (strict
//   full documents, strict partials) — the zod schemas stay the shape
//   boundary exactly as they are for Firestore.
// - Immutable fields are enforced on every write, including the upsert path
//   (Firestore set() enforced them via a pre-read; so does this twin).
// - Domain timestamps are EpochMs numbers; the SQL Connect wire type is an
//   ISO TimestampString. This layer converts in both directions.
// - updateSession keeps the optimistic-concurrency contract: a version
//   mismatch throws an Error matching /version conflict/i (the session
//   service wraps it in VersionConflictError), and the correlation marker
//   rides the SAME transaction via UpdateSessionWithMarker.
//
// Known deltas (documented in spec 0005 and phase verifications):
// - rebaseActiveTimers is proven by dataconnect:compile only; the local
//   emulator cannot run parameterized native SQL DML (PGLite defect).
// - Correlation markers keep the base64url key namespace only. The legacy
//   raw-id namespace does not exist here: a fresh SQL Connect database has
//   no legacy rows, and the phase 3 backfill maps any Firestore legacy doc
//   onto (key, legacyRawId), so a key lookup sees every marker.
// ============================================================================

import 'server-only';
import * as dc from './dataconnect';
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
import type {
  UserId,
  EpochMs,
  Recipe,
  CookingSession,
  CookingSessionEvent,
  CookingTimer,
  PantryItem,
  DietaryProfile,
  AgentToolLog,
  Leftover,
  GroceryItem,
} from '../domain/types';
import {
  recipeSchema,
  cookingSessionSchema,
  cookingSessionEventSchema,
  cookingTimerSchema,
  pantryItemSchema,
  dietaryProfileSchema,
  agentToolLogSchema,
  leftoverSchema,
  groceryItemSchema,
} from '../domain/schemas';

// ── Wire helpers ─────────────────────────────────────────────────────────────

function now(): EpochMs {
  return Date.now();
}

/** EpochMs → ISO TimestampString (the SDK wire type). */
function iso(ms: EpochMs): string {
  return new Date(ms).toISOString();
}

/** Nullable/optional EpochMs → nullable/optional ISO string, preserving absence. */
function isoOpt(ms: EpochMs | null | undefined): string | null | undefined {
  return ms === undefined ? undefined : ms === null ? null : iso(ms);
}

/** ISO TimestampString → EpochMs. */
function ms(ts: string): EpochMs {
  return Date.parse(ts);
}

/**
 * Same single-segment key as repositories.markerKey (the Firestore twin).
 * Duplicated on purpose: this file must stay out of the Firestore module
 * graph so phase 4 can delete repositories.ts without touching this twin.
 */
function markerKey(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/**
 * Same immutable-field contract as repositories.assertImmutableFields. A
 * proposed change (or a complete document) may not alter any listed field.
 */
function assertImmutableFields<T extends object>(
  current: T,
  proposed: Partial<T>,
  fields: readonly (keyof T)[],
): void {
  const currentRecord = current as Record<keyof T, unknown>;
  const proposedRecord = proposed as Record<keyof T, unknown>;
  for (const field of fields) {
    const fieldIsProposed = Object.prototype.hasOwnProperty.call(proposed, field);
    if (fieldIsProposed && !Object.is(proposedRecord[field], currentRecord[field])) {
      throw new Error(`Cannot change immutable field ${String(field)}`);
    }
  }
}

// ── Row → domain converters (ISO timestamps back to EpochMs) ─────────────────

type SessionRow = NonNullable<dc.GetCookingSessionData['cookingSession']>;
type RecipeRow = NonNullable<dc.GetRecipeData['recipe']>;
type EventRow = dc.GetSessionEventsData['cookingSessionEvents'][number];
type TimerRow = NonNullable<dc.GetCookingTimerData['cookingTimer']>;
type PantryRow = NonNullable<dc.GetPantryItemData['pantryItem']>;
type LeftoverRow = NonNullable<dc.GetLeftoverData['leftover']>;
type GroceryRow = NonNullable<dc.GetGroceryItemData['groceryItem']>;
type ProfileRow = NonNullable<dc.GetDietaryProfileData['dietaryProfile']>;

function recipeFromRow(r: RecipeRow): Recipe {
  return {
    ...r,
    userId: r.userId ?? undefined,
    proteinCategories: r.proteinCategories ?? undefined,
    preferences: r.preferences ?? undefined,
    generatedAt: ms(r.generatedAt),
    updatedAt: ms(r.updatedAt),
  } as Recipe;
}

function sessionFromRow(r: SessionRow): CookingSession {
  return {
    ...r,
    recipeId: r.recipeId ?? undefined,
    previousState: r.previousState ?? undefined,
    resumableState: r.resumableState ?? undefined,
    recoveryContext: r.recoveryContext ?? undefined,
    pendingSubstitution: r.pendingSubstitution ?? undefined,
    pendingPantryItems: r.pendingPantryItems ?? undefined,
    startedAt: ms(r.startedAt),
    lastActivityAt: ms(r.lastActivityAt),
    pausedAt: r.pausedAt == null ? undefined : ms(r.pausedAt),
    completedAt: r.completedAt == null ? undefined : ms(r.completedAt),
  } as CookingSession;
}

function eventFromRow(r: EventRow): CookingSessionEvent {
  return {
    ...r,
    correlationId: r.correlationId ?? undefined,
    at: ms(r.at),
  } as CookingSessionEvent;
}

function timerFromRow(r: TimerRow): CookingTimer {
  return {
    ...r,
    stepId: r.stepId ?? undefined,
    startedAt: ms(r.startedAt),
    endsAt: ms(r.endsAt),
    completedAt: r.completedAt == null ? undefined : ms(r.completedAt),
  } as CookingTimer;
}

function pantryFromRow(r: PantryRow): PantryItem {
  return {
    ...r,
    quantity: r.quantity ?? undefined,
    unit: r.unit ?? undefined,
    expirationDate: r.expirationDate == null ? undefined : ms(r.expirationDate),
    notes: r.notes ?? undefined,
    lastConfirmedAt: ms(r.lastConfirmedAt),
  } as PantryItem;
}

function leftoverFromRow(r: LeftoverRow): Leftover {
  return {
    ...r,
    recipeId: r.recipeId ?? undefined,
    notes: r.notes ?? undefined,
    completedAt: ms(r.completedAt),
    storedAt: ms(r.storedAt),
  } as Leftover;
}

function groceryFromRow(r: GroceryRow): GroceryItem {
  return {
    ...r,
    quantity: r.quantity ?? undefined,
    unit: r.unit ?? undefined,
    pantryItemId: r.pantryItemId ?? undefined,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  } as GroceryItem;
}

function profileFromRow(r: ProfileRow): DietaryProfile {
  return {
    ...r,
    defaultServings: r.defaultServings ?? undefined,
    updatedAt: ms(r.updatedAt),
  } as DietaryProfile;
}

// ── Shared write paths ───────────────────────────────────────────────────────

/**
 * The Firestore twin's writeValidatedDocument: set() is an UPSERT that still
 * enforces immutable fields against the existing row when one exists. Here:
 * pre-read (also surfaces not-found-shaped immutables), enforce, then upsert.
 * The pre-read + write pair is not atomic, exactly as the Firestore path's
 * read + set pair is not; the store interfaces never relied on atomicity here.
 */
async function enforceImmutablesThenUpsert<T extends object, V>(args: {
  current: T | null;
  notFoundPath: string;
  parsed: T;
  immutableFields: readonly (keyof T)[];
  write: () => Promise<V>;
}): Promise<V> {
  const { current, notFoundPath, parsed, immutableFields, write } = args;
  if (current) {
    assertImmutableFields(current, parsed, immutableFields);
  }
  void notFoundPath;
  return write();
}

/** Session fields the connector's UpdateSession mutations accept. */
const SESSION_UPDATABLE_FIELDS = [
  'status',
  'currentPhase',
  'currentPrepStepIndex',
  'currentCookingStepIndex',
  'previousState',
  'resumableState',
  'activeTimerIds',
  'availableIngredients',
  'recoveryContext',
  'pendingSubstitution',
  'pendingPantryItems',
  'pausedAt',
  'completedAt',
] as const;

/** Timer fields the connector's UpdateCookingTimer mutation accepts. */
const TIMER_UPDATABLE_FIELDS = ['status', 'completedAt', 'endsAt'] as const;

function rejectInexpressibleFields<T extends object>(
  partial: Partial<T>,
  allowed: readonly (keyof T)[],
  what: string,
): void {
  const smuggled = (Object.keys(partial) as (keyof T)[]).filter(
    (k) => !allowed.includes(k),
  );
  if (smuggled.length > 0) {
    throw new Error(
      `${what} update carries fields the connector cannot express: ${smuggled
        .map(String)
        .join(', ')}`,
    );
  }
}

// ── Session store (SessionStore from ./session-service) ──────────────────────

export const sqlconnectSessionStore: SessionStore = {
  async getSession(id) {
    const res = await dc.getCookingSession({ id });
    return res.data?.cookingSession ? sessionFromRow(res.data.cookingSession) : null;
  },

  async createSession(s) {
    const parsed = cookingSessionSchema.strict().parse(s);
    await dc.insertCookingSession({
      id: parsed.id,
      userId: parsed.userId,
      recipeId: parsed.recipeId ?? null,
      status: parsed.status as unknown as dc.SessionStatus,
      currentPhase: parsed.currentPhase as unknown as dc.SessionPhase,
      currentPrepStepIndex: parsed.currentPrepStepIndex,
      currentCookingStepIndex: parsed.currentCookingStepIndex,
      previousState: parsed.previousState ?? null,
      resumableState: parsed.resumableState ?? null,
      activeTimerIds: parsed.activeTimerIds,
      availableIngredients: parsed.availableIngredients,
      recoveryContext: parsed.recoveryContext ?? null,
      pendingSubstitution: parsed.pendingSubstitution ?? null,
      pendingPantryItems: parsed.pendingPantryItems ?? null,
      startedAt: iso(parsed.startedAt),
      lastActivityAt: iso(parsed.lastActivityAt),
      pausedAt: isoOpt(parsed.pausedAt) ?? null,
      completedAt: isoOpt(parsed.completedAt) ?? null,
      version: parsed.version,
    });
  },

  async updateSession(id, partial, expectedVersion, marker) {
    // Parse before any I/O, exactly like the Firestore twin.
    const validatedPartial = cookingSessionSchema.partial().strict().parse(partial);

    const currentRes = await dc.getCookingSession({ id });
    if (!currentRes.data?.cookingSession) {
      throw new Error(`Session ${id} not found`);
    }
    const current = sessionFromRow(currentRes.data.cookingSession);

    // Fast path: the service pre-checks and wraps this in VersionConflictError;
    // the DB-side guard below is the authoritative backstop for races.
    if (current.version !== expectedVersion) {
      throw new Error(
        `Session ${id} version conflict: expected ${expectedVersion}, got ${current.version}`,
      );
    }
    assertImmutableFields(current, validatedPartial, ['id', 'userId', 'startedAt', 'version']);

    const marks = marker?.mark
      ? (Array.isArray(marker.mark) ? marker.mark : [marker.mark])
      : [];
    const distinctMarks = [...new Set(marks)];
    if (distinctMarks.length > 1) {
      throw new Error(
        'updateSession supports at most one correlation marker per transition (the connector carries a single marker write)',
      );
    }
    if (marker?.clear && distinctMarks.length === 0) {
      throw new Error(
        'updateSession cannot clear a marker without writing one (clear-only transitions are not expressible in the connector)',
      );
    }

    // lastActivityAt is stamped per update, exactly like the Firestore twin.
    const updateVars = {
      id,
      expectedVersion,
      status: validatedPartial.status as unknown as dc.SessionStatus | undefined,
      currentPhase: validatedPartial.currentPhase as unknown as dc.SessionPhase | undefined,
      currentPrepStepIndex: validatedPartial.currentPrepStepIndex,
      currentCookingStepIndex: validatedPartial.currentCookingStepIndex,
      previousState: validatedPartial.previousState ?? null,
      resumableState: validatedPartial.resumableState ?? null,
      activeTimerIds: validatedPartial.activeTimerIds ?? null,
      availableIngredients: validatedPartial.availableIngredients ?? null,
      recoveryContext: validatedPartial.recoveryContext ?? null,
      pendingSubstitution: validatedPartial.pendingSubstitution ?? null,
      pendingPantryItems: validatedPartial.pendingPantryItems ?? null,
      pausedAt: isoOpt(validatedPartial.pausedAt) ?? null,
      completedAt: isoOpt(validatedPartial.completedAt) ?? null,
      lastActivityAt: iso(now()),
    };

    // The @check guard makes session_ver null when the row was missing or the
    // version moved between our read and the write — report the conflict.
    const conflict = () =>
      new Error(
        `Session ${id} version conflict: expected ${expectedVersion}, got a concurrent update`,
      );

    if (distinctMarks.length === 1) {
      const mark = distinctMarks[0];
      const res = await dc.updateSessionWithMarker({
        ...updateVars,
        markerKey: markerKey(mark),
        markerRawId: mark,
        markedAt: iso(now()),
        // Empty key deletes no row (the connector's clear is a no-op for '').
        clearMarkerKey: marker?.clear ? markerKey(marker.clear) : '',
      });
      if (!res.data?.session_ver) throw conflict();
    } else {
      const res = await dc.updateSession(updateVars);
      if (!res.data?.session_ver) throw conflict();
    }

    // Same shape the Firestore transaction returns: the merged row this
    // update produced (the DB bumps version and took our lastActivityAt).
    return {
      ...current,
      ...validatedPartial,
      version: expectedVersion + 1,
      lastActivityAt: now(),
    } as CookingSession;
  },

  async getActiveSession(userId) {
    const res = await dc.getActiveSession({ userId });
    const top = res.data?.cookingSessions?.[0];
    return top ? sessionFromRow(top) : null;
  },

  async createEvent(e) {
    const parsed = cookingSessionEventSchema.strict().parse(e);
    await dc.insertSessionEvent({
      id: parsed.id,
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      type: parsed.type as unknown as dc.SessionEventType,
      data: parsed.data,
      at: iso(parsed.at),
      correlationId: parsed.correlationId ?? null,
    });
  },

  async listSessionEvents(sessionId) {
    const res = await dc.getSessionEvents({ sessionId });
    return (res.data?.cookingSessionEvents ?? []).map(eventFromRow);
  },

  async hasCorrelationMarker(id) {
    // A fresh SQL Connect database has no legacy raw-key rows (see header):
    // the base64url key lookup sees every marker, so no dual-namespace drain.
    const res = await dc.getCorrelationMarker({ key: markerKey(id) });
    return res.data?.correlationMarker != null;
  },

  async markCorrelationMarker(id) {
    await dc.upsertCorrelationMarker({
      key: markerKey(id),
      rawId: id,
      markedAt: iso(now()),
    });
  },

  async clearCorrelationMarker(id) {
    await dc.deleteCorrelationMarker({ key: markerKey(id) });
  },
};

// ── Timer store ───────────────────────────────────────────────────────────────

export const sqlconnectTimerStore: TimerStore = {
  async createTimer(t) {
    const parsed = cookingTimerSchema.strict().parse(t);
    await dc.insertCookingTimer({
      id: parsed.id,
      userId: parsed.userId,
      sessionId: parsed.sessionId,
      label: parsed.label,
      durationSeconds: parsed.durationSeconds,
      startedAt: iso(parsed.startedAt),
      endsAt: iso(parsed.endsAt),
      status: parsed.status as unknown as dc.TimerStatus,
      stepId: parsed.stepId ?? null,
      completedAt: isoOpt(parsed.completedAt) ?? null,
    });
  },

  async getTimer(id) {
    const res = await dc.getCookingTimer({ id });
    return res.data?.cookingTimer ? timerFromRow(res.data.cookingTimer) : null;
  },

  async updateTimer(id, partial) {
    // Validate before any I/O (the boundary repositories.test.ts locks).
    const parsedPartial = cookingTimerSchema.partial().strict().parse(partial);
    rejectInexpressibleFields(parsedPartial, TIMER_UPDATABLE_FIELDS, 'Timer');

    const currentRes = await dc.getCookingTimer({ id });
    if (!currentRes.data?.cookingTimer) {
      throw new Error(`timers/${id} not found`);
    }
    const current = timerFromRow(currentRes.data.cookingTimer);
    assertImmutableFields(current, parsedPartial, [
      'id',
      'userId',
      'sessionId',
      'startedAt',
      'durationSeconds',
    ]);

    await dc.updateCookingTimer({
      id,
      status: parsedPartial.status as unknown as dc.TimerStatus | undefined,
      completedAt: isoOpt(parsedPartial.completedAt) ?? null,
      endsAt: isoOpt(parsedPartial.endsAt) ?? null,
    });
  },

  async listActiveTimers(sessionId) {
    const res = await dc.getActiveTimers({ sessionId });
    return (res.data?.cookingTimers ?? []).map(timerFromRow);
  },

  async rebaseActiveTimers(sessionId, elapsedMs) {
    await dc.rebaseTimers({ sessionId, offsetMs: elapsedMs });
  },
};

// ── Log store ────────────────────────────────────────────────────────────────

export const sqlconnectLogStore: LogStore = {
  async createLog(log) {
    const parsed = agentToolLogSchema.strict().parse(log) as AgentToolLog;
    await dc.insertAgentToolLog({
      id: parsed.id,
      userId: parsed.userId,
      sessionId: parsed.sessionId ?? null,
      tool: parsed.tool,
      sanitizedArguments: parsed.sanitizedArguments,
      result: parsed.result,
      latencyMs: parsed.latencyMs,
      at: iso(parsed.at),
      correlationId: parsed.correlationId ?? null,
    });
  },
};

// ── Recipe store ─────────────────────────────────────────────────────────────

const RECIPE_IMMUTABLES = ['id', 'userId', 'generatedAt'] as const;

export const sqlconnectRecipeStore: RecipeStore = {
  async createRecipe(recipe) {
    const parsed = recipeSchema.strict().parse(recipe) as Recipe;
    await enforceImmutablesThenUpsert({
      current: await this.getRecipe(parsed.id),
      notFoundPath: 'recipes',
      parsed,
      immutableFields: RECIPE_IMMUTABLES,
      write: () =>
        dc.saveRecipe({
          id: parsed.id,
          userId: parsed.userId ?? null,
          title: parsed.title,
          description: parsed.description ?? null,
          servings: parsed.servings,
          estimatedPrepMinutes: parsed.estimatedPrepMinutes,
          estimatedCookMinutes: parsed.estimatedCookMinutes,
          totalMinutes: parsed.totalMinutes,
          ingredients: parsed.ingredients,
          prepSteps: parsed.prepSteps,
          cookingSteps: parsed.cookingSteps,
          equipment: parsed.equipment,
          dietaryTags: parsed.dietaryTags,
          allergens: parsed.allergens,
          safetyNotes: parsed.safetyNotes,
          proteinCategories: parsed.proteinCategories ?? null,
          preferences: parsed.preferences ?? null,
          generatedAt: iso(parsed.generatedAt),
          updatedAt: iso(parsed.updatedAt),
        }),
    });
  },

  async getRecipe(id) {
    const res = await dc.getRecipe({ id });
    return res.data?.recipe ? recipeFromRow(res.data.recipe) : null;
  },

  updateRecipe(recipe) {
    // Same upsert-with-immutables path as create (Firestore set() semantics).
    return this.createRecipe(recipe);
  },

  async listRecipes(userId) {
    const res = await dc.listRecipes({ userId });
    return (res.data?.recipes ?? []).map(recipeFromRow);
  },

  async deleteRecipe(id) {
    await dc.deleteRecipe({ id });
  },
};

// ── Pantry store ─────────────────────────────────────────────────────────────

export const sqlconnectPantryStore: PantryStore = {
  async listItems(userId) {
    const res = await dc.listPantryItems({ userId });
    return (res.data?.pantryItems ?? []).map(pantryFromRow);
  },

  async getItem(id) {
    const res = await dc.getPantryItem({ id });
    return res.data?.pantryItem ? pantryFromRow(res.data.pantryItem) : null;
  },

  async upsertItem(item) {
    const parsed = pantryItemSchema.strict().parse(item) as PantryItem;
    await enforceImmutablesThenUpsert({
      current: await this.getItem(parsed.id),
      notFoundPath: 'pantry_items',
      parsed,
      immutableFields: ['id', 'userId', 'source'] as const,
      write: () =>
        dc.upsertPantryItem({
          id: parsed.id,
          userId: parsed.userId,
          name: parsed.name,
          quantity: parsed.quantity ?? null,
          unit: parsed.unit ?? null,
          confidence: parsed.confidence,
          source: parsed.source as unknown as dc.PantryItemSource,
          lastConfirmedAt: iso(parsed.lastConfirmedAt),
          expirationDate: isoOpt(parsed.expirationDate) ?? null,
          notes: parsed.notes ?? null,
        }),
    });
  },

  async deleteItem(id) {
    await dc.deletePantryItem({ id });
  },
};

// ── Dietary profile store ────────────────────────────────────────────────────

export const sqlconnectDietaryProfileStore: DietaryProfileStore = {
  async getProfile(userId) {
    const res = await dc.getDietaryProfile({ userId });
    return res.data?.dietaryProfile ? profileFromRow(res.data.dietaryProfile) : null;
  },

  async upsertProfile(profile) {
    const parsed = dietaryProfileSchema.strict().parse(profile) as DietaryProfile;
    await enforceImmutablesThenUpsert({
      current: await this.getProfile(parsed.userId),
      notFoundPath: 'dietary_profiles',
      parsed,
      immutableFields: ['userId'] as const,
      write: () =>
        dc.upsertDietaryProfile({
          userId: parsed.userId,
          allergies: parsed.allergies,
          dietaryRestrictions: parsed.dietaryRestrictions,
          dislikedIngredients: parsed.dislikedIngredients,
          preferredCuisines: parsed.preferredCuisines,
          defaultServings: parsed.defaultServings ?? null,
          preferredEquipment: parsed.preferredEquipment,
          updatedAt: iso(parsed.updatedAt),
        }),
    });
  },
};

// ── Leftover store ───────────────────────────────────────────────────────────

export const sqlconnectLeftoverStore: LeftoverStore = {
  async createLeftover(l) {
    const parsed = leftoverSchema.strict().parse(l) as Leftover;
    await enforceImmutablesThenUpsert({
      current: await this.getLeftover(parsed.id),
      notFoundPath: 'leftovers',
      parsed,
      immutableFields: ['id', 'userId', 'recipeId', 'completedAt', 'storedAt'] as const,
      write: () =>
        dc.upsertLeftover({
          id: parsed.id,
          userId: parsed.userId,
          recipeId: parsed.recipeId ?? null,
          title: parsed.title,
          servings: parsed.servings,
          completedAt: iso(parsed.completedAt),
          storedAt: iso(parsed.storedAt),
          status: parsed.status as unknown as dc.LeftoverStatus,
          notes: parsed.notes ?? null,
        }),
    });
  },

  async getLeftover(id) {
    const res = await dc.getLeftover({ id });
    return res.data?.leftover ? leftoverFromRow(res.data.leftover) : null;
  },

  async listLeftovers(userId) {
    const res = await dc.listLeftovers({ userId });
    return (res.data?.leftovers ?? []).map(leftoverFromRow);
  },

  async updateLeftover(id, partial) {
    // Partial update against a full-row upsert: read, merge, validate, write.
    const parsedPartial = leftoverSchema.partial().strict().parse(partial);
    const currentRes = await dc.getLeftover({ id });
    if (!currentRes.data?.leftover) {
      throw new Error(`leftovers/${id} not found`);
    }
    const current = leftoverFromRow(currentRes.data.leftover);
    assertImmutableFields(current, parsedPartial, [
      'id',
      'userId',
      'recipeId',
      'completedAt',
      'storedAt',
    ]);
    const merged = leftoverSchema.strict().parse({ ...current, ...parsedPartial }) as Leftover;
    await dc.upsertLeftover({
      id: merged.id,
      userId: merged.userId,
      recipeId: merged.recipeId ?? null,
      title: merged.title,
      servings: merged.servings,
      completedAt: iso(merged.completedAt),
      storedAt: iso(merged.storedAt),
      status: merged.status as unknown as dc.LeftoverStatus,
      notes: merged.notes ?? null,
    });
  },
};

// ── Grocery store ────────────────────────────────────────────────────────────

export const sqlconnectGroceryStore: GroceryStore = {
  async createGroceryItem(i) {
    const parsed = groceryItemSchema.strict().parse(i) as GroceryItem;
    await enforceImmutablesThenUpsert({
      current: await this.getGroceryItem(parsed.id),
      notFoundPath: 'grocery_list',
      parsed,
      immutableFields: ['id', 'userId', 'source', 'pantryItemId', 'createdAt'] as const,
      write: () =>
        dc.upsertGroceryItem({
          id: parsed.id,
          userId: parsed.userId,
          name: parsed.name,
          quantity: parsed.quantity ?? null,
          unit: parsed.unit ?? null,
          source: parsed.source as unknown as dc.GroceryItemSource,
          status: parsed.status as unknown as dc.GroceryItemStatus,
          pantryItemId: parsed.pantryItemId ?? null,
          createdAt: iso(parsed.createdAt),
          updatedAt: iso(parsed.updatedAt),
        }),
    });
  },

  async getGroceryItem(id) {
    const res = await dc.getGroceryItem({ id });
    return res.data?.groceryItem ? groceryFromRow(res.data.groceryItem) : null;
  },

  async listGroceryItems(userId) {
    const res = await dc.listGroceryItems({ userId });
    return (res.data?.groceryItems ?? []).map(groceryFromRow);
  },

  async updateGroceryItem(id, partial) {
    // Partial update against a full-row upsert: read, merge, validate, write.
    const parsedPartial = groceryItemSchema.partial().strict().parse(partial);
    const currentRes = await dc.getGroceryItem({ id });
    if (!currentRes.data?.groceryItem) {
      throw new Error(`grocery_list/${id} not found`);
    }
    const current = groceryFromRow(currentRes.data.groceryItem);
    assertImmutableFields(current, parsedPartial, [
      'id',
      'userId',
      'source',
      'pantryItemId',
      'createdAt',
    ]);
    const merged = groceryItemSchema.strict().parse({ ...current, ...parsedPartial }) as GroceryItem;
    await dc.upsertGroceryItem({
      id: merged.id,
      userId: merged.userId,
      name: merged.name,
      quantity: merged.quantity ?? null,
      unit: merged.unit ?? null,
      source: merged.source as unknown as dc.GroceryItemSource,
      status: merged.status as unknown as dc.GroceryItemStatus,
      pantryItemId: merged.pantryItemId ?? null,
      createdAt: iso(merged.createdAt),
      updatedAt: iso(merged.updatedAt),
    });
  },

  async deleteGroceryItem(id) {
    await dc.deleteGroceryItem({ id });
  },
};
