// ─────────────────────────────────────────────────────────────────────────────
// Repository abstractions
//
// Every Firestore collection has a typed repository interface + a Firestore
// implementation. No raw Firestore calls outside of these modules.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import type { AnyZodObject } from 'zod';
import { getAdminDb } from './admin';
import type {
  UserId,
  Recipe,
  CookingSession,
  CookingSessionEvent,
  CookingTimer,
  PantryItem,
  DietaryProfile,
  AgentToolLog,
  Leftover,
  GroceryItem,
  EpochMs,
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
  correlationMarkerSchema,
  recipeGenerationMarkerSchema,
} from '../domain/schemas';
import type {
  RecipeGenerationClaim,
  RecipeGenerationLeaseInput,
} from './tools/types';

// ── Base Firestore helpers ───────────────────────────────────────────────────

function now(): EpochMs {
  return Date.now();
}

/**
 * Generate a random document id (Firestore auto-id behavior without hitting the
 * network). Used for idempotent client-side id generation.
 */
function randomId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ── Generic CRUD ─────────────────────────────────────────────────────────────

interface Doc<T> {
  id: string;
  data: T;
}

function assertImmutableFields<T extends object>(
  current: T,
  proposed: Partial<T>,
  fields: readonly (keyof T)[],
  completeDocument = false,
): void {
  const currentRecord = current as Record<keyof T, unknown>;
  const proposedRecord = proposed as Record<keyof T, unknown>;
  for (const field of fields) {
    const fieldIsProposed = Object.prototype.hasOwnProperty.call(proposed, field);
    if ((completeDocument || fieldIsProposed)
      && !Object.is(proposedRecord[field], currentRecord[field])) {
      throw new Error(`Cannot change immutable field ${String(field)}`);
    }
  }
}

async function writeValidatedDocument<T extends object>(
  collectionPath: string,
  id: string,
  data: T,
  schema: AnyZodObject,
  options: {
    keyField?: keyof T;
    immutableFields?: readonly (keyof T)[];
  } = {},
): Promise<void> {
  const parsed = schema.strict().parse(data) as T;
  if (options.keyField !== undefined) {
    const keyed = parsed as Record<keyof T, unknown>;
    if (keyed[options.keyField] !== id) {
      throw new Error(`${String(options.keyField)} must match document id`);
    }
  }

  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const ref = db.collection(collectionPath).doc(id);
  if (options.immutableFields?.length) {
    const snap = await ref.get();
    if (snap.exists) {
      assertImmutableFields(
        snap.data() as T,
        parsed,
        options.immutableFields,
        true,
      );
    }
  }
  await ref.set(parsed as unknown as Record<string, unknown>);
}

async function updateValidatedDocument<T extends object>(
  collectionPath: string,
  id: string,
  patch: Partial<T>,
  schema: AnyZodObject,
  immutableFields: readonly (keyof T)[],
): Promise<void> {
  // Parse before any Firestore I/O. Besides failing fast, strict partial
  // parsing prevents unknown keys from being smuggled through update().
  const parsedPatch = schema.partial().strict().parse(patch) as Partial<T>;
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const ref = db.collection(collectionPath).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`${collectionPath}/${id} not found`);
  const current = snap.data() as T;
  assertImmutableFields(current, parsedPatch, immutableFields);
  schema.parse({ ...current, ...parsedPatch });
  await ref.update(parsedPatch as unknown as Record<string, unknown>);
}

/**
 * Read a document by id from a collection, validating with the given schema.
 */
async function readDoc<T>(
  collectionPath: string,
  id: string,
): Promise<Doc<T> | null> {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db.collection(collectionPath).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, data: snap.data() as T };
}

/**
 * Write a document (create or overwrite).
 */
async function writeDoc<T>(
  collectionPath: string,
  id: string,
  data: T,
): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db.collection(collectionPath).doc(id).set(data as unknown as Record<string, unknown>);
}

/**
 * Query docs by a filter (field == value).
 */
async function queryDocs<T>(
  collectionPath: string,
  field: string,
  value: unknown,
): Promise<Doc<T>[]> {
  const db = getAdminDb();
  if (!db) return [];
  const snap = await db
    .collection(collectionPath)
    .where(field, '==', value)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
}

/**
 * Delete a document.
 */
async function deleteDoc(collectionPath: string, id: string): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db.collection(collectionPath).doc(id).delete();
}

