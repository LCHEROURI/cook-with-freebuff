import { describe, it, expect } from 'vitest';
import { findSubstitutionCandidates } from './substitute';
import type { Recipe } from '../domain/types';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  const t = Date.now();
  return {
    id: 'r1',
    userId: 'u1',
    title: 'Test',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 10,
    totalMinutes: 15,
    ingredients: [
      { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'i2', name: 'garlic', quantity: 2, unit: 'cloves', optional: false },
      { id: 'i3', name: 'milk', quantity: 1, unit: 'cup', optional: false },
    ],
    equipment: ['pan'],
    prepSteps: [],
    cookingSteps: [],
    dietaryTags: [],
    allergens: [],
    safetyNotes: [],
    generatedAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe('findSubstitutionCandidates', () => {
  it('returns map candidates for a known ingredient', () => {
    const candidates = findSubstitutionCandidates(makeRecipe(), 'garlic', []);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.ingredient === 'garlic powder')).toBe(true);
    expect(candidates.every((c) => c.ratio.length > 0)).toBe(true);
  });

  it('ranks pantry items first', () => {
    const candidates = findSubstitutionCandidates(makeRecipe(), 'milk', ['heavy cream']);
    expect(candidates[0].ingredient).toBe('heavy cream');
  });

  it('excludes anything already in the recipe', () => {
    // "garlic" is in the recipe — garlic powder etc. are not; but test that an
    // ingredient already present is never suggested.
    const candidates = findSubstitutionCandidates(
      makeRecipe({ ingredients: [...makeRecipe().ingredients, { id: 'x', name: 'garlic powder', quantity: null, unit: null, optional: false }] }),
      'garlic',
      [],
    );
    expect(candidates.some((c) => c.ingredient === 'garlic powder')).toBe(false);
  });

  it('returns [] for unknown ingredients — never invented', () => {
    expect(findSubstitutionCandidates(makeRecipe(), 'starfruit essence', [])).toEqual([]);
  });

  it('caps at 3 candidates', () => {
    const candidates = findSubstitutionCandidates(makeRecipe(), 'butter', []);
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it('is case-insensitive and trims input', () => {
    const a = findSubstitutionCandidates(makeRecipe(), 'GARLIC', []);
    const b = findSubstitutionCandidates(makeRecipe(), '  garlic  ', []);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
