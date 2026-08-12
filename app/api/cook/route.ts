// ─────────────────────────────────────────────────────────────────────────────
// /api/cook — guided cooking ("Cook With Me")
//
// POST { action: 'launch'|'status'|'done'|'repeat'|'back'|'pause'|'resume'|'timers'|
//                 'start_over'|'create_recipe', sessionId?, recipeId?, prompt?, correlationId? }
// GET  → status of the active session
// Auth: Bearer <Firebase ID token>
//
// Returns the ONE current action (never a whole procedure). Timer alerts
// surface via the 'timers' action. All mutations go through
// GuidedCookingService — never direct session writes.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';
import { createGuideService } from '@/lib/server/tools/guide-tools';
import { generateRecipeTool } from '@/lib/server/tools/recipe-tools';
import { extractIngredients, extractRecipePreferences } from '@/lib/agent/extract';
import { validateRecipe } from '@/lib/recipe/validate';
import type { Recipe } from '@/lib/domain/types';
import { logError, logInfo } from '@/lib/server/logger';
import { generateCorrelationId, runWithContext } from '@/lib/server/requestContext';

const ACTIONS = [
  'launch', 'status', 'done', 'repeat', 'back', 'pause', 'resume', 'timers',
  'start_over', 'substitute', 'apply_substitution', 'correct', 'recover', 'clear_recovery',
  'create_recipe', 'list_recipes', 'delete_recipe',
] as const;
type CookAction = (typeof ACTIONS)[number];

function isCookAction(v: unknown): v is CookAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

