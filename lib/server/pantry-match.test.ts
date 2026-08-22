import { describe, expect, it } from 'vitest';
import {
  matchRecipeToPantry,
  rankRecipeMatches,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0,
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
        expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: expiring,
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
      const a: RecipePantryMatch = { recipeId: 'r1', title: 'Apple Pie', servings: 4, totalMinutes: 60, ingredientCount: 5, matchPercent: 50, matchedCount: 3, missingCount: 2, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, allIngredientsFound: false };
      const b: RecipePantryMatch = { recipeId: 'r2', title: 'Banana Bread', servings: 4, totalMinutes: 60, ingredientCount: 5, matchPercent: 50, matchedCount: 3, missingCount: 2, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, allIngredientsFound: false };
      const ranked = rankRecipeMatches([b, a]);
      expect(ranked[0].title).toBe('Apple Pie');
      expect(ranked[1].title).toBe('Banana Bread');
    });

    it('breaks same-title ties by recipe ID', () => {
      const a: RecipePantryMatch = { recipeId: 'z-recipe', title: 'Pasta', servings: 2, totalMinutes: 20, ingredientCount: 3, matchPercent: 66, matchedCount: 2, missingCount: 1, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, allIngredientsFound: false };
      const b: RecipePantryMatch = { recipeId: 'a-recipe', title: 'Pasta', servings: 2, totalMinutes: 20, ingredientCount: 3, matchPercent: 66, matchedCount: 2, missingCount: 1, expiredCount: 0, staleCount: 0, uncertainCount: 0, expiringSoonCount: 0, allIngredientsFound: false };
      const ranked = rankRecipeMatches([b, a]);
      expect(ranked[0].recipeId).toBe('a-recipe');
      expect(ranked[1].recipeId).toBe('z-recipe');
    });
  });
});