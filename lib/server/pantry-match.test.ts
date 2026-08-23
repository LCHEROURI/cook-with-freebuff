import { describe, expect, it } from 'vitest';
import {
  matchRecipeToPantry,
  rankRecipeMatches,
  rankExpiringSoonMatches,
  aggregateGroceryNeeds,
  type RecipePantryMatch,
} from './pantry-match';
import type { Ingredient, PantryItem } from '../domain/types';
import type { PantryItemView } from './pantry-service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: 'ing-1',
    name: 'chicken breast',
    quantity: 2,
    unit: null,
    optional: false,
    ...overrides,
  };
}

function pantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
  const now = Date.now();
  return {
    id: 'pantry-1',
    userId: 'user1',
    name: 'chicken breast',
    quantity: 3,
    unit: undefined,
    confidence: 1,
    source: 'VOICE',
    lastConfirmedAt: now,
    ...overrides,
  };
}

function pantryView(overrides: Partial<PantryItemView> = {}): PantryItemView {
  const base = pantryItem();
  return {
    ...base,
    stale: false,
    expiresSoon: false,
    expired: false,
    daysUntilExpiration: null,
    ...overrides,
  };
}

function matchFor(
  ingredients: Ingredient[],
  pantry: PantryItemView[],
): ReturnType<typeof matchRecipeToPantry> {
  const result = matchRecipeToPantry(ingredients, pantry);
  result.match.recipeId = 'recipe-1';
  result.match.title = 'Test Recipe';
  result.match.servings = 2;
  result.match.totalMinutes = 30;
  return result;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('pantry-match', () => {
  describe('matchRecipeToPantry', () => {
    it('matches an ingredient when an exact pantry item exists', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', confidence: 1 })],
      );
      expect(result.match.matchedCount).toBe(1);
      expect(result.match.missingCount).toBe(0);
      expect(result.match.allIngredientsFound).toBe(true);
      expect(result.match.matchPercent).toBe(100);
    });

    it('normalizes whitespace and case in ingredient names', () => {
      const result = matchFor(
        [ingredient({ name: '  Chicken   BREAST  ' })],
        [pantryView({ name: 'chicken breast', confidence: 1 })],
      );
      expect(result.details[0].status).toBe('matched');
    });

    it('reports missing when no pantry item matches', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'olive oil', confidence: 1 })],
      );
      expect(result.details[0].status).toBe('missing');
      expect(result.match.missingCount).toBe(1);
      expect(result.match.allIngredientsFound).toBe(false);
    });

    it('reports expired status for expired pantry items', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', expired: true, confidence: 1 })],
      );
      expect(result.details[0].status).toBe('expired');
      expect(result.match.expiredCount).toBe(1);
      expect(result.match.allIngredientsFound).toBe(false);
      expect(result.match.matchedCount).toBe(0);
    });

    it('reports stale status for old pantry items', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', stale: true, confidence: 1 })],
      );
      expect(result.details[0].status).toBe('stale');
      expect(result.match.staleCount).toBe(1);
      // Stale is still technically matched (not missing/expired).
      expect(result.match.allIngredientsFound).toBe(true);
    });

    it('reports uncertain status for low-confidence pantry items', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', confidence: 0.5 })],
      );
      expect(result.details[0].status).toBe('uncertain');
      expect(result.match.uncertainCount).toBe(1);
      expect(result.match.allIngredientsFound).toBe(true);
    });

    it('counts expiring-soon matched items', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', confidence: 1, expiresSoon: true })],
      );
      expect(result.match.expiringSoonCount).toBe(1);
    });

    it('does not count expired items as expiring-soon', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', expired: true, expiresSoon: true, confidence: 1 })],
      );
      expect(result.match.expiringSoonCount).toBe(0);
      expect(result.match.expiredCount).toBe(1);
    });

    // ── expiringSoonIngredients ──────────────────────────────────────────

    it('surfaces expiring-soon matched ingredient names', () => {
      const result = matchFor(
        [ingredient({ name: 'spinach' }), ingredient({ name: 'chicken breast' })],
        [
          pantryView({ id: 'p1', name: 'spinach', expiresSoon: true, confidence: 1, stale: false, expired: false }),
          pantryView({ id: 'p2', name: 'chicken breast', expiresSoon: false, confidence: 1, stale: false, expired: false }),
        ],
      );
      expect(result.match.expiringSoonIngredients).toEqual(['spinach']);
      expect(result.match.expiringSoonCount).toBe(1);
    });

    it('does not surface expired items in expiringSoonIngredients', () => {
      const result = matchFor(
        [ingredient({ name: 'milk' })],
        [pantryView({ id: 'p1', name: 'milk', expired: true, expiresSoon: true, confidence: 1 })],
      );
      expect(result.match.expiringSoonIngredients).toEqual([]);
      expect(result.match.expiringSoonCount).toBe(0);
    });

    it('does not surface stale items in expiringSoonIngredients even if near expiration', () => {
      const result = matchFor(
        [ingredient({ name: 'cheese' })],
        [pantryView({ id: 'p1', name: 'cheese', stale: true, expiresSoon: true, confidence: 1 })],
      );
      expect(result.match.expiringSoonIngredients).toEqual([]);
    });

    it('does not surface uncertain items in expiringSoonIngredients even if near expiration', () => {
      const result = matchFor(
        [ingredient({ name: 'butter' })],
        [pantryView({ id: 'p1', name: 'butter', stale: false, expired: false, confidence: 0.5, expiresSoon: true })],
      );
      // confidence < 0.8 means status is 'uncertain', not 'matched'
      expect(result.match.expiringSoonIngredients).toEqual([]);
    });

    it('does not surface missing items in expiringSoonIngredients', () => {
      const result = matchFor(
        [ingredient({ name: 'bread' })],
        [],
      );
      expect(result.match.expiringSoonIngredients).toEqual([]);
    });

    it('count matches array length for multiple expiring-soon ingredients', () => {
      const result = matchFor(
        [ingredient({ name: 'spinach' }), ingredient({ name: 'milk' }), ingredient({ name: 'rice' })],
        [
          pantryView({ id: 'p1', name: 'spinach', expiresSoon: true, confidence: 1, stale: false, expired: false }),
          pantryView({ id: 'p2', name: 'milk', expiresSoon: true, confidence: 1, stale: false, expired: false }),
          pantryView({ id: 'p3', name: 'rice', expiresSoon: false, confidence: 1, stale: false, expired: false }),
        ],
      );
      expect(result.match.expiringSoonIngredients).toEqual(['spinach', 'milk']);
      expect(result.match.expiringSoonCount).toBe(2);
    });

    // ── (end expiringSoonIngredients) ────────────────────────────────────

    it('picks the freshest item when duplicates exist', () => {
      const old = pantryView({ id: 'old', name: 'chicken breast', lastConfirmedAt: 1000, stale: true, confidence: 1 });
      const fresh = pantryView({ id: 'fresh', name: 'chicken breast', lastConfirmedAt: Date.now(), stale: false, confidence: 1 });
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [old, fresh],
      );
      expect(result.details[0].status).toBe('matched');
      expect(result.details[0].pantryItemId).toBe('fresh');
    });

    it('falls back to stale if all items are stale', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ id: 's1', name: 'chicken breast', stale: true, confidence: 1, lastConfirmedAt: 2000 }),
         pantryView({ id: 's2', name: 'chicken breast', stale: true, confidence: 1, lastConfirmedAt: 1000 })],
      );
      expect(result.details[0].status).toBe('stale');
      expect(result.details[0].pantryItemId).toBe('s1');
    });

    it('handles multiple ingredients correctly', () => {
      const result = matchFor(
        [ingredient({ id: '1', name: 'chicken breast' }),
         ingredient({ id: '2', name: 'olive oil' }),
         ingredient({ id: '3', name: 'garlic' })],
        [pantryView({ id: 'p1', name: 'chicken breast', confidence: 1 }),
         pantryView({ id: 'p2', name: 'garlic', confidence: 1, expired: true })],
      );
      expect(result.match.matchedCount).toBe(1);   // chicken
      expect(result.match.missingCount).toBe(1);    // olive oil
      expect(result.match.expiredCount).toBe(1);    // garlic
      expect(result.match.matchPercent).toBe(33);   // 1/3
      expect(result.match.allIngredientsFound).toBe(false); // missing + expired
    });

    it('handles empty ingredients gracefully', () => {
      const result = matchFor(
        [],
        [pantryView({ name: 'chicken breast' })],
      );
      expect(result.match.ingredientCount).toBe(1); // div-by-zero guard uses 1
      expect(result.match.matchPercent).toBe(0);
      expect(result.match.allIngredientsFound).toBe(true); // nothing missing
    });

    it('handles empty pantry gracefully', () => {
      const result = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [],
      );
      expect(result.match.matchedCount).toBe(0);
      expect(result.match.missingCount).toBe(1);
      expect(result.match.allIngredientsFound).toBe(false);
    });

    it('respects custom confidence threshold', () => {
      // Default threshold is 0.8, so 0.7 is uncertain.
      const resultDefault = matchFor(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', confidence: 0.7 })],
      );
      expect(resultDefault.details[0].status).toBe('uncertain');

      // With threshold 0.6, 0.7 is matched.
      const resultCustom = matchRecipeToPantry(
        [ingredient({ name: 'chicken breast' })],
        [pantryView({ name: 'chicken breast', confidence: 0.7 })],
        { confidenceThreshold: 0.6 },
      );
      expect(resultCustom.details[0].status).toBe('matched');
    });
  });

  describe('rankRecipeMatches — lexicographic precedence', () => {
    it('ranks all-ingredients-found first, regardless of match percentage', () => {
      const m = (t: string, aif: boolean, missing: number, matchPct: number, matched: number, expiring: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: matched + missing,
        matchPercent: matchPct, matchedCount: matched, missingCount: missing,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring, expiringSoonIngredients: [],
        allIngredientsFound: aif,
      });
      const ranked = rankRecipeMatches([
        m('Low Match', false, 1, 99, 8, 5),
        m('All Found', true, 0, 20, 2, 0),
      ]);
      expect(ranked[0].title).toBe('All Found');
    });

    it('fewer missing outranks more missing, even with expiring-soon bonus', () => {
      const m = (t: string, missing: number, expiring: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: missing + 3,
        matchPercent: Math.round(3 / (missing + 3) * 100), matchedCount: 3, missingCount: missing,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring, expiringSoonIngredients: [],
        allIngredientsFound: false,
      });
      const ranked = rankRecipeMatches([
        m('More Missing Expiring', 2, 5),
        m('Fewer Missing', 1, 0),
      ]);
      expect(ranked[0].title).toBe('Fewer Missing');
    });

    it('expiring-soon breaks ties after missing count is equal', () => {
      const m = (t: string, expiring: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: 5,
        matchPercent: 60, matchedCount: 3, missingCount: 2,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring, expiringSoonIngredients: [],
        allIngredientsFound: false,
      });
      const ranked = rankRecipeMatches([
        m('No Expiring', 0),
        m('Has Expiring', 3),
      ]);
      expect(ranked[0].title).toBe('Has Expiring');
    });

    it('match percentage breaks ties after missing and expiring', () => {
      const m = (t: string, pct: number, matched: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: 5,
        matchPercent: pct, matchedCount: matched, missingCount: 2,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [],
        allIngredientsFound: false,
      });
      const ranked = rankRecipeMatches([
        m('Low Pct', 40, 2),
        m('High Pct', 80, 4),
      ]);
      expect(ranked[0].title).toBe('High Pct');
    });

    it('matched count breaks ties at the last tier', () => {
      const m = (t: string, matched: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: 5,
        matchPercent: 60, matchedCount: matched, missingCount: 2,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [],
        allIngredientsFound: false,
      });
      const ranked = rankRecipeMatches([
        m('Few Matched', 2),
        m('More Matched', 3),
      ]);
      expect(ranked[0].title).toBe('More Matched');
    });

    it('deterministic: same result every run', () => {
      const m = (t: string, missing: number, expiring: number): RecipePantryMatch => ({
        recipeId: t, title: t, servings: 2, totalMinutes: 30, ingredientCount: 2,
        matchPercent: 50, matchedCount: 1, missingCount: missing,
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring, expiringSoonIngredients: [],
        allIngredientsFound: false,
      });
      const items = [m('B', 1, 0), m('A', 1, 0), m('C', 2, 0)];
      const first = rankRecipeMatches(items).map((r) => r.title);
      for (let i = 0; i < 5; i++) {
        expect(rankRecipeMatches(items).map((r) => r.title)).toEqual(first);
      }
    });
  });

  describe('rankRecipeMatches — final tie-breakers', () => {
    it('breaks ties deterministically by title', () => {
      const a: RecipePantryMatch = { recipeId: 'r1', title: 'Apple Pie', servings: 4, totalMinutes: 60, ingredientCount: 5, matchPercent: 50, matchedCount: 3, missingCount: 2, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [], allIngredientsFound: false };
      const b: RecipePantryMatch = { recipeId: 'r2', title: 'Banana Bread', servings: 4, totalMinutes: 60, ingredientCount: 5, matchPercent: 50, matchedCount: 3, missingCount: 2, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [], allIngredientsFound: false };
      const ranked = rankRecipeMatches([b, a]);
      expect(ranked[0].title).toBe('Apple Pie');
      expect(ranked[1].title).toBe('Banana Bread');
    });

    it('breaks same-title ties by recipe ID', () => {
      const a: RecipePantryMatch = { recipeId: 'z-recipe', title: 'Pasta', servings: 2, totalMinutes: 20, ingredientCount: 3, matchPercent: 66, matchedCount: 2, missingCount: 1, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [], allIngredientsFound: false };
      const b: RecipePantryMatch = { recipeId: 'a-recipe', title: 'Pasta', servings: 2, totalMinutes: 20, ingredientCount: 3, matchPercent: 66, matchedCount: 2, missingCount: 1, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, expiringSoonIngredients: [], allIngredientsFound: false };
      const ranked = rankRecipeMatches([b, a]);
      expect(ranked[0].recipeId).toBe('a-recipe');
      expect(ranked[1].recipeId).toBe('z-recipe');
    });
  });
});

