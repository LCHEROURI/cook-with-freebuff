import { describe, it, expect } from 'vitest';
import { extractIngredients, parseIngredientSegment } from './extract';

describe('parseIngredientSegment', () => {
  it('parses a plain ingredient with unknown quantity', () => {
    expect(parseIngredientSegment('chicken thighs')).toEqual({
      name: 'chicken thighs',
      quantity: null,
      unit: null,
    });
  });

  it('parses a number + unit + of', () => {
    expect(parseIngredientSegment('two cups of flour')).toEqual({
      name: 'flour',
      quantity: 2,
      unit: 'cups',
    });
  });

  it('parses "half an onion"', () => {
    expect(parseIngredientSegment('half an onion')).toEqual({
      name: 'onion',
      quantity: 0.5,
      unit: null,
    });
  });

  it('parses "two and a half cups of flour"', () => {
    expect(parseIngredientSegment('two and a half cups of flour')).toEqual({
      name: 'flour',
      quantity: 2.5,
      unit: 'cups',
    });
  });

  it('parses "a can of tomatoes" with unknown quantity', () => {
    expect(parseIngredientSegment('a can of tomatoes')).toEqual({
      name: 'tomatoes',
      quantity: null,
      unit: 'can',
    });
  });

  it('keeps "some" as unknown quantity', () => {
    expect(parseIngredientSegment('some rice')).toEqual({ name: 'rice', quantity: null, unit: null });
  });

  it('parses a fraction', () => {
    expect(parseIngredientSegment('1/2 onion')).toEqual({ name: 'onion', quantity: 0.5, unit: null });
  });

  it('returns null for junk', () => {
    expect(parseIngredientSegment('!!!')).toBeNull();
  });
});

describe('extractIngredients — spec example', () => {
  it('extracts the K5 brain-dump example exactly', () => {
    const items = extractIngredients(
      'I have some chicken thighs, three tomatoes, half an onion, garlic, cilantro and some rice.',
    );
    const names = items.map((i) => i.name);
    expect(names).toEqual(['chicken thighs', 'tomatoes', 'onion', 'garlic', 'cilantro', 'rice']);

    const tomato = items.find((i) => i.name === 'tomatoes')!;
    expect(tomato.quantity).toBe(3);
    expect(tomato.unit).toBeNull();

    const onion = items.find((i) => i.name === 'onion')!;
    expect(onion.quantity).toBe(0.5);

    const chicken = items.find((i) => i.name === 'chicken thighs')!;
    expect(chicken.quantity).toBeNull(); // unknown — never invented

    const rice = items.find((i) => i.name === 'rice')!;
    expect(rice.quantity).toBeNull();
  });
});

describe('extractIngredients — quantity and unit handling', () => {
  it('handles "two cups of flour and three eggs"', () => {
    const items = extractIngredients('two cups of flour and three eggs');
    const flour = items.find((i) => i.name === 'flour')!;
    expect(flour.quantity).toBe(2);
    expect(flour.unit).toBe('cups');
    const eggs = items.find((i) => i.name === 'eggs')!;
    expect(eggs.quantity).toBe(3);
  });

  it('handles "I have salt, pepper and olive oil"', () => {
    const items = extractIngredients('I have salt, pepper and olive oil');
    expect(items.map((i) => i.name)).toEqual(['salt', 'pepper', 'olive oil']);
    expect(items.every((i) => i.quantity === null)).toBe(true);
  });

  it('dedupes repeated items', () => {
    const items = extractIngredients('two tomatoes, three tomatoes');
    expect(items.filter((i) => i.name === 'tomatoes')).toHaveLength(1);
  });

  it('produces valid ingredient objects for the tool schema', () => {
    const items = extractIngredients('I have some chicken thighs and rice');
    for (const ing of items) {
      expect(typeof ing.name).toBe('string');
      expect(typeof ing.optional).toBe('boolean');
      expect('id' in ing).toBe(true);
    }
  });
});

describe('extractIngredients — conversational gate', () => {
  it('does not treat free-form turns as brain-dumps', () => {
    expect(extractIngredients('go ahead and start cooking')).toEqual([]);
    expect(extractIngredients('hello')).toEqual([]);
    expect(extractIngredients('tell me about the weather')).toEqual([]);
  });

  it('still extracts when the utterance has a possession lead-in', () => {
    expect(extractIngredients('I have salt, pepper and olive oil')).toHaveLength(3);
    expect(extractIngredients("I've got three tomatoes")).toHaveLength(1);
  });

  it('still extracts quantity-first brain-dumps without a lead-in', () => {
    expect(extractIngredients('two cups of flour and three eggs')).toHaveLength(2);
  });

  it('never treats a question as a brain-dump — even with a number-word inside', () => {
    // The user's exact report: "what is one good tip for seasoning chicken"
    // used to trip the quantity gate ('one') and swallow the WHOLE sentence
    // as a single fake ingredient. Questions must fall through to the
    // free-form provider instead.
    expect(extractIngredients('what is one good tip for seasoning chicken')).toEqual([]);
    expect(extractIngredients('how do I make two servings of rice')).toEqual([]);
    expect(extractIngredients('whats in my pantry')).toEqual([]);
  });

  it('treats an explicit question mark as a question', () => {
    expect(extractIngredients('can you make a salad with two tomatoes?')).toEqual([]);
    expect(extractIngredients('Do I need a pan for this?')).toEqual([]);
  });
});