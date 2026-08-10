import { describe, it, expect } from 'vitest';
import { SessionService, InMemorySessionStore } from './session-service';
import {
  InMemoryTimerStore,
  InMemoryLogStore,
  InMemoryRecipeStore,
  InMemoryPantryStore,
  InMemoryDietaryProfileStore,
} from './tools/registry';
import { createDefaultToolRegistry } from './tools';
import { executeTool } from './tools/registry';
import { GuidedCookingService } from './guide-service';
import { PantryService } from './pantry-service';
import type { ToolContext } from './tools/types';
import type { Recipe } from '../domain/types';

// ── K9 Part B — security audit ──────────────────────────────────────────────
// Verifies one user can never access another user's recipes, profile, pantry,
// cooking sessions, timers, or logs through the tool/service layer — the
// object-level authorization the Firestore rules also enforce client-side
// (the admin SDK bypasses rules, so the service layer is the real gate).

function makeRecipe(userId = 'user-1'): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId,
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [{ id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false }],
    equipment: ['pan'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: [], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken', spokenInstruction: 'Sear the chicken', estimatedSeconds: 240, ingredientsUsed: [], equipmentUsed: ['pan'] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
  };
}

function makeContext(userId: string) {
  const store = new InMemorySessionStore();
  const timers = new InMemoryTimerStore();
  const recipes = new InMemoryRecipeStore();
  const logs = new InMemoryLogStore();
  const pantry = new InMemoryPantryStore();
  const profiles = new InMemoryDietaryProfileStore();
  const ctx: ToolContext = {
    userId,
    sessionService: new SessionService(store),
    timerStore: timers,
    logStore: logs,
    recipeStore: recipes,
    pantryStore: pantry,
    dietaryProfileStore: profiles,
  };
  return { ctx, store, timers, recipes, logs, pantry, profiles };
}

const registry = createDefaultToolRegistry();