// ── Candidate C: rankExpiringSoonMatches ──────────────────────────────────

describe('rankExpiringSoonMatches — Use These Soon', () => {
  const m = (overrides: Partial<RecipePantryMatch> & { recipeId: string; title: string }): RecipePantryMatch => ({
    recipeId: overrides.recipeId,
    title: overrides.title,
    servings: 2,
    totalMinutes: 30,
    ingredientCount: overrides.ingredientCount ?? 5,
    matchPercent: overrides.matchPercent ?? 60,
    matchedCount: overrides.matchedCount ?? 3,
    missingCount: overrides.missingCount ?? 2,
    expiredCount: 0,
    staleCount: 0,
    uncertainCount: 0,
    expiringSoonCount: overrides.expiringSoonCount ?? 0,
    expiringSoonIngredients: overrides.expiringSoonIngredients ?? [],
    allIngredientsFound: overrides.allIngredientsFound ?? false,
  });

  it('filters out recipes with zero expiring-soon ingredients', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'No Expiring', expiringSoonCount: 0 }),
    ]);
    expect(ranked).toEqual([]);
  });

  it('ranks more expiring-soon ingredients higher (tier 1)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'One Expiring', expiringSoonCount: 1 }),
      m({ recipeId: 'r2', title: 'Three Expiring', expiringSoonCount: 3 }),
      m({ recipeId: 'r3', title: 'Two Expiring', expiringSoonCount: 2 }),
    ]);
    expect(ranked.map((r) => r.title)).toEqual(['Three Expiring', 'Two Expiring', 'One Expiring']);
  });

  it('ranks allIngredientsFound above non-complete when expiring count is equal (tier 2)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'Missing Items', expiringSoonCount: 2, allIngredientsFound: false }),
      m({ recipeId: 'r2', title: 'All Found', expiringSoonCount: 2, allIngredientsFound: true }),
    ]);
    expect(ranked[0].title).toBe('All Found');
  });

  it('ranks fewer missing above more missing when expiring + allFound are tied (tier 3)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'More Missing', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 3 }),
      m({ recipeId: 'r2', title: 'Fewer Missing', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 1 }),
    ]);
    expect(ranked[0].title).toBe('Fewer Missing');
  });

  it('ranks higher match percent when expiring + allFound + missing are tied (tier 4)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'Low Match', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 40 }),
      m({ recipeId: 'r2', title: 'High Match', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 80 }),
    ]);
    expect(ranked[0].title).toBe('High Match');
  });

  it('ranks higher matched count when all above are tied (tier 5)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r1', title: 'Fewer Matched', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 2 }),
      m({ recipeId: 'r2', title: 'More Matched', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 4 }),
    ]);
    expect(ranked[0].title).toBe('More Matched');
  });

  it('breaks ties with title (tier 6)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'r2', title: 'Zebra Cake', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 3 }),
      m({ recipeId: 'r1', title: 'Apple Pie', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 3 }),
    ]);
    expect(ranked[0].title).toBe('Apple Pie');
  });

  it('breaks same-title ties with recipe ID (tier 7)', () => {
    const ranked = rankExpiringSoonMatches([
      m({ recipeId: 'z', title: 'Pasta', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 3 }),
      m({ recipeId: 'a', title: 'Pasta', expiringSoonCount: 1, allIngredientsFound: false, missingCount: 2, matchPercent: 50, matchedCount: 3 }),
    ]);
    expect(ranked[0].recipeId).toBe('a');
    expect(ranked[1].recipeId).toBe('z');
  });
});

