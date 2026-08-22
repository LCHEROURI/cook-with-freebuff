import { describe, expect, it } from 'vitest';
import type { RecipeRequest } from '../ai/types';
import type { DietaryProfile, Recipe } from '../domain/types';
import { InMemoryRecipeGenerationStore, InMemoryRecipeStore } from './tools';
import {
  effectiveRecipeRequest,
  hashEffectiveRecipeRequest,
  hashEffectiveSafetyContext,
  recipeGenerationMarkerId,
} from './recipe-generation';

function request(): RecipeRequest {
  return {
    ingredientsAvailable: [
      { id: 'rice', name: 'Rice', quantity: 1, unit: 'cup', optional: false },
      { id: 'beans', name: 'Black beans', quantity: 1, unit: 'can', optional: false },
    ],
    servings: 2,
    dietaryRestrictions: [],
    allergies: [],
    cuisinePreferences: [],
    dislikedIngredients: [],
    availableEquipment: [],
  };
}

function profile(overrides: Partial<DietaryProfile> = {}): DietaryProfile {
  return {
    userId: 'user-1',
    allergies: [],
    dietaryRestrictions: [],
    dislikedIngredients: [],
    preferredCuisines: [],
    preferredEquipment: [],
    updatedAt: 1,
    ...overrides,
  };
}

function recipe(id: string): Recipe {
  return {
    id,
    userId: 'user-1',
    title: 'Rice and beans',
    description: 'A complete dinner',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 20,
    totalMinutes: 25,
    ingredients: request().ingredientsAvailable,
    equipment: ['pot'],
    prepSteps: [],
    cookingSteps: [{
      id: 'cook-1',
      stepNumber: 1,
      instruction: 'Cook the rice and beans',
      spokenInstruction: 'Cook the rice and beans',
      estimatedSeconds: 1200,
      ingredientsUsed: ['Rice', 'Black beans'],
      equipmentUsed: ['pot'],
    }],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: 1,
    updatedAt: 1,
  };
}

describe('effective recipe request identity', () => {
  it('incorporates current authenticated safety constraints before hashing', () => {
    const first = effectiveRecipeRequest(request(), profile({ dietaryRestrictions: ['gluten-free'] }));
    const changed = effectiveRecipeRequest(request(), profile({
      allergies: ['Peanuts'],
      dietaryRestrictions: ['gluten-free'],
    }));

    expect(first.dietaryRestrictions).toEqual(['gluten-free']);
    expect(changed.allergies).toEqual(['Peanuts']);
    expect(hashEffectiveRecipeRequest(changed)).not.toBe(hashEffectiveRecipeRequest(first));
  });

  it('canonicalizes unordered inputs without changing request equivalence', () => {
    const first = request();
    const reordered = {
      ...request(),
      ingredientsAvailable: [...request().ingredientsAvailable].reverse(),
      allergies: ['sesame', 'peanuts'],
    };
    const original = { ...first, allergies: ['peanuts', 'sesame'] };

    expect(hashEffectiveRecipeRequest(reordered)).toBe(hashEffectiveRecipeRequest(original));
  });
});

describe('generation lease fencing', () => {
  it('lets a stale lease recompute but only the successor persist and complete', async () => {
    const recipes = new InMemoryRecipeStore();
    const store = new InMemoryRecipeGenerationStore(recipes);
    const markerId = recipeGenerationMarkerId('user-1', 'same-request');
    const common = {
      markerId,
      userId: 'user-1',
      requestHash: 'a'.repeat(64),
      safetyContextHash: hashEffectiveSafetyContext({ allergies: [], dietaryRestrictions: [] }),
      requestedAllergies: [],
      requestedDietaryRestrictions: [],
      leaseMs: 100,
    };
    const first = { ...common, leaseToken: 'lease-a', now: 1_000 };
    const successor = { ...common, leaseToken: 'lease-b', now: 1_101 };

    expect(await store.claim(first)).toEqual({ status: 'acquired', leaseToken: 'lease-a' });
    expect(await store.claim(successor)).toEqual({ status: 'acquired', leaseToken: 'lease-b' });
    expect(await store.complete({ ...first, now: 1_102, recipe: recipe('recipe-a') }))
      .toEqual({ status: 'superseded' });
    expect(await store.fail({ ...first, now: 1_102 })).toBe(false);
    expect(await store.complete({ ...successor, now: 1_102, recipe: recipe('recipe-b') }))
      .toEqual({ status: 'completed' });

    expect((await recipes.listRecipes('user-1')).map((item) => item.id)).toEqual(['recipe-b']);
    expect(await store.claim({ ...successor, leaseToken: 'lease-c', now: 1_103 })).toEqual({
      status: 'completed',
      recipeId: 'recipe-b',
    });
  });

  it('isolates identical client keys by authenticated owner', async () => {
    const recipes = new InMemoryRecipeStore();
    const store = new InMemoryRecipeGenerationStore(recipes);
    const common = {
      requestHash: 'b'.repeat(64),
      safetyContextHash: hashEffectiveSafetyContext({ allergies: [], dietaryRestrictions: [] }),
      requestedAllergies: [],
      requestedDietaryRestrictions: [],
      leaseMs: 100,
      now: 1_000,
    };

    const first = await store.claim({
      ...common,
      markerId: recipeGenerationMarkerId('user-1', 'shared-key'),
      userId: 'user-1',
      leaseToken: 'user-1-lease',
    });
    const second = await store.claim({
      ...common,
      markerId: recipeGenerationMarkerId('user-2', 'shared-key'),
      userId: 'user-2',
      leaseToken: 'user-2-lease',
    });

    expect(first.status).toBe('acquired');
    expect(second.status).toBe('acquired');
  });
});
