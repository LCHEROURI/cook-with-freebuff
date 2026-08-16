import { describe, expect, it } from 'vitest';
import { scaleRecipe } from './recipe-scaler';
import type { Recipe } from '@/lib/domain/types';

// ============================================================================
// app/recipes/recipe-scaler.test.ts — lock the servings scaler contract
// (spec 0003, follow-up design D1–D5).
//
// The detail page renders this module's output: a future edit that breaks
// linear scaling, the passthrough rules, rounding, or the factor-1 identity
// fails here before it ships.
// ============================================================================

const base = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'r1',
  userId: 'u1',
  title: 'Chicken Rice',
  servings: 4,
  estimatedPrepMinutes: 10,
  estimatedCookMinutes: 25,
  totalMinutes: 35,
  ingredients: [
    { id: 'i1', name: 'rice', quantity: 2, unit: 'cups', optional: false },
    { id: 'i2', name: 'salt', quantity: 1, unit: 'pinch', optional: false },
    { id: 'i3', name: 'pepper', quantity: null, unit: null, optional: false },
    { id: 'i4', name: 'oil', quantity: 1, unit: 'tbsp', optional: true },
  ],
  equipment: ['pan', 'knife'],
  prepSteps: [
    {
      id: 'p1',
      stepNumber: 1,
      instruction: 'Dice the onion',
      spokenInstruction: 'Dice the onion',
      estimatedSeconds: 120,
      ingredientsUsed: ['onion'],
      equipmentUsed: ['knife'],
    },
  ],
  cookingSteps: [
    {
      id: 'c1',
      stepNumber: 1,
      instruction: 'Sear the chicken',
      spokenInstruction: 'Sear the chicken',
      estimatedSeconds: 240,
      timerSeconds: 240,
      temperature: 180,
      temperatureUnit: 'C',
      heatLevel: 'medium-high',
      ingredientsUsed: ['chicken'],
      equipmentUsed: ['pan'],
      safetyNote: 'Hot oil',
    },
  ],
  dietaryTags: ['gluten-free'],
  allergens: [],
  safetyNotes: ['Hot oil'],
  generatedAt: 1000,
  updatedAt: 1000,
  ...over,
});

const scaledIngredients = (r: Recipe) => r.ingredients.map((i) => i.quantity);

describe('scaleRecipe · linear multiplication (D1)', () => {
  it('scales every scalable quantity by target / servings', () => {
    // 4 servings → 6: factor 1.5. 2 cups → 3 cups; 1 tbsp → 1.5 tbsp.
    const out = scaleRecipe(base(), 6);
    expect(scaledIngredients(out)).toEqual([3, 1, null, 1.5]);
  });

  it('marks the copy as the target serving count', () => {
    expect(scaleRecipe(base(), 6).servings).toBe(6);
  });
});

describe('scaleRecipe · passthrough rules (D2)', () => {
  it('keeps null quantities null — never invented', () => {
    const out = scaleRecipe(base(), 8); // factor 2
    expect(out.ingredients[2]).toEqual({ id: 'i3', name: 'pepper', quantity: null, unit: null, optional: false });
  });

  it('never scales pinch / dash / to taste / as needed / handful units', () => {
    const r = base({
      ingredients: [
        { id: 'a', name: 'salt', quantity: 1, unit: 'pinch', optional: false },
        { id: 'b', name: 'paprika', quantity: 2, unit: 'dash', optional: false },
        { id: 'c', name: 'herbs', quantity: 1, unit: 'handful', optional: false },
      ],
    });
    const out = scaleRecipe(r, 8); // factor 2 — would double if scaled
    expect(out.ingredients.map((i) => i.quantity)).toEqual([1, 2, 1]);
  });

  it('still scales optional ingredients (optional means skippable, not quantityless)', () => {
    const out = scaleRecipe(base(), 6);
    expect(out.ingredients[3]).toEqual({ id: 'i4', name: 'oil', quantity: 1.5, unit: 'tbsp', optional: true });
  });
});

describe('scaleRecipe · rounding (D3)', () => {
  it('rounds to the nearest 1/4 of the unit', () => {
    const r = base({ ingredients: [{ id: 'a', name: 'flour', quantity: 0.5, unit: 'cup', optional: false }] });
    // 0.5 × 1.5 = 0.75 → exactly ¾, no drift.
    expect(scaleRecipe(r, 6).ingredients[0].quantity).toBe(0.75);
  });

  it('keeps whole numbers whole', () => {
    const r = base({ ingredients: [{ id: 'a', name: 'eggs', quantity: 2, unit: 'pieces', optional: false }] });
    expect(scaleRecipe(r, 6).ingredients[0].quantity).toBe(3);
  });

  it('rounds values ≥ 10 to whole numbers', () => {
    const r = base({
      ingredients: [
        { id: 'a', name: 'cloves', quantity: 8, unit: 'cloves', optional: false }, // 8 × 1.5 = 12
        { id: 'b', name: 'slices', quantity: 11, unit: 'slices', optional: false }, // 11 × 1.5 = 16.5 → 17
      ],
    });
    expect(scaleRecipe(r, 6).ingredients.map((i) => i.quantity)).toEqual([12, 17]);
  });
});

describe('scaleRecipe · guards', () => {
  it('falls back to factor 1 when servings is 0 — no divide-by-zero', () => {
    const r = base({ servings: 0 });
    const out = scaleRecipe(r, 6);
    expect(scaledIngredients(out)).toEqual([2, 1, null, 1]);
  });

  it('throws on a zero or negative target', () => {
    expect(() => scaleRecipe(base(), 0)).toThrow();
    expect(() => scaleRecipe(base(), -2)).toThrow();
  });

  it('throws on a non-integer target', () => {
    expect(() => scaleRecipe(base(), 2.5)).toThrow();
  });
});

describe('scaleRecipe · untouched fields (D1, D2)', () => {
  it('keeps timers, temperatures, heat, safety notes, and total minutes at the stored values', () => {
    const r = base();
    const out = scaleRecipe(r, 6);
    expect(out.cookingSteps).toEqual(r.cookingSteps);
    expect(out.prepSteps).toEqual(r.prepSteps);
    expect(out.totalMinutes).toBe(35);
    expect(out.equipment).toEqual(r.equipment);
    expect(out.safetyNotes).toEqual(r.safetyNotes);
    expect(out.dietaryTags).toEqual(r.dietaryTags);
  });
});

describe('scaleRecipe · immutability and identity', () => {
  it('is a display copy: the stored recipe and its ingredients are never mutated', () => {
    const r = base();
    const before = structuredClone(r);
    scaleRecipe(r, 6);
    expect(r).toEqual(before);
  });

  it('is idempotent at factor 1 — renders exactly as stored', () => {
    const r = base();
    const out = scaleRecipe(r, r.servings);
    expect(out.ingredients).toEqual(r.ingredients);
    expect(scaledIngredients(out)).toEqual([2, 1, null, 1]);
  });

  it('returns a new recipe object, not the input reference', () => {
    const r = base();
    expect(scaleRecipe(r, 6)).not.toBe(r);
  });
});
