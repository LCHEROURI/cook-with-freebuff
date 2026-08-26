import { describe, expect, it } from 'vitest';
import { formatIngredientQuantity, formatIngredientQuantityPrefix, formatIngredientNameSuffix } from './format';
import type { Ingredient } from '../domain/types';

function ing(overrides: Partial<Ingredient> = {}): Ingredient {
  return { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false, ...overrides };
}

describe('formatIngredientQuantity', () => {
  it('keeps whole numbers whole', () => {
    expect(formatIngredientQuantity(4)).toBe('4');
    expect(formatIngredientQuantity(1)).toBe('1');
  });

  it('renders quarter steps as fraction glyphs (spec 0003 D3)', () => {
    expect(formatIngredientQuantity(0.25)).toBe('¼');
    expect(formatIngredientQuantity(0.5)).toBe('½');
    expect(formatIngredientQuantity(0.75)).toBe('¾');
    expect(formatIngredientQuantity(1.5)).toBe('1½');
  });

  it('renders zero with the fraction when there is no whole part', () => {
    expect(formatIngredientQuantity(0.75)).toBe('¾');
  });
});

describe('formatIngredientQuantityPrefix', () => {
  it('renders quantity + unit when both are known', () => {
    expect(formatIngredientQuantityPrefix(ing())).toBe('4 pieces');
    expect(formatIngredientQuantityPrefix(ing({ quantity: 1, unit: 'cup' }))).toBe('1 cup');
  });

  it('renders the bare quantity when the unit is unknown', () => {
    expect(formatIngredientQuantityPrefix(ing({ quantity: 2, unit: null }))).toBe('2');
  });

  it('renders an empty prefix when the quantity is unknown — never invented', () => {
    expect(formatIngredientQuantityPrefix(ing({ quantity: null, unit: null }))).toBe('');
  });
});

describe('formatIngredientNameSuffix', () => {
  it('renders the bare name', () => {
    expect(formatIngredientNameSuffix(ing())).toBe('chicken thighs');
  });

  it('appends the preparation', () => {
    expect(formatIngredientNameSuffix(ing({ preparation: 'diced' }))).toBe('chicken thighs, diced');
  });

  it('marks optional ingredients', () => {
    expect(formatIngredientNameSuffix(ing({ optional: true }))).toBe('chicken thighs (optional)');
  });

  it('combines preparation and the optional marker', () => {
    expect(formatIngredientNameSuffix(ing({ preparation: 'diced', optional: true }))).toBe('chicken thighs, diced (optional)');
  });
});