// ── aggregateGroceryNeeds ────────────────────────────────────────────────

describe('aggregateGroceryNeeds', () => {
  function detail(name: string, status: 'missing' | 'expired' | 'matched' | 'stale' | 'uncertain', pantryItemId?: string) {
    return { name, status, pantryItemId };
  }

  it('aggregates same missing ingredient across two recipes', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('onion', 'missing')] },
      { recipeId: 'r2', details: [detail('onion', 'missing')] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('onion');
    expect(result[0].recipeCount).toBe(2);
    expect(result[0].recipeIds).toEqual(['r1', 'r2']);
    expect(result[0].needsReplacement).toBe(false);
  });

  it('includes expired ingredient', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('milk', 'expired')] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('milk');
    expect(result[0].needsReplacement).toBe(true);
  });

  it('excludes stale ingredients', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('cheese', 'stale')] },
    ]);
    expect(result).toHaveLength(0);
  });

  it('excludes uncertain ingredients', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('butter', 'uncertain')] },
    ]);
    expect(result).toHaveLength(0);
  });

  it('excludes matched ingredients', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('chicken', 'matched')] },
    ]);
    expect(result).toHaveLength(0);
  });

  it('duplicate ingredient rows in one recipe do not inflate recipeCount', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('onion', 'missing'), detail('onion', 'missing')] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].recipeCount).toBe(1);
    expect(result[0].recipeIds).toEqual(['r1']);
  });

  it('recipeIds are unique', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('onion', 'missing'), detail('onion', 'expired')] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].recipeIds).toEqual(['r1']);
    expect(result[0].recipeCount).toBe(1);
  });

  it('needsReplacement true when any source is expired', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('milk', 'missing')] },
      { recipeId: 'r2', details: [detail('milk', 'expired')] },
    ]);
    expect(result[0].needsReplacement).toBe(true);
  });

  it('needsReplacement false when all contributions are missing', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('milk', 'missing')] },
      { recipeId: 'r2', details: [detail('milk', 'missing')] },
    ]);
    expect(result[0].needsReplacement).toBe(false);
  });

  it('sorts by higher recipeCount first', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('onion', 'missing')] },
      { recipeId: 'r2', details: [detail('milk', 'missing'), detail('milk', 'missing')] },
      { recipeId: 'r3', details: [detail('milk', 'missing')] },
    ]);
    const names = result.map((r) => r.name);
    expect(names[0]).toBe('milk');
    expect(result[0].recipeCount).toBe(2);
  });

  it('alphabetical tie-break', () => {
    const result = aggregateGroceryNeeds([
      { recipeId: 'r1', details: [detail('zucchini', 'missing')] },
      { recipeId: 'r1', details: [detail('apple', 'missing')] },
    ]);
    expect(result[0].name).toBe('apple');
    expect(result[1].name).toBe('zucchini');
  });

  it('empty input returns empty array', () => {
    const result = aggregateGroceryNeeds([]);
    expect(result).toEqual([]);
  });
});
