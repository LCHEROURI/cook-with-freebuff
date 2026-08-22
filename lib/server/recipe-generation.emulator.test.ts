import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DietaryProfile, Recipe } from '../domain/types';
import {
  AUTO_BOOT,
  bootEmulator,
  EMULATOR_HOST,
} from '../../scripts/emulator-test-helper';
import {
  hashEffectiveSafetyContext,
  recipeGenerationMarkerId,
} from './recipe-generation';

vi.mock('server-only', () => ({}));

let emulator: { stop: () => Promise<void> } | null = null;
let bootError = '';
try {
  emulator = await bootEmulator();
} catch (error) {
  bootError = error instanceof Error ? error.message : String(error);
}
if (!emulator && AUTO_BOOT) {
  throw new Error(`RUN_EMULATOR_TESTS=1 but the Firestore emulator could not start:\n${bootError}`);
}

let repo: typeof import('./repositories');
let admin: typeof import('./admin');

beforeAll(async () => {
  process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  repo = await import('./repositories');
  admin = await import('./admin');
});

function makeRecipe(id: string, userId: string): Recipe {
  const now = Date.now();
  return {
    id,
    userId,
    title: 'Rice and beans',
    description: 'A complete dinner',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 20,
    totalMinutes: 25,
    ingredients: [
      { id: 'rice', name: 'rice', quantity: 1, unit: 'cup', optional: false },
      { id: 'beans', name: 'black beans', quantity: 1, unit: 'can', optional: false },
    ],
    equipment: ['pot'],
    prepSteps: [],
    cookingSteps: [{
      id: 'cook-1',
      stepNumber: 1,
      instruction: 'Cook the rice and beans',
      spokenInstruction: 'Cook the rice and beans',
      estimatedSeconds: 1200,
      ingredientsUsed: ['rice', 'black beans'],
      equipmentUsed: ['pot'],
    }],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: now,
    updatedAt: now,
  };
}

describe.skipIf(!emulator)('recipe-generation fencing · Firestore emulator', () => {
  afterAll(async () => {
    await emulator?.stop();
  });

  it('atomically persists only the current lease holder result', async () => {
    const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const userId = `user-${run}`;
    const markerId = recipeGenerationMarkerId(userId, `request-${run}`);
    const common = {
      markerId,
      userId,
      requestHash: 'c'.repeat(64),
      safetyContextHash: hashEffectiveSafetyContext({ allergies: [], dietaryRestrictions: [] }),
      requestedAllergies: [],
      requestedDietaryRestrictions: [],
      leaseMs: 100,
    };
    const first = { ...common, leaseToken: `lease-a-${run}`, now: 1_000 };
    const successor = { ...common, leaseToken: `lease-b-${run}`, now: 1_101 };
    const firstRecipe = makeRecipe(`recipe-a-${run}`, userId);
    const successorRecipe = makeRecipe(`recipe-b-${run}`, userId);

    try {
      expect(await repo.claimRecipeGeneration(first)).toMatchObject({ status: 'acquired' });
      expect(await repo.claimRecipeGeneration(successor)).toMatchObject({ status: 'acquired' });
      expect(await repo.completeRecipeGeneration({ ...first, now: 1_102, recipe: firstRecipe }))
        .toEqual({ status: 'superseded' });
      expect(await repo.failRecipeGeneration({ ...first, now: 1_102 })).toBe(false);
      expect(await repo.completeRecipeGeneration({
        ...successor,
        now: 1_102,
        recipe: successorRecipe,
      })).toEqual({ status: 'completed' });

      expect(await repo.getRecipe(firstRecipe.id)).toBeNull();
      expect(await repo.getRecipe(successorRecipe.id)).toMatchObject({ id: successorRecipe.id, userId });
      expect(await repo.claimRecipeGeneration({
        ...successor,
        leaseToken: `lease-c-${run}`,
        now: 1_103,
      })).toEqual({ status: 'completed', recipeId: successorRecipe.id });
    } finally {
      const db = admin.getAdminDb();
      if (db) {
        await db.collection('recipes').doc(firstRecipe.id).delete();
        await db.collection('recipes').doc(successorRecipe.id).delete();
        await db.collection('correlation_markers').doc(repo.markerKey(markerId)).delete();
      }
    }
  }, 30_000);

  it('rejects a profile change atomically without a recipe or successful marker', async () => {
    const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const userId = `profile-change-${run}`;
    const markerId = recipeGenerationMarkerId(userId, `request-${run}`);
    const recipe = {
      ...makeRecipe(`recipe-${run}`, userId),
      ingredients: [
        { id: 'peanut-butter', name: 'peanut butter', quantity: 1, unit: 'tbsp', optional: false },
      ],
      cookingSteps: [],
    };
    const initialProfile: DietaryProfile = {
      userId,
      allergies: [],
      dietaryRestrictions: [],
      dislikedIngredients: [],
      preferredCuisines: [],
      preferredEquipment: [],
      updatedAt: 1,
    };
    const lease = {
      markerId,
      userId,
      requestHash: 'd'.repeat(64),
      safetyContextHash: hashEffectiveSafetyContext(initialProfile),
      requestedAllergies: [],
      requestedDietaryRestrictions: [],
      leaseToken: `lease-${run}`,
      now: 2_000,
      leaseMs: 100,
    };

    try {
      await repo.upsertDietaryProfile(initialProfile);
      expect(await repo.claimRecipeGeneration(lease)).toMatchObject({ status: 'acquired' });
      await repo.upsertDietaryProfile({
        ...initialProfile,
        allergies: ['peanuts'],
        updatedAt: 2,
      });

      expect(await repo.completeRecipeGeneration({ ...lease, now: 2_001, recipe }))
        .toEqual({ status: 'safety_context_changed', code: 'SAFETY_CONTEXT_CHANGED' });
      expect(await repo.getRecipe(recipe.id)).toBeNull();

      const db = admin.getAdminDb();
      const marker = await db?.collection('correlation_markers').doc(repo.markerKey(markerId)).get();
      expect(marker?.data()).toMatchObject({
        status: 'failed',
        failureCode: 'SAFETY_CONTEXT_CHANGED',
      });
      expect(marker?.data()?.recipeId).toBeUndefined();
    } finally {
      const db = admin.getAdminDb();
      if (db) {
        await db.collection('recipes').doc(recipe.id).delete();
        await db.collection('dietary_profiles').doc(userId).delete();
        await db.collection('correlation_markers').doc(repo.markerKey(markerId)).delete();
      }
    }
  }, 30_000);
});
