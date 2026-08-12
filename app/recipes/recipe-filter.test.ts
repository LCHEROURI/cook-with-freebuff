import { describe, expect, it } from 'vitest';
import {
  availableCategories,
  filterAndSortRecipes,
  type RecipeSummary,
} from './recipe-filter';

// ============================================================================
// app/recipes/recipe-filter.test.ts — lock the search / filter / sort contract.
//
// The recipes page is a thin view over this module: a future edit that breaks
// category matching, text search, or ordering fails here before it ships.
// ============================================================================

const recipe = (over: Partial<RecipeSummary>): RecipeSummary => ({
  recipeId: 'r1',
  title: 'Recipe',
  servings: 4,
  totalMinutes: 40,
  ingredientCount: 6,
  proteinCategories: [],
  updatedAt: 1000,
  ...over,
});

const CHICKEN = recipe({ recipeId: 'c', title: 'Simple Chicken and Rice', proteinCategories: ['chicken'], totalMinutes: 30, updatedAt: 3000 });
const BEEF = recipe({ recipeId: 'b', title: 'Beef Stew', proteinCategories: ['beef'], totalMinutes: 90, updatedAt: 2000 });
const VEG = recipe({
  recipeId: 'v',
  title: 'Lentil Bowl',
  proteinCategories: ['vegetarian', 'vegan'],
  totalMinutes: 25,
  updatedAt: 1000,
  preferences: { servings: 2, allergies: ['peanuts'], dietaryRestrictions: ['vegan'] },
});

const ALL = [CHICKEN, BEEF, VEG];

describe('filterAndSortRecipes · category filter', () => {
  it('returns every recipe when no protein category is selected', () => {
    expect(filterAndSortRecipes(ALL, { query: '', protein: '', sort: 'newest' })).toHaveLength(3);
  });

  it('keeps only the selected protein category', () => {
    const out = filterAndSortRecipes(ALL, { query: '', protein: 'chicken', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['c']);
  });

  it('matches dietary categories too (vegetarian / vegan are protein categories)', () => {
    const out = filterAndSortRecipes(ALL, { query: '', protein: 'vegetarian', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['v']);
  });

  it('returns an empty list for a category nobody has', () => {
    expect(filterAndSortRecipes(ALL, { query: '', protein: 'pork', sort: 'newest' })).toHaveLength(0);
  });
});

describe('filterAndSortRecipes · text search', () => {
  it('matches the title case-insensitively', () => {
    const out = filterAndSortRecipes(ALL, { query: 'CHICKEN', protein: '', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['c']);
  });

  it('matches a dietary restriction from the build preferences', () => {
    const out = filterAndSortRecipes(ALL, { query: 'vegan', protein: '', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['v']);
  });

  it('matches an avoided allergen from the build preferences', () => {
    const out = filterAndSortRecipes(ALL, { query: 'peanuts', protein: '', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['v']);
  });

  it('combines text and category filters (both must match)', () => {
    // "chicken" + text "stew" → no match (stew is beef); category narrows first.
    const out = filterAndSortRecipes(ALL, { query: 'stew', protein: 'chicken', sort: 'newest' });
    expect(out).toHaveLength(0);
  });

  it('ignores surrounding whitespace in the query', () => {
    const out = filterAndSortRecipes(ALL, { query: '  chicken  ', protein: '', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['c']);
  });

  it('returns everything for a blank query', () => {
    expect(filterAndSortRecipes(ALL, { query: '   ', protein: '', sort: 'newest' })).toHaveLength(3);
  });
});

describe('filterAndSortRecipes · sort', () => {
  it('newest sorts by updatedAt descending', () => {
    const out = filterAndSortRecipes(ALL, { query: '', protein: '', sort: 'newest' });
    expect(out.map((r) => r.recipeId)).toEqual(['c', 'b', 'v']);
  });

  it('quickest sorts by totalMinutes ascending', () => {
    const out = filterAndSortRecipes(ALL, { query: '', protein: '', sort: 'quickest' });
    expect(out.map((r) => r.recipeId)).toEqual(['v', 'c', 'b']);
  });

  it('title sorts alphabetically', () => {
    const out = filterAndSortRecipes(ALL, { query: '', protein: '', sort: 'title' });
    expect(out.map((r) => r.title)).toEqual(['Beef Stew', 'Lentil Bowl', 'Simple Chicken and Rice']);
  });

  it('does not mutate the input array', () => {
    const before = [...ALL];
    filterAndSortRecipes(ALL, { query: '', protein: '', sort: 'quickest' });
    expect(ALL).toEqual(before);
  });
});

describe('availableCategories', () => {
  it('returns the distinct categories, sorted and deduplicated', () => {
    expect(availableCategories(ALL)).toEqual(['beef', 'chicken', 'vegan', 'vegetarian']);
  });

  it('returns an empty list when there are no recipes', () => {
    expect(availableCategories([])).toEqual([]);
  });
});