async function handle(userId: string, body: unknown): Promise<NextResponse> {
  const parsed = body as {
    action?: unknown;
    sessionId?: unknown;
    recipeId?: unknown;
    correlationId?: unknown;
    unavailableIngredient?: unknown;
    replacement?: unknown;
    name?: unknown;
    quantity?: unknown;
    unit?: unknown;
    remove?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
    failedTool?: unknown;
    prompt?: unknown;
    protein?: unknown;
  };

  const action: CookAction = isCookAction(parsed.action) ? parsed.action : 'status';
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const recipeId = typeof parsed.recipeId === 'string' ? parsed.recipeId : undefined;
  const correlationId = typeof parsed.correlationId === 'string' ? parsed.correlationId : undefined;
  const unavailableIngredient = typeof parsed.unavailableIngredient === 'string' ? parsed.unavailableIngredient : undefined;
  const replacement = typeof parsed.replacement === 'string' ? parsed.replacement : undefined;
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  const quantity = typeof parsed.quantity === 'number' ? parsed.quantity : undefined;
  const unit = typeof parsed.unit === 'string' ? parsed.unit : undefined;
  const remove = parsed.remove === true;
  const errorCode = typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined;
  const errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : undefined;
  const failedTool = typeof parsed.failedTool === 'string' ? parsed.failedTool : undefined;
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : undefined;

  const ctx = buildProductionContext(userId, correlationId);
  const guide = createGuideService(ctx);

  switch (action) {
    case 'launch': {
      if (!recipeId) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'launch requires a recipeId', recoverable: false } },
          { status: 400 },
        );
      }
      const snapshot = await guide.launchCookWithMe(userId, recipeId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'done': {
      const snapshot = await guide.completeCurrentAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'repeat': {
      const snapshot = await guide.repeatAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'back': {
      const snapshot = await guide.previousAction(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'pause': {
      const snapshot = await guide.pause(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'resume': {
      const snapshot = await guide.resume(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'timers': {
      const { alerts, snapshot } = await guide.checkTimers(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: { alerts, snapshot } });
    }
    case 'start_over': {
      const snapshot = await guide.startOver(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'substitute': {
      if (!unavailableIngredient) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'substitute requires an unavailableIngredient', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.requestSubstitution(userId, sessionId, unavailableIngredient, { correlationId });
      return NextResponse.json({ success: true, data: result });
    }
    case 'apply_substitution': {
      if (!replacement) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'apply_substitution requires a replacement', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.applySubstitution(userId, sessionId, {
        unavailableIngredient: unavailableIngredient ?? '',
        replacement,
      }, { correlationId });
      return NextResponse.json({ success: true, data: result });
    }
    case 'correct': {
      if (!name) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'correct requires an ingredient name', recoverable: false } },
          { status: 400 },
        );
      }
      const result = await guide.correctAvailableIngredients(
        userId,
        sessionId,
        [{
          id: `ing-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name,
          quantity: quantity ?? null,
          unit: unit ?? null,
          optional: false,
        }],
        remove ? 'REMOVE' : 'UPSERT',
        { correlationId },
      );
      return NextResponse.json({ success: true, data: result });
    }
    case 'recover': {
      const decision = await guide.recoverAfterError(userId, sessionId, {
        code: errorCode ?? 'INTERNAL_ERROR',
        message: errorMessage,
        failedTool,
        recoverable: true,
      }, { correlationId });
      return NextResponse.json({ success: true, data: decision });
    }
    case 'clear_recovery': {
      const snapshot = await guide.clearRecovery(userId, sessionId, { correlationId });
      return NextResponse.json({ success: true, data: snapshot });
    }
    case 'delete_recipe': {
      // Remove a saved recipe from the browser — the UI's delete action, so
      // users don't need Firebase surgery to prune their "Your recipes" list.
      // Ownership is verified HERE (never trust the id alone): a user must
      // only ever delete their own recipe.
      if (!recipeId) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'delete_recipe requires a recipeId', recoverable: false } },
          { status: 400 },
        );
      }
      const recipeStore = ctx.recipeStore;
      if (!recipeStore) {
        return NextResponse.json(
          { success: false, error: { code: 'UNAVAILABLE', message: 'Recipe store not available', recoverable: false } },
          { status: 500 },
        );
      }
      const recipe = await recipeStore.getRecipe(recipeId);
      if (!recipe || recipe.userId !== userId) {
        return NextResponse.json(
          { success: false, error: { code: 'NOT_FOUND', message: 'Recipe not found', recoverable: false } },
          { status: 404 },
        );
      }
      await recipeStore.deleteRecipe(recipeId);
      return NextResponse.json({ success: true, data: { deleted: recipeId } });
    }
    case 'list_recipes': {
      // "Your recipes" on the /cook starter: the owner's generated recipes,
      // newest first, as lightweight summaries (never the full step lists).
      // One tap on a row launches a fresh session pinned to that recipe.
      const protein = typeof parsed.protein === 'string' && parsed.protein.trim()
        ? parsed.protein.trim().toLowerCase()
        : undefined;
      let owned = await ctx.recipeStore?.listRecipes(userId) ?? [];
      // Client-side filter by protein category (simple enough to not warrant a
      // composite index — listRecipes returns the full set per user).
      if (protein) {
        owned = owned.filter((r) =>
          r.proteinCategories?.some((c) => c === protein),
        );
      }
      const recipes = owned
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((r) => ({
          recipeId: r.id,
          title: r.title,
          servings: r.servings,
          totalMinutes: r.totalMinutes,
          ingredientCount: r.ingredients.length,
          proteinCategories: r.proteinCategories ?? [],
          // What the recipe was built for (parsed from the creation prompt) —
          // old/agent-generated recipes carry none and get a safe empty shape.
          preferences: r.preferences ?? { servings: null, allergies: [], dietaryRestrictions: [] },
          updatedAt: r.updatedAt,
        }));
      return NextResponse.json({ success: true, data: { recipes } });
    }
    case 'create_recipe': {
      // The missing "start" stage: turn "chicken, rice and onion" into a
      // validated, persisted recipe the user can immediately launch. This is
      // the UI the /cook empty state now points at — before this, the only
      // way to get a session was an already-existing recipeId.
      if (!prompt || !prompt.trim()) {
        return NextResponse.json(
          { success: false, error: { code: 'INVALID_BODY', message: 'create_recipe requires a prompt', recoverable: false } },
          { status: 400 },
        );
      }
      // Parse servings / allergies / dietary restrictions out of the prompt
      // FIRST ("for 4 people, no peanuts, vegetarian"), then strip the exact
      // spans they consumed before ingredient extraction — otherwise "rice
      // for 4 people" would become an ingredient name.
      const prefs = extractRecipePreferences(prompt);
      let ingredientsPrompt = prompt;
      for (const span of prefs.matched) {
        ingredientsPrompt = ingredientsPrompt.replace(
          new RegExp(span.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          ' ',
        );
      }
      // A stripped span can leave a dangling separator ("rice — for 2" →
      // "rice — ") or doubled commas. Collapse them so the residue reads as
      // a plain list — otherwise the retry below could name an ingredient
      // "rice —" instead of "rice".
      ingredientsPrompt = ingredientsPrompt
        .replace(/[—–]+/g, ',')
        .replace(/,(\s*,)+/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '');
      // Parse what the user has. Plain lists ("chicken, rice and onion") need
      // the possession lead-in to trip the extractor's brain-dump gate; the
      // "I have …" retry covers that. Anything else that fails to parse is an
      // honest NO_INGREDIENTS, not a silent fallback.
      let ingredients = extractIngredients(ingredientsPrompt);
      if (ingredients.length === 0) ingredients = extractIngredients(`I have ${ingredientsPrompt.trim()}`);
      if (ingredients.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'NO_INGREDIENTS',
              message: 'Tell me what you have to cook with, e.g. “chicken, rice and onion”.',
              recoverable: true,
            },
          },
          { status: 400 },
        );
      }
      // Parse through the tool's OWN inputSchema (not a raw object): the
      // schema fills the defaulted arrays (dietaryRestrictions, allergies,
      // …) that buildGenerationPrompt reads — a raw `{ ingredientsAvailable,
      // servings }` object crashed the deployed route on
      // `undefined.length` because the direct handler call skips the
      // executeTool zod layer.
      const parsedInput = generateRecipeTool.inputSchema.safeParse({
        request: {
          ingredientsAvailable: ingredients,
          servings: prefs.servings ?? 2,
          allergies: prefs.allergies,
          dietaryRestrictions: prefs.dietaryRestrictions,
        },
      });
      if (!parsedInput.success) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_BODY',
              message: 'Could not build a recipe request from that input.',
              recoverable: true,
            },
          },
          { status: 400 },
        );
      }
      const result = await generateRecipeTool.handler(ctx, parsedInput.data);
      const generated = (result.data ?? {}) as { recipe?: Recipe };
      if (!result.success || !generated.recipe) {
        return NextResponse.json(
          {
            success: false,
            error: result.error ?? { code: 'GENERATION_FAILED', message: 'Could not create a recipe from that.', recoverable: true },
          },
          { status: 400 },
        );
      }
      const recipe = generated.recipe;
      // Validate before offering "Start cooking" — the user never hears a
      // recipe as approved until validation succeeds. Unavailable items are
      // surfaced as confirmations ("you'll also need salt"), not hard errors.
      const validation = validateRecipe(recipe, {
        availableIngredients: ingredients.map((i) => i.name),
      });
      return NextResponse.json({
        success: true,
        data: {
          recipeId: recipe.id,
          title: recipe.title,
          servings: recipe.servings,
          proteinCategories: recipe.proteinCategories ?? [],
          // Echo only the parsed preferences — never the internal `matched` spans.
          preferences: {
            servings: prefs.servings,
            allergies: prefs.allergies,
            dietaryRestrictions: prefs.dietaryRestrictions,
          },
          validation: {
            valid: validation.valid,
            errors: validation.errors.slice(0, 5).map((e) => e.message),
            confirmations: validation.missingConfirmations.slice(0, 8).map((c) => c.item),
          },
        },
      });
    }
    default: {
      const snapshot = await guide.getCurrentAction(userId, sessionId);
      return NextResponse.json({ success: true, data: snapshot });
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

  // Auto-generate correlation ID when the client doesn't supply one.
  // This threads the same id through every logger call + tool log inside this request.
  const rawCid = (body as Record<string, unknown> | null)?.correlationId;
  const correlationId: string = (typeof rawCid === 'string' ? rawCid : undefined) ?? generateCorrelationId();

  const startedAt = Date.now();
  logInfo('api.cook.request', {
    correlationId,
    userId: userId.slice(0, 10),
    action: String((body as Record<string, unknown>)?.action ?? 'status'),
  });

  return runWithContext(correlationId, async () => {
    try {
      return await handle(userId, body);
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
      const code: string = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
      const msg: string = typeof err.message === 'string' ? err.message : 'Guided cooking request failed';
      const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
      logError('api.cook.error', {
        correlationId,
        userId: userId.slice(0, 10),
        code,
        message: msg.slice(0, 300),
        latencyMs: Date.now() - startedAt,
      });
      return NextResponse.json({ success: false, error: { code, message: msg, recoverable } }, { status: 400 });
    } finally {
      logInfo('api.cook.response', {
        correlationId,
        latencyMs: Date.now() - startedAt,
      });
    }
  });
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
    const snapshot = await handle(userId, { action: 'status' });
    return snapshot;
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    const message = typeof err.message === 'string' ? err.message : 'Guided cooking request failed';
    const recoverable = typeof err.recoverable === 'boolean' ? err.recoverable : true;
    return NextResponse.json({ success: false, error: { code, message, recoverable } }, { status: 400 });
  }
}