// ── Correlation-marker repository ────────────────────────────────────────────
// Durable idempotency markers (processed correlation IDs). The Firestore
// session store writes and clears these in the SAME transaction as the session
// update, so a committed transition always carries its marker (and a rollback
// pause always carries its clear) — they cannot diverge across a crash or a
// partial failure (Codex P1 chain, PR #58 review).
//
// Correlation IDs are now validated at the API boundary (charset + length,
// see correlationIdSchema), so a client-supplied id can no longer contain a
// path separator or run unbounded. The raw value is STILL never used as a
// Firestore doc id: server-constructed ids (e.g. `idle->…`,
// `resume-rollback:<id>:<nonce>`) legitimately carry characters the client
// schema forbids, and historical docs predate the boundary — so every marker
// is keyed by a base64url encoding that is safe for a single path segment
// (Codex P2, PR #58 review).

const CORRELATION_MARKERS = 'correlation_markers';

/**
 * Safe single-segment Firestore key for an arbitrary correlation ID.
 * base64url is reversible, collision-free for distinct inputs, and contains
 * no '/' or other path separators (Codex P2, PR #58 review — a raw id like
 * 'a/b' would otherwise be split into path components by Firestore's doc()).
 */
export function markerKey(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/**
 * A raw correlation ID can only be a legacy Firestore doc id when it contains
 * no '/' — a separator would make the lookup throw instead of falling back
 * (Codex P1, PR #62 review). Legacy markers only ever existed for ids without
 * a separator (the pre-encoding code wrote the raw id directly), so skipping
 * the fallback for those is both safe and correct.
 */
function legacyKeyable(id: string): boolean {
  return !id.includes('/');
}

/**
 * True when the id was ever marked (a processed correlation ID).
 *
 * Reads the base64url key first, then falls back to the LEGACY raw key: PR #58
 * deployed markers under the raw correlation ID, so a retry arriving after the
 * encoding change (or during a rolling deploy mixing old and new instances)
 * must still see the old marker or it would re-execute the transition (Codex
 * P1, PR #59 review).
 *
 * Migration is dual-namespace, not move-and-delete: a legacy raw-key marker is
 * COPIED to the encoded key and RETAINED under the raw key, because an old
 * instance still serving only reads the raw key — deleting it during an
 * opportunistic read would make that instance re-execute the transition
 * (Codex P1, PR #62 review). The fallback drains as old readers go away.
 *
 * A raw-key document is only treated as a legacy marker for THIS id when it
 * cannot be another id's encoded marker: it either predates rawId recording
 * (no rawId field — the pre-encoding format) or records rawId === id. Without
 * that check, has('YQ') would read the encoded marker for 'a' (key 'YQ') and
 * misreport a processed duplicate (Codex P2, PR #62 review).
 */
export async function hasCorrelationMarker(id: string): Promise<boolean> {
  const encoded = await readDoc(CORRELATION_MARKERS, markerKey(id));
  let encodedForeign = false;
  if (encoded !== null) {
    // A doc at the encoded key belongs to THIS id only when it predates rawId
    // recording or names this id. A raw write that historically collided here
    // carries a foreign rawId — never report a duplicate for it (Codex P2,
    // PR #64 review), but fall through to this id's own legacy marker below
    // rather than answering absent (Codex P1, PR #66 review).
    const data = encoded.data as { rawId?: string } | null;
    if (data?.rawId !== undefined && data.rawId !== id) {
      encodedForeign = true;
    } else {
      return true;
    }
  }
  if (!legacyKeyable(id)) return false;
  const legacy = await readDoc(CORRELATION_MARKERS, id);
  if (!legacy) return false;
  const data = legacy.data as { markedAt?: number; rawId?: string } | null;
  if (data?.rawId !== undefined && data.rawId !== id) return false;
  // Copy to the encoded key, retain the raw key for still-serving old
  // instances. Idempotent: later reads hit the encoded key directly. A
  // foreign occupant of the encoded slot is left untouched — copying would
  // clobber the other id's marker — and the retained legacy doc keeps
  // serving this id (Codex P1, PR #66 review).
  if (!encodedForeign) {
    await writeDoc(
      CORRELATION_MARKERS,
      markerKey(id),
      correlationMarkerSchema.parse({ markedAt: now(), rawId: id }),
    );
  }
  return true;
}

/**
 * Persist the marker. Idempotent — re-marking the same id is a no-op write.
 *
 * Encoded key only. The raw-key dual-write was removed: it existed so old
 * instances (pre-encoding) could see new markers during the rolling deploy,
 * a window long past — and it was unsafe, since a raw copy could occupy
 * another id's encoded key and falsely suppress its transition (Codex P2,
 * PR #64 review). Raw-key docs are now historical only, drained by the
 * legacy read fallback and the conditional clear.
 */
export async function markCorrelationMarker(id: string): Promise<void> {
  const doc = correlationMarkerSchema.parse({ markedAt: now(), rawId: id });
  await writeDoc(CORRELATION_MARKERS, markerKey(id), doc);
}

/**
 * Forget the marker so its operation becomes retryable (rollback path).
 * Clears BOTH namespaces (encoded + legacy raw) so no reader of either kind
 * sees a stale processed marker.
 */
export async function clearCorrelationMarker(id: string): Promise<void> {
  await deleteDoc(CORRELATION_MARKERS, markerKey(id));
  if (legacyKeyable(id)) {
    await deleteDoc(CORRELATION_MARKERS, id);
  }
}

function currentGenerationLease(
  marker: ReturnType<typeof recipeGenerationMarkerSchema.parse>,
  input: RecipeGenerationLeaseInput,
): boolean {
  return marker.status === 'leased'
    && marker.userId === input.userId
    && marker.requestHash === input.requestHash
    && marker.leaseToken === input.leaseToken
    && marker.leaseExpiresAt > input.now;
}

export async function claimRecipeGeneration(
  input: RecipeGenerationLeaseInput,
): Promise<RecipeGenerationClaim> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const ref = db.collection(CORRELATION_MARKERS).doc(markerKey(input.markerId));
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) {
      const current = recipeGenerationMarkerSchema.parse(snap.data());
      if (current.rawId !== input.markerId
        || current.userId !== input.userId
        || current.requestHash !== input.requestHash) {
        return { status: 'conflict' } as const;
      }
      if (current.status === 'completed' && current.recipeId) {
        return { status: 'completed', recipeId: current.recipeId } as const;
      }
      if (current.status === 'leased' && current.leaseExpiresAt > input.now) {
        return { status: 'in_progress' } as const;
      }
    }
    const marker = recipeGenerationMarkerSchema.parse({
      kind: 'recipe_generation',
      rawId: input.markerId,
      markedAt: input.now,
      updatedAt: input.now,
      userId: input.userId,
      requestHash: input.requestHash,
      status: 'leased',
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.now + input.leaseMs,
    });
    transaction.set(ref, marker);
    return { status: 'acquired', leaseToken: input.leaseToken } as const;
  });
}

