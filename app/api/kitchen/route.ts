// ─────────────────────────────────────────────────────────────────────────────
// /api/kitchen — "My Kitchen": inspect and change everything the agent
// remembers about the user's kitchen.
//
// POST { action: 'snapshot'|'pantry_add'|'pantry_remove'|'pantry_confirm'|
//               'grocery_add'|'grocery_bought'|'grocery_remove'|
//               'leftover_log'|'leftover_consume'|'profile_update', ... }
// GET  → the same snapshot (pantry + grocery + leftovers + dietary profile)
// Auth: Bearer <Firebase ID token>
//
// Before this route the ONLY way to see the pantry / grocery list / leftovers
// / dietary profile was to ask the conversational agent and trust its reply —
// there was no screen to inspect or change remembered information (K8). This
// route is the read/write surface behind the /kitchen page. Every mutation
// goes through the existing services (PantryService, GroceryService,
// LeftoverService, DietaryProfileService) — never direct store writes.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';
import { PantryService } from '@/lib/server/pantry-service';
import { GroceryService } from '@/lib/server/grocery-service';
import { LeftoverService } from '@/lib/server/leftover-service';
import { DietaryProfileService } from '@/lib/server/profile-service';
import type { ToolContext } from '@/lib/server/tools/types';
import type { GroceryItem, Leftover } from '@/lib/domain/types';
import { logError } from '@/lib/server/logger';

const ACTIONS = [
  'snapshot',
  'pantry_add',
  'pantry_remove',
  'pantry_confirm',
  'grocery_add',
  'grocery_bought',
  'grocery_remove',
  'leftover_log',
  'leftover_consume',
  'profile_update',
] as const;
type KitchenAction = (typeof ACTIONS)[number];

function isKitchenAction(v: unknown): v is KitchenAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

/** Whole days a leftover has been stored (0 = today) — mirrors the tool layer. */
function daysStored(leftover: Leftover): number {
  return Math.max(0, Math.floor((Date.now() - leftover.storedAt) / (24 * 60 * 60 * 1000)));
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Split a comma-separated list into trimmed, case-insensitive-deduped entries. */
function list(v: unknown): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function bad(code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { code, message, recoverable: false } },
    { status: 400 },
  );
}

