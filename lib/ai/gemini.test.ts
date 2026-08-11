import { describe, expect, it } from 'vitest';
import { pruneNulls } from './gemini';

describe('pruneNulls — model JSON normalization', () => {
  it('drops null-valued optional fields so zod .optional() accepts them', () => {
    const input = {
      title: 'Chicken Rice',
      description: null,
      ingredients: [
        { name: 'chicken thighs', quantity: 4, unit: null, preparation: null },
      ],
      cookingSteps: [{ instruction: 'Cook', safetyNote: null, temperature: null }],
      safetyNotes: null,
    };
    const out = pruneNulls(input) as Record<string, unknown>;
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('safetyNotes');
    expect((out.cookingSteps as Record<string, unknown>[])[0]).not.toHaveProperty('safetyNote');
    expect((out.cookingSteps as Record<string, unknown>[])[0]).not.toHaveProperty('temperature');
    // Legitimately-nullable fields are preserved — the schema allows null there.
    const ing = (out.ingredients as Record<string, unknown>[])[0];
    expect(ing.quantity).toBe(4);
    expect(ing.unit).toBeNull();
    expect(ing).not.toHaveProperty('preparation');
  });

  it('leaves non-null values untouched', () => {
    const out = pruneNulls({ title: 'X', ingredients: [{ name: 'rice', quantity: null, unit: 'cups' }] }) as Record<string, unknown>;
    expect(out.title).toBe('X');
    expect((out.ingredients as Record<string, unknown>[])[0].unit).toBe('cups');
  });
});
