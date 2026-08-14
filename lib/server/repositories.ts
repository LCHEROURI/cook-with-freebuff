// ─────────────────────────────────────────────────────────────────────────────
// Repository abstractions
//
// Every Firestore collection has a typed repository interface + a Firestore
// implementation. No raw Firestore calls outside of these modules.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
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
} from '../domain/schemas';

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
// Correlation IDs are client-supplied strings and can contain path separators
// (e.g. 'a/b'), so the raw value is never used as a Firestore doc id — every
// marker is keyed by a base64url encoding that is safe for a single path
// segment (Codex P2, PR #58 review).

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
  if (encoded !== null) {
    // A doc at the encoded key belongs to THIS id only when it predates rawId
    // recording or names this id. A raw write that historically collided here
    // carries a foreign rawId — never report a duplicate for it (Codex P2,
    // PR #64 review).
    const data = encoded.data as { rawId?: string } | null;
    if (data?.rawId !== undefined && data.rawId !== id) return false;
    return true;
  }
  if (!legacyKeyable(id)) return false;
  const legacy = await readDoc(CORRELATION_MARKERS, id);
  if (!legacy) return false;
  const data = legacy.data as { markedAt?: number; rawId?: string } | null;
  if (data?.rawId !== undefined && data.rawId !== id) return false;
  // Copy to the encoded key, retain the raw key for still-serving old
  // instances. Idempotent: later reads hit the encoded key directly.
  await writeDoc(
    CORRELATION_MARKERS,
    markerKey(id),
    correlationMarkerSchema.parse({ markedAt: now(), rawId: id }),
  );
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

// ── Recipe repository ────────────────────────────────────────────────────────

const RECIPES = 'recipes';

export async function createRecipe(recipe: Recipe): Promise<void> {
  recipeSchema.parse(recipe);
  await writeDoc(RECIPES, recipe.id, recipe);
}

export async function getRecipe(id: string): Promise<Recipe | null> {
  const doc = await readDoc<Recipe>(RECIPES, id);
  return doc?.data ?? null;
}

export async function updateRecipe(recipe: Recipe): Promise<void> {
  recipeSchema.parse(recipe);
  await writeDoc(RECIPES, recipe.id, recipe);
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
  cookingSessionSchema.parse(session);
  await writeDoc(SESSIONS, session.id, session);
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
      ...partial,
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
  cookingSessionEventSchema.parse(event);
  await writeDoc(EVENTS, event.id, event);
}

export async function listSessionEvents(sessionId: string): Promise<CookingSessionEvent[]> {
  const docs = await queryDocs<CookingSessionEvent>(EVENTS, 'sessionId', sessionId);
  return docs.map((d) => d.data).sort((a, b) => a.at - b.at);
}

// ── Timer repository ─────────────────────────────────────────────────────────

const TIMERS = 'timers';

export async function createTimer(timer: CookingTimer): Promise<void> {
  cookingTimerSchema.parse(timer);
  await writeDoc(TIMERS, timer.id, timer);
}

export async function getTimer(id: string): Promise<CookingTimer | null> {
  const doc = await readDoc<CookingTimer>(TIMERS, id);
  return doc?.data ?? null;
}

export async function updateTimer(
  id: string,
  partial: Partial<CookingTimer>,
): Promise<void> {
  // Validate the update at the write boundary (repo rule) BEFORE any I/O: a
  // malformed legacy value propagated into a partial (e.g. a string endsAt
  // concatenated during a rebase) must fail here instead of reaching
  // Firestore. Partial parse also strips unknown keys, so the write only
  // ever carries known fields.
  const validated = cookingTimerSchema.partial().parse(partial);
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db
    .collection(TIMERS)
    .doc(id)
    .update(validated as unknown as Record<string, unknown>);
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
    // Validate the shifted value at the write boundary (repo rule) — a
    // malformed legacy endsAt must fail the whole batch, not reach Firestore.
    const shifted = cookingTimerSchema.partial().parse({ endsAt: current.endsAt + elapsedMs });
    batch.update(doc.ref, shifted as unknown as Record<string, unknown>);
  }
  await batch.commit();
}

// ── Pantry repository ────────────────────────────────────────────────────────

const PANTRY = 'pantry_items';

export async function createPantryItem(item: PantryItem): Promise<void> {
  pantryItemSchema.parse(item);
  await writeDoc(PANTRY, item.id, item);
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
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db.collection(PANTRY).doc(id).update(partial as unknown as Record<string, unknown>);
}

export async function deletePantryItem(id: string): Promise<void> {
  await deleteDoc(PANTRY, id);
}

// ── Leftover repository (K10) ────────────────────────────────────────────────

const LEFTOVERS = 'leftovers';

export async function createLeftover(leftover: Leftover): Promise<void> {
  leftoverSchema.parse(leftover);
  await writeDoc(LEFTOVERS, leftover.id, leftover);
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
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db.collection(LEFTOVERS).doc(id).update(partial as unknown as Record<string, unknown>);
}

// ── Grocery list repository (K10) ────────────────────────────────────────────

const GROCERY = 'grocery_list';

export async function createGroceryItem(item: GroceryItem): Promise<void> {
  groceryItemSchema.parse(item);
  await writeDoc(GROCERY, item.id, item);
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
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');
  await db.collection(GROCERY).doc(id).update(partial as unknown as Record<string, unknown>);
}

export async function deleteGroceryItem(id: string): Promise<void> {
  await deleteDoc(GROCERY, id);
}

// ── Dietary profile repository ────────────────────────────────────────────────

const PROFILES = 'dietary_profiles';

export async function upsertDietaryProfile(profile: DietaryProfile): Promise<void> {
  dietaryProfileSchema.parse(profile);
  await writeDoc(PROFILES, profile.userId, profile);
}

export async function getDietaryProfile(userId: UserId): Promise<DietaryProfile | null> {
  const doc = await readDoc<DietaryProfile>(PROFILES, userId);
  return doc?.data ?? null;
}

// ── Agent tool log repository ─────────────────────────────────────────────────

const TOOL_LOGS = 'agent_tool_logs';

export async function createToolLog(log: AgentToolLog): Promise<void> {
  agentToolLogSchema.parse(log);
  await writeDoc(TOOL_LOGS, log.id, log);
}

// ── Idempotency / event sourcing helpers ─────────────────────────────────────

export function newId(): string {
  return randomId();
}

export { now };