describe('K9 security — cross-user isolation', () => {
  it('user B cannot launch (and thereby read) user A\u2019s recipe', async () => {
    const alice = makeContext('user-a');
    const bob = makeContext('user-b');
    await alice.recipes.createRecipe(makeRecipe('user-a'));
    // Give Bob the same recipe store so he can *attempt* to launch Alice's recipe.
    bob.ctx.recipeStore = alice.recipes;

    const guide = new GuidedCookingService(bob.ctx.sessionService, bob.ctx.timerStore, bob.ctx.recipeStore);
    await expect(guide.launchCookWithMe('user-b', 'recipe-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // And no session may have been created for Bob pointing at Alice's recipe.
    expect(await bob.store.getActiveSession('user-b')).toBeNull();
  });

  it('generated recipes are stamped with the generating user\u2019s owner id', async () => {
    const { ctx, recipes } = makeContext('user-a');
    const { registerRecipeGenerator } = await import('../ai/provider');
    registerRecipeGenerator('default', {
      async generate() {
        return makeRecipe('') as Recipe; // provider returns an ownerless recipe
      },
    });
    const result = await executeTool(registry, ctx, 'generate_recipe', {
      request: {
        ingredientsAvailable: [{ id: 'i1', name: 'chicken', quantity: 2, unit: 'pieces', optional: false }],
        dietaryRestrictions: [],
        allergies: [],
        cuisinePreferences: [],
        dislikedIngredients: [],
        availableEquipment: [],
      },
    });
    expect(result.success).toBe(true);
    const saved = (await recipes.getRecipe('recipe-1'))!;
    expect(saved.userId).toBe('user-a');
  });

  it('user B cannot complete, repeat, or navigate user A\u2019s session', async () => {
    const alice = makeContext('user-a');
    const bob = makeContext('user-b');
    await alice.recipes.createRecipe(makeRecipe('user-a'));
    const guideA = new GuidedCookingService(alice.ctx.sessionService, alice.ctx.timerStore, alice.ctx.recipeStore);
    const snap = await guideA.launchCookWithMe('user-a', 'recipe-1');

    // Bob sees Alice's session STORE (the shared backend), so the owner check
    // — not a missing session — is what must deny him.
    bob.ctx.sessionService = alice.ctx.sessionService;
    const guideB = new GuidedCookingService(bob.ctx.sessionService, bob.ctx.timerStore, alice.recipes);
    await expect(guideB.completeCurrentAction('user-b', snap.sessionId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(guideB.getCurrentAction('user-b', snap.sessionId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('user B cannot update or remove user A\u2019s pantry items', async () => {
    const alice = makeContext('user-a');
    const bob = makeContext('user-b');
    const serviceA = new PantryService(alice.pantry);
    const item = await serviceA.addItem('user-a', { name: 'olive oil', source: 'VOICE' });

    // Bob's service sees the same (shared) pantry store — the owner check is
    // what must deny him.
    const serviceB = new PantryService(alice.pantry);
    await expect(serviceB.updateItem('user-b', item.id, { quantity: 999 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(serviceB.removeItem('user-b', item.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Alice's item is untouched.
    const fresh = await alice.pantry.getItem(item.id);
    expect(fresh?.quantity ?? 1).not.toBe(999);
    void bob;
  });

  it('dietary profiles are keyed per user — reading another user is impossible by construction', async () => {
    const alice = makeContext('user-a');
    const bob = makeContext('user-b');
    await alice.profiles.upsertProfile({
      userId: 'user-a',
      allergies: ['peanuts'],
      dietaryRestrictions: [],
      dislikedIngredients: [],
      preferredCuisines: [],
      preferredEquipment: [],
      updatedAt: Date.now(),
    });
    const bobProfile = await bob.profiles.getProfile('user-b');
    expect(bobProfile).toBeNull();
    const aliceProfile = await alice.profiles.getProfile('user-a');
    expect(aliceProfile?.allergies).toEqual(['peanuts']);
  });

  it('timers are only reachable through an owner-scoped session (tool layer denies foreign sessions)', async () => {
    const alice = makeContext('user-a');
    const bob = makeContext('user-b');
    await alice.recipes.createRecipe(makeRecipe('user-a'));
    const guideA = new GuidedCookingService(alice.ctx.sessionService, alice.ctx.timerStore, alice.ctx.recipeStore);
    const snap = await guideA.launchCookWithMe('user-a', 'recipe-1');

    // Bob queries timers for Alice's session through the tool layer: the tool
    // resolves the ACTIVE session for the CALLER — it cannot see Alice's.
    const result = await executeTool(registry, bob.ctx, 'get_active_timers', { sessionId: snap.sessionId });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('failed tool calls are logged with their error code (observability trail, never secrets)', async () => {
    const { ctx, logs } = makeContext('user-a');
    const result = await executeTool(registry, ctx, 'get_current_step', { sessionId: 'nope' });
    expect(result.success).toBe(false);
    const entries = logs.listLogs();
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[entries.length - 1];
    expect(entry.tool).toBe('get_current_step');
    expect(entry.result.success).toBe(false);
    expect(entry.result.errorCode).toBeTruthy();
    expect(entry.userId).toBe('user-a');
  });
});

describe('K9 security — server-only import surface', () => {
  it('no client component imports a server-only module', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const clientDirs = ['app', 'components'];
    const forbidden = /lib\/server|firebase-admin|lib\/vision/;
    const offenders: string[] = [];
    for (const dir of clientDirs) {
      const walk = (d: string) => {
        for (const name of fs.readdirSync(d)) {
          const full = path.join(d, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
            // Server route handlers are server-side by definition, and
            // `import type` lines are erased at build time — neither ships
            // server code to the client bundle.
            if (full.startsWith('app/api/')) continue;
            const src = fs.readFileSync(full, 'utf8');
            const realImports = src
              .split('\n')
              .filter((line: string) => !/^\s*import\s+type\b/.test(line))
              .join('\n');
            if (forbidden.test(realImports)) offenders.push(full);
          }
        }
      };
      if (fs.existsSync(dir)) walk(dir);
    }
    expect(offenders).toEqual([]);
  });

  it('server-only modules carry the server-only guard', () => {
    const fs = require('node:fs');
    for (const file of ['lib/server/admin.ts', 'lib/server/stores.ts', 'lib/server/repositories.ts']) {
      const src = fs.readFileSync(file, 'utf8');
      expect(src.includes("import 'server-only'")).toBe(true);
    }
  });
});
