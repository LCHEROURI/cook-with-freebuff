import { describe, it, expect } from 'vitest';
import { validateRecipe } from './validate';
import type { Recipe, Ingredient } from '../domain/types';

function makeIngredient(name: string, quantity: number | null = null, unit: string | null = null): Ingredient {
  return { id: `ing-${name}`, name, quantity, unit, optional: false };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [
      makeIngredient('chicken thighs', 4, 'pieces'),
      makeIngredient('rice', 1, 'cup'),
      makeIngredient('onion'),
    ],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken for 4 minutes', spokenInstruction: 'Sear the chicken for four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil — keep children away' },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil'],
    generatedAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe('validateRecipe — schema validity', () => {
  it('flags a missing title', () => {
    const r = makeRecipe({ title: '' });
    const result = validateRecipe(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('title'))).toBe(true);
  });

  it('flags invalid step numbers', () => {
    const r = makeRecipe({
      prepSteps: [{ id: 'p1', stepNumber: 5, instruction: 'Dice', spokenInstruction: 'Dice', estimatedSeconds: 60, ingredientsUsed: [], equipmentUsed: [] }],
    });
    const result = validateRecipe(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'prepSteps')).toBe(true);
  });
});

describe('validateRecipe — ingredient consistency', () => {
  it('flags a step referencing an unknown ingredient', () => {
    const r = makeRecipe({
      cookingSteps: [
        { id: 'c1', stepNumber: 1, instruction: 'Add the basil', spokenInstruction: 'Add the basil', estimatedSeconds: 30, ingredientsUsed: ['basil'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('basil'))).toBe(true);
  });

  it('accepts case-insensitive references', () => {
    const r = makeRecipe({
      prepSteps: [{ id: 'p1', stepNumber: 1, instruction: 'Dice the Onion', spokenInstruction: 'Dice the Onion', estimatedSeconds: 120, ingredientsUsed: ['ONION'], equipmentUsed: [] }],
    });
    const result = validateRecipe(r);
    expect(result.valid).toBe(true);
  });
});

describe('validateRecipe — quantity consistency', () => {
  it('warns when a used ingredient has unknown quantity', () => {
    const result = validateRecipe(makeRecipe());
    expect(result.warnings.some((w) => w.message.includes('unknown'))).toBe(true);
  });
});

describe('validateRecipe — resource validation', () => {
  it('returns a missing confirmation for an unavailable ingredient', () => {
    const result = validateRecipe(makeRecipe(), {
      availableIngredients: ['chicken thighs', 'rice'],
      availableEquipment: ['pan', 'knife'],
    });
    expect(result.missingConfirmations.some((m) => m.item === 'onion')).toBe(true);
    expect(result.missingConfirmations[0].context).toContain('Do you have');
  });

  it('returns a missing confirmation for unavailable equipment', () => {
    const result = validateRecipe(makeRecipe(), {
      availableIngredients: ['chicken thighs', 'rice', 'onion'],
      availableEquipment: ['pan'],
    });
    expect(result.missingConfirmations.some((m) => m.item === 'knife')).toBe(true);
  });

  it('skips missing confirmations for optional ingredients', () => {
    const r = makeRecipe({
      ingredients: [
        makeIngredient('chicken thighs', 4, 'pieces'),
        makeIngredient('rice', 1, 'cup'),
        { ...makeIngredient('parsley'), optional: true },
      ],
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: 'Dice the chicken', spokenInstruction: 'Dice the chicken', estimatedSeconds: 120, ingredientsUsed: ['chicken thighs'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r, { availableIngredients: ['chicken thighs', 'rice'] });
    expect(result.missingConfirmations.some((m) => m.item === 'parsley')).toBe(false);
  });
});

describe('validateRecipe — dietary constraints', () => {
  it('errors when the recipe contains a declared allergen', () => {
    const r = makeRecipe({ allergens: ['peanuts'] });
    const result = validateRecipe(r, { allergies: ['peanuts'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('peanuts'))).toBe(true);
  });

  it('does not error on unrelated allergens', () => {
    const r = makeRecipe({ allergens: ['gluten'] });
    const result = validateRecipe(r, { allergies: ['peanuts'] });
    expect(result.valid).toBe(true);
  });

  it('errors when a vegetarian recipe contains meat', () => {
    const result = validateRecipe(makeRecipe(), { dietaryRestrictions: ['vegetarian'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('chicken'))).toBe(true);
  });

  it('accepts a vegetarian recipe with no meat', () => {
    const r = makeRecipe({
      title: 'Rice and Onions',
      ingredients: [makeIngredient('rice', 1, 'cup'), makeIngredient('onion', 1, null)],
      cookingSteps: [
        { id: 'c1', stepNumber: 1, instruction: 'Simmer the rice', spokenInstruction: 'Simmer the rice', estimatedSeconds: 600, ingredientsUsed: ['rice'], equipmentUsed: ['pan'] },
      ],
    });
    const result = validateRecipe(r, { dietaryRestrictions: ['vegetarian'] });
    expect(result.valid).toBe(true);
  });
});

describe('validateRecipe — timing', () => {
  it('warns when totalMinutes is inconsistent', () => {
    const r = makeRecipe({ totalMinutes: 60 });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.field === 'totalMinutes')).toBe(true);
  });
});

describe('validateRecipe — safety', () => {
  it('warns when a high-heat step lacks a safety note', () => {
    const r = makeRecipe({
      cookingSteps: [
        { id: 'c1', stepNumber: 1, instruction: 'Deep fry the chicken', spokenInstruction: 'Deep fry the chicken', estimatedSeconds: 300, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: undefined },
      ],
    });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.message.includes('safety note'))).toBe(true);
  });

  it('warns about missing raw-meat safety notes', () => {
    const r = makeRecipe({ safetyNotes: [] });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.message.includes('meat'))).toBe(true);
  });

  it('is satisfied when safety notes exist', () => {
    const result = validateRecipe(makeRecipe());
    expect(result.warnings.some((w) => w.message.includes('meat'))).toBe(false);
  });
});

describe('validateRecipe — actionability', () => {
  it('rejects a step without a spoken instruction (schema-level)', () => {
    const r = makeRecipe({
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: '', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('spokenInstruction'))).toBe(true);
  });
});

describe('validateRecipe — one-action suitability', () => {
  it('warns on multi-action steps', () => {
    const r = makeRecipe({
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: 'Dice the onion and mince the garlic', spokenInstruction: 'Dice the onion and mince the garlic', estimatedSeconds: 180, ingredientsUsed: ['onion'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.message.includes('multiple actions'))).toBe(true);
  });

  it('does not warn on a single action with multiple items', () => {
    const r = makeRecipe({
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: 'Add salt and pepper', spokenInstruction: 'Add salt and pepper', estimatedSeconds: 30, ingredientsUsed: ['onion'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.message.includes('multiple actions'))).toBe(false);
  });

  it('warns on overly wordy steps', () => {
    const longInstruction = 'Carefully take the freshly washed onion and place it on the cutting board then chop it into small pieces while keeping your fingers away from the blade';
    const r = makeRecipe({
      prepSteps: [
        { id: 'p1', stepNumber: 1, instruction: longInstruction, spokenInstruction: 'Chop the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: [] },
      ],
    });
    const result = validateRecipe(r);
    expect(result.warnings.some((w) => w.message.includes('wordy'))).toBe(true);
  });
});

describe('validateRecipe — happy path', () => {
  it('passes a well-formed recipe', () => {
    const result = validateRecipe(makeRecipe(), {
      availableIngredients: ['chicken thighs', 'rice', 'onion'],
      availableEquipment: ['pan', 'knife'],
      allergies: [],
      dietaryRestrictions: [],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.missingConfirmations).toHaveLength(0);
  });
});