export async function completeRecipeGeneration(
  input: RecipeGenerationLeaseInput & { recipe: Recipe },
): Promise<boolean> {
  const recipe = recipeSchema.strict().parse(input.recipe);
  if (recipe.id !== input.recipe.id || recipe.userId !== input.userId) return false;
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const markerRef = db.collection(CORRELATION_MARKERS).doc(markerKey(input.markerId));
  const recipeRef = db.collection(RECIPES).doc(recipe.id);
  return db.runTransaction(async (transaction) => {
    const markerSnap = await transaction.get(markerRef);
    if (!markerSnap.exists) return false;
    const current = recipeGenerationMarkerSchema.parse(markerSnap.data());
    if (current.rawId !== input.markerId || !currentGenerationLease(current, input)) return false;
    transaction.create(recipeRef, recipe as unknown as Record<string, unknown>);
    transaction.set(markerRef, recipeGenerationMarkerSchema.parse({
      ...current,
      status: 'completed',
      recipeId: recipe.id,
      markedAt: input.now,
      updatedAt: input.now,
    }));
    return true;
  });
}

export async function failRecipeGeneration(
  input: RecipeGenerationLeaseInput,
): Promise<boolean> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const markerRef = db.collection(CORRELATION_MARKERS).doc(markerKey(input.markerId));
  return db.runTransaction(async (transaction) => {
    const markerSnap = await transaction.get(markerRef);
    if (!markerSnap.exists) return false;
    const current = recipeGenerationMarkerSchema.parse(markerSnap.data());
    if (current.rawId !== input.markerId || !currentGenerationLease(current, input)) return false;
    transaction.set(markerRef, recipeGenerationMarkerSchema.parse({
      ...current,
      status: 'failed',
      markedAt: input.now,
      updatedAt: input.now,
    }));
    return true;
  });
}

export interface StaleMarkerCleanupResult {
  deleted: number;
  pages: number;
}

/**
 * Delete every correlation marker older than cutoffMs, page by page at the
 * 500-write batch limit with startAfter pagination. The scheduled TTL cleanup
 * (scripts/cleanup-correlation-markers.ts) delegates here so no Firestore
 * write bypasses the repository boundary (Codex P1, PR #70 review) — the
 * collection's invariants and any future schema/storage change stay
 * centralized with the rest of the marker logic.
 *
 * With dryRun the pages are read and counted but nothing is written.
 * batchSize is capped at Firestore's 500-write batch limit and must be a
 * positive integer.
 */
export async function deleteStaleCorrelationMarkers(
  cutoffMs: number,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<StaleMarkerCleanupResult> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error(`batchSize must be an integer in 1..500 (got ${batchSize})`);
  }
  let deleted = 0;
  let pages = 0;
  let lastDoc: DocumentSnapshot | null = null;
  while (true) {
    // Single-field range + orderBy on the same field needs no composite index.
    // Pagination via startAfter keeps pages bounded and the sweep resumable.
    let q = db
      .collection(CORRELATION_MARKERS)
      .where('markedAt', '<', cutoffMs)
      .orderBy('markedAt')
      .limit(batchSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    pages += 1;
    lastDoc = snap.docs[snap.size - 1];
    if (!options.dryRun) {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
    }
    deleted += snap.size;
    if (snap.size < batchSize) break;
  }
  return { deleted, pages };
}

// ── Recipe repository ────────────────────────────────────────────────────────

const RECIPES = 'recipes';

export async function createRecipe(recipe: Recipe): Promise<void> {
  await writeValidatedDocument(RECIPES, recipe.id, recipe, recipeSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'generatedAt'],
  });
}

export async function getRecipe(id: string): Promise<Recipe | null> {
  const doc = await readDoc<Recipe>(RECIPES, id);
  return doc?.data ?? null;
}

export async function updateRecipe(recipe: Recipe): Promise<void> {
  await writeValidatedDocument(RECIPES, recipe.id, recipe, recipeSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'generatedAt'],
  });
}

export async function listRecipes(userId: UserId): Promise<Recipe[]> {
  const docs = await queryDocs<Recipe>(RECIPES, 'userId', userId);
  return docs.map((d) => d.data);
}

export async function deleteRecipe(id: string): Promise<void> {
  await deleteDoc(RECIPES, id);
}

// ── Cooking session repository (with optimistic concurrency) ─────────────────

const SESSIONS = 'cooking_sessions';

export async function createSession(session: CookingSession): Promise<void> {
  await writeValidatedDocument(SESSIONS, session.id, session, cookingSessionSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'startedAt'],
  });
}

export async function getSession(id: string): Promise<CookingSession | null> {
  const doc = await readDoc<CookingSession>(SESSIONS, id);
  return doc?.data ?? null;
}

export async function getActiveSession(userId: UserId): Promise<CookingSession | null> {
  const docs = await queryDocs<CookingSession>(SESSIONS, 'userId', userId);
  const active = docs
    .map((d) => d.data)
    .filter((s) => s.status === 'ACTIVE' || s.status === 'PAUSED')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return active[0] ?? null;
}

/**
 * Update a session with optimistic concurrency.
 * Throws if the version doesn't match, preventing conflicting updates.
 *
 * Marker ops (mark/clear a correlation ID) commit in the SAME transaction as
 * the session update, so a transition can never be durable without its marker
 * and a rollback pause can never survive without its clear (Codex P1s, PR #58
 * review — previously the marker write was a separate call that could fail
 * after the transition had already committed).
 */
export async function updateSession(
  id: string,
  partial: Partial<CookingSession>,
  expectedVersion: number,
  marker?: { mark?: string | string[]; clear?: string },
): Promise<CookingSession> {
  const validatedPartial = cookingSessionSchema.partial().strict().parse(partial);
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');

  const ref = db.collection(SESSIONS).doc(id);
  const markers = db.collection(CORRELATION_MARKERS);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Session ${id} not found`);

    const current = snap.data() as CookingSession;
    if (current.version !== expectedVersion) {
      throw new Error(
        `Session ${id} version conflict: expected ${expectedVersion}, got ${current.version}`,
      );
    }
    assertImmutableFields(
      current,
      validatedPartial,
      ['id', 'userId', 'startedAt', 'version'],
    );

    // Read the legacy raw marker BEFORE queuing any writes: Firestore
    // transactions require every read to precede every write, and the rollback
    // clear below conditionally deletes that doc (Codex P1, PR #64 review).
    let legacyClearData: { rawId?: string } | undefined;
    if (marker?.clear && legacyKeyable(marker.clear)) {
      const legacySnap = await tx.get(markers.doc(marker.clear));
      legacyClearData = legacySnap.exists
        ? (legacySnap.data() as { rawId?: string })
        : undefined;
    }

    const updated: CookingSession = {
      ...current,
      ...validatedPartial,
      version: current.version + 1,
      lastActivityAt: now(),
    };

    cookingSessionSchema.parse(updated);
    tx.update(ref, updated as unknown as Record<string, unknown>);

    const marks = marker?.mark ? (Array.isArray(marker.mark) ? marker.mark : [marker.mark]) : [];
    for (const id of marks) {
      const doc = correlationMarkerSchema.parse({ markedAt: now(), rawId: id });
      tx.set(markers.doc(markerKey(id)), doc as unknown as Record<string, unknown>);
    }
    if (marker?.clear) {
      const id = marker.clear;
      tx.delete(markers.doc(markerKey(id)));
      // Conditional raw delete: only when the raw doc is a legacy marker for
      // THIS id (rawId matches or predates recording) — never another id's
      // encoded marker living at that key. Historical raw docs drain here.
      if (legacyKeyable(id) && (legacyClearData?.rawId === undefined || legacyClearData.rawId === id)) {
        tx.delete(markers.doc(id));
      }
    }
    return updated;
  });

  return result;
}

export async function listSessions(userId: UserId): Promise<CookingSession[]> {
  const docs = await queryDocs<CookingSession>(SESSIONS, 'userId', userId);
  return docs.map((d) => d.data);
}

// ── Session event repository ─────────────────────────────────────────────────

const EVENTS = 'cooking_session_events';

export async function createEvent(event: CookingSessionEvent): Promise<void> {
  await writeValidatedDocument(EVENTS, event.id, event, cookingSessionEventSchema, {
    keyField: 'id',
    immutableFields: ['id', 'sessionId', 'userId', 'type', 'at'],
  });
}

export async function listSessionEvents(sessionId: string): Promise<CookingSessionEvent[]> {
  const docs = await queryDocs<CookingSessionEvent>(EVENTS, 'sessionId', sessionId);
  return docs.map((d) => d.data).sort((a, b) => a.at - b.at);
}

// ── Timer repository ─────────────────────────────────────────────────────────

const TIMERS = 'timers';

export async function createTimer(timer: CookingTimer): Promise<void> {
  await writeValidatedDocument(TIMERS, timer.id, timer, cookingTimerSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'sessionId', 'startedAt', 'durationSeconds'],
  });
}

export async function getTimer(id: string): Promise<CookingTimer | null> {
  const doc = await readDoc<CookingTimer>(TIMERS, id);
  return doc?.data ?? null;
}

export async function updateTimer(
  id: string,
  partial: Partial<CookingTimer>,
): Promise<void> {
  await updateValidatedDocument<CookingTimer>(
    TIMERS,
    id,
    partial,
    cookingTimerSchema,
    ['id', 'userId', 'sessionId', 'startedAt', 'durationSeconds'],
  );
}

export async function listActiveTimers(sessionId: string): Promise<CookingTimer[]> {
  const db = getAdminDb();
  if (!db) return [];
  const snap = await db
    .collection(TIMERS)
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'RUNNING')
    .get();
  return snap.docs.map((d) => d.data() as CookingTimer);
}

/**
 * Shift every RUNNING timer of a session by elapsedMs in ONE atomic batch
 * (Codex P1 — PR #30 review): the resume rebase must be all-or-nothing. A
 * per-timer update loop could leave some timers shifted and others not, and a
 * compensating rollback of the already-written ones could itself fail during
 * a continuing store outage — silently presenting the rebase as safely
 * reverted when it was not. A Firestore batch commits every update or none,
 * so the caller never needs to roll back.
 */
export async function rebaseActiveTimers(
  sessionId: string,
  elapsedMs: number,
): Promise<void> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  const snap = await db
    .collection(TIMERS)
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'RUNNING')
    .get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const current = doc.data() as CookingTimer;
    const shifted = cookingTimerSchema.parse({
      ...current,
      endsAt: current.endsAt + elapsedMs,
    });
    batch.update(doc.ref, { endsAt: shifted.endsAt });
  }
  await batch.commit();
}

// ── Pantry repository ────────────────────────────────────────────────────────

const PANTRY = 'pantry_items';

export async function createPantryItem(item: PantryItem): Promise<void> {
  await writeValidatedDocument(PANTRY, item.id, item, pantryItemSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'source'],
  });
}

export async function getPantryItem(id: string): Promise<PantryItem | null> {
  const doc = await readDoc<PantryItem>(PANTRY, id);
  return doc?.data ?? null;
}

export async function listPantryItems(userId: UserId): Promise<PantryItem[]> {
  const docs = await queryDocs<PantryItem>(PANTRY, 'userId', userId);
  return docs.map((d) => d.data);
}

export async function updatePantryItem(
  id: string,
  partial: Partial<PantryItem>,
): Promise<void> {
  await updateValidatedDocument<PantryItem>(
    PANTRY,
    id,
    partial,
    pantryItemSchema,
    ['id', 'userId', 'source'],
  );
}

export async function deletePantryItem(id: string): Promise<void> {
  await deleteDoc(PANTRY, id);
}

// ── Leftover repository (K10) ────────────────────────────────────────────────

const LEFTOVERS = 'leftovers';

export async function createLeftover(leftover: Leftover): Promise<void> {
  await writeValidatedDocument(LEFTOVERS, leftover.id, leftover, leftoverSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'recipeId', 'completedAt', 'storedAt'],
  });
}

export async function getLeftover(id: string): Promise<Leftover | null> {
  const doc = await readDoc<Leftover>(LEFTOVERS, id);
  return doc?.data ?? null;
}

export async function listLeftovers(userId: UserId): Promise<Leftover[]> {
  const docs = await queryDocs<Leftover>(LEFTOVERS, 'userId', userId);
  return docs.map((d) => d.data);
}

export async function updateLeftover(id: string, partial: Partial<Leftover>): Promise<void> {
  await updateValidatedDocument<Leftover>(
    LEFTOVERS,
    id,
    partial,
    leftoverSchema,
    ['id', 'userId', 'recipeId', 'completedAt', 'storedAt'],
  );
}

// ── Grocery list repository (K10) ────────────────────────────────────────────

const GROCERY = 'grocery_list';

export async function createGroceryItem(item: GroceryItem): Promise<void> {
  await writeValidatedDocument(GROCERY, item.id, item, groceryItemSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'source', 'pantryItemId', 'createdAt'],
  });
}

export async function getGroceryItem(id: string): Promise<GroceryItem | null> {
  const doc = await readDoc<GroceryItem>(GROCERY, id);
  return doc?.data ?? null;
}

export async function listGroceryItems(userId: UserId): Promise<GroceryItem[]> {
  const docs = await queryDocs<GroceryItem>(GROCERY, 'userId', userId);
  return docs.map((d) => d.data);
}

export async function updateGroceryItem(id: string, partial: Partial<GroceryItem>): Promise<void> {
  await updateValidatedDocument<GroceryItem>(
    GROCERY,
    id,
    partial,
    groceryItemSchema,
    ['id', 'userId', 'source', 'pantryItemId', 'createdAt'],
  );
}

export async function deleteGroceryItem(id: string): Promise<void> {
  await deleteDoc(GROCERY, id);
}

// ── Dietary profile repository ────────────────────────────────────────────────

const PROFILES = 'dietary_profiles';

export async function upsertDietaryProfile(profile: DietaryProfile): Promise<void> {
  await writeValidatedDocument(PROFILES, profile.userId, profile, dietaryProfileSchema, {
    keyField: 'userId',
    immutableFields: ['userId'],
  });
}

export async function getDietaryProfile(userId: UserId): Promise<DietaryProfile | null> {
  const doc = await readDoc<DietaryProfile>(PROFILES, userId);
  return doc?.data ?? null;
}

// ── Agent tool log repository ─────────────────────────────────────────────────

const TOOL_LOGS = 'agent_tool_logs';

export async function createToolLog(log: AgentToolLog): Promise<void> {
  await writeValidatedDocument(TOOL_LOGS, log.id, log, agentToolLogSchema, {
    keyField: 'id',
    immutableFields: ['id', 'userId', 'sessionId', 'tool', 'at', 'correlationId'],
  });
}

// ── Idempotency / event sourcing helpers ─────────────────────────────────────

export function newId(): string {
  return randomId();
}

export { now };
