import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  makeFieldUIAnnotations,
  pantryFieldUI,
  leftoverFieldUI,
  profileFieldUI,
} from './fieldUI';

// ── Test schema ──────────────────────────────────────────────────────────────

const testSchema = z.object({
  name: z.string(),
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
  count: z.number().int().positive(),
});

// ── makeFieldUIAnnotations ───────────────────────────────────────────────────

describe('makeFieldUIAnnotations', () => {
  const ui = makeFieldUIAnnotations(testSchema, ['tags'], ['notes']);

  describe('resolve', () => {
    it('returns a comma separator for commaListFields', () => {
      expect(ui.resolve('tags')).toBe(', ');
    });

    it('returns a newline separator for paragraphFields', () => {
      expect(ui.resolve('notes')).toBe('\n');
    });

    it('returns undefined for un-annotated fields', () => {
      expect(ui.resolve('name')).toBeUndefined();
      expect(ui.resolve('count')).toBeUndefined();
    });

    it('returns undefined for fields not on the schema at all', () => {
      expect(ui.resolve('nonexistent')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('builds correctly when both arrays are empty', () => {
      const empty = makeFieldUIAnnotations(testSchema, [], []);
      expect(empty.resolve('notes')).toBeUndefined();
      expect(empty.resolve('tags')).toBeUndefined();
    });

    it('last write wins when a field appears in both commaList and paragraph', () => {
      const overlap = makeFieldUIAnnotations(testSchema, ['tags'], ['tags']);
      expect(overlap.resolve('tags')).toBe('\n');
    });
  });
});

// ── Per-schema annotation calls ──────────────────────────────────────────────

describe('pantryFieldUI', () => {
  it('annotates notes with paragraph separator', () => {
    expect(pantryFieldUI.resolve('notes')).toBe('\n');
  });

  it('does not annotate name, quantity, or unit', () => {
    expect(pantryFieldUI.resolve('name')).toBeUndefined();
    expect(pantryFieldUI.resolve('quantity')).toBeUndefined();
    expect(pantryFieldUI.resolve('unit')).toBeUndefined();
  });
});

describe('leftoverFieldUI', () => {
  it('annotates notes with paragraph separator', () => {
    expect(leftoverFieldUI.resolve('notes')).toBe('\n');
  });

  it('does not annotate title or servings', () => {
    expect(leftoverFieldUI.resolve('title')).toBeUndefined();
    expect(leftoverFieldUI.resolve('servings')).toBeUndefined();
  });
});

describe('profileFieldUI', () => {
  it('annotates four list fields with comma separator', () => {
    for (const field of ['allergies', 'dietaryRestrictions', 'dislikedIngredients', 'preferredCuisines']) {
      expect(profileFieldUI.resolve(field)).toBe(', ');
    }
  });

  it('does not annotate defaultServings or updatedAt', () => {
    expect(profileFieldUI.resolve('defaultServings')).toBeUndefined();
    expect(profileFieldUI.resolve('updatedAt')).toBeUndefined();
  });
});
