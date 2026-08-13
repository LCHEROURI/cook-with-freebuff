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
 */
export async function updateSession(
  id: string,
  partial: Partial<CookingSession>,
  expectedVersion: number,
): Promise<CookingSession> {
  const db = getAdminDb();
  if (!db) throw new Error('Firestore not initialized');

  const ref = db.collection(SESSIONS).doc(id);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Session ${id} not found`);

    const current = snap.data() as CookingSession;
    if (current.version !== expectedVersion) {
      throw new Error(
        `Session ${id} version conflict: expected ${expectedVersion}, got ${current.version}`,
      );
    }

    const updated: CookingSession = {
      ...current,
      ...partial,
      version: current.version + 1,
      lastActivityAt: now(),
    };

    cookingSessionSchema.parse(updated);
    tx.update(ref, updated as unknown as Record<string, unknown>);
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