async function handle(userId: string, body: unknown): Promise<NextResponse> {
  const parsed = body as Record<string, unknown>;
  const action: KitchenAction = isKitchenAction(parsed.action) ? parsed.action : 'snapshot';

  const ctx = buildProductionContext(userId);
  if (!ctx.pantryStore || !ctx.groceryStore || !ctx.leftoverStore || !ctx.dietaryProfileStore) {
    return NextResponse.json(
      {
        success: false,
        error: { code: 'KITCHEN_UNAVAILABLE', message: 'Kitchen storage is not available', recoverable: true },
      },
      { status: 503 },
    );
  }
  const pantry = new PantryService(ctx.pantryStore, ctx.sessionService);
  const grocery = new GroceryService(ctx.groceryStore);
  const leftovers = new LeftoverService(ctx.leftoverStore, ctx.sessionService);
  const profile = new DietaryProfileService(ctx.dietaryProfileStore);

  switch (action) {
    case 'snapshot': {
      const [pantryItems, groceryItems, leftoverItems, profileData] = await Promise.all([
        pantry.listPantry(userId),
        grocery.listOpenItems(userId),
        leftovers.listActiveLeftovers(userId),
        profile.getProfile(userId),
      ]);
      return NextResponse.json({
        success: true,
        data: {
          pantry: pantryItems,
          grocery: groceryItems.map((i) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity ?? null,
            unit: i.unit ?? null,
            source: i.source,
            createdAt: i.createdAt,
          })),
          leftovers: leftoverItems.map((l) => ({
            id: l.id,
            title: l.title,
            servings: l.servings,
            storedDays: daysStored(l),
            storedAt: l.storedAt,
            notes: l.notes ?? null,
          })),
          profile: profileData,
        },
      });
    }
    case 'pantry_add': {
      const name = str(parsed.name);
      if (!name) return bad('INVALID_BODY', 'pantry_add requires a name');
      const item = await pantry.addItem(userId, {
        name,
        quantity: num(parsed.quantity),
        unit: typeof parsed.unit === 'string' && parsed.unit.trim() ? parsed.unit.trim().slice(0, 50) : undefined,
        source: 'MANUAL',
      });
      return NextResponse.json({ success: true, data: { item: { id: item.id, name: item.name } } });
    }
    case 'pantry_remove': {
      const itemId = str(parsed.itemId, 100);
      if (!itemId) return bad('INVALID_BODY', 'pantry_remove requires an itemId');
      const item = await pantry.removeItem(userId, itemId);
      return NextResponse.json({ success: true, data: { removed: true, name: item.name } });
    }
    case 'pantry_confirm': {
      const itemId = str(parsed.itemId, 100);
      if (!itemId) return bad('INVALID_BODY', 'pantry_confirm requires an itemId');
      const item = await pantry.confirmItem(userId, itemId);
      return NextResponse.json({ success: true, data: { item: { id: item.id, confidence: item.confidence } } });
    }
    case 'grocery_add': {
      const name = str(parsed.name);
      if (!name) return bad('INVALID_BODY', 'grocery_add requires a name');
      const item = await grocery.addItem(userId, {
        name,
        quantity: num(parsed.quantity),
        unit: typeof parsed.unit === 'string' && parsed.unit.trim() ? parsed.unit.trim().slice(0, 50) : undefined,
        source: 'MANUAL',
      });
      return NextResponse.json({ success: true, data: { item: { id: item.id, name: item.name } } });
    }
    case 'grocery_bought': {
      const itemId = str(parsed.itemId, 100);
      if (!itemId) return bad('INVALID_BODY', 'grocery_bought requires an itemId');
      const item = await grocery.markBought(userId, itemId);
      return NextResponse.json({ success: true, data: { itemId: item.id, name: item.name, status: item.status } });
    }
    case 'grocery_remove': {
      const itemId = str(parsed.itemId, 100);
      if (!itemId) return bad('INVALID_BODY', 'grocery_remove requires an itemId');
      const item = await grocery.removeItem(userId, itemId);
      return NextResponse.json({ success: true, data: { removed: true, name: item.name } });
    }
    case 'leftover_log': {
      const title = str(parsed.title);
      if (!title) return bad('INVALID_BODY', 'leftover_log requires a title');
      const servings = num(parsed.servings) ?? 1;
      const leftover = await leftovers.createLeftover(userId, {
        title,
        servings: Math.max(1, Math.floor(servings)),
        notes: typeof parsed.notes === 'string' && parsed.notes.trim() ? parsed.notes.trim().slice(0, 500) : undefined,
      });
      return NextResponse.json({ success: true, data: { leftover: { id: leftover.id, title: leftover.title } } });
    }
    case 'leftover_consume': {
      const leftoverId = str(parsed.leftoverId, 100);
      if (!leftoverId) return bad('INVALID_BODY', 'leftover_consume requires a leftoverId');
      await leftovers.consumeLeftover(userId, leftoverId);
      return NextResponse.json({ success: true, data: { consumed: true } });
    }
    case 'profile_update': {
      const allergies = list(parsed.allergies);
      const dietaryRestrictions = list(parsed.dietaryRestrictions);
      const dislikedIngredients = list(parsed.dislikedIngredients);
      const preferredCuisines = list(parsed.preferredCuisines);
      const defaultServingsRaw = num(parsed.defaultServings);
      const defaultServings =
        defaultServingsRaw === undefined ? undefined : Math.max(1, Math.floor(defaultServingsRaw));
      const updated = await profile.updateProfile(userId, {
        ...(allergies !== undefined ? { allergies } : {}),
        ...(dietaryRestrictions !== undefined ? { dietaryRestrictions } : {}),
        ...(dislikedIngredients !== undefined ? { dislikedIngredients } : {}),
        ...(preferredCuisines !== undefined ? { preferredCuisines } : {}),
        ...(defaultServings !== undefined ? { defaultServings } : {}),
      });
      return NextResponse.json({ success: true, data: { profile: updated } });
    }
  }
}

export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  const userId = await resolveUserId(token);
  if (!userId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', recoverable: false } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'INVALID_BODY', message: 'Request body must be JSON', recoverable: false } },
      { status: 400 },
    );
  }

  try {
    return await handle(userId, body);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    const message = typeof err.message === 'string' ? err.message : 'Kitchen request failed';
    const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
    logError('api.kitchen.error', { userId, code, message: message.slice(0, 300) });
    return NextResponse.json({ success: false, error: { code, message, recoverable } }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  const userId = await resolveUserId(token);
  if (!userId) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', recoverable: false } },
      { status: 401 },
    );
  }

  try {
    return await handle(userId, { action: 'snapshot' });
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    const message = typeof err.message === 'string' ? err.message : 'Kitchen request failed';
    const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
    return NextResponse.json({ success: false, error: { code, message, recoverable } }, { status: 400 });
  }
}
