import { describe, it, expect } from 'vitest';
import { classifyProteins } from './classify';
import type { Ingredient } from '../domain/types';

function ing(name: string): Ingredient {
  return { id: `ing-${name}`, name, quantity: null, unit: null, optional: false };
}

describe('classifyProteins', () => {
  it('classifies chicken', () => {
    expect(classifyProteins([ing('chicken thighs'), ing('rice')])).toEqual(['chicken']);
  });

  it('classifies beef', () => {
    expect(classifyProteins([ing('ground beef'), ing('onion')])).toEqual(['beef']);
  });

  it('classifies lamb', () => {
    expect(classifyProteins([ing('lamb chops'), ing('mint')])).toEqual(['lamb']);
  });

  it('classifies pork', () => {
    expect(classifyProteins([ing('pork shoulder'), ing('bacon')])).toEqual(['pork']);
  });

  it('classifies seafood', () => {
    expect(classifyProteins([ing('salmon fillet'), ing('shrimp'), ing('lemon')]))
      .toEqual(['seafood']);
  });

  it('classifies poultry', () => {
    expect(classifyProteins([ing('turkey breast'), ing('duck')])).toEqual(['poultry']);
  });

  it('classifies tofu', () => {
    expect(classifyProteins([ing('tofu'), ing('soy sauce')])).toEqual(['tofu', 'vegetarian', 'vegan']);
  });

  it('classifies eggs', () => {
    expect(classifyProteins([ing('eggs'), ing('butter')])).toEqual(['eggs', 'vegetarian']);
  });

  it('classifies multiple proteins', () => {
    expect(classifyProteins([ing('chicken'), ing('shrimp'), ing('rice')]))
      .toEqual(['chicken', 'seafood']);
  });

  it('marks vegetarian when no meat', () => {
    expect(classifyProteins([ing('tomato'), ing('basil'), ing('pasta')]))
      .toEqual(['vegetarian', 'vegan']);
  });

  it('marks vegetarian but not vegan with dairy', () => {
    expect(classifyProteins([ing('tomato'), ing('cheese'), ing('butter')]))
      .toEqual(['vegetarian']);
  });

  it('marks vegetarian but not vegan with eggs', () => {
    expect(classifyProteins([ing('eggs'), ing('flour'), ing('milk')]))
      .toEqual(['eggs', 'vegetarian']);
  });

  it('marks vegetarian but not vegan with honey', () => {
    expect(classifyProteins([ing('honey'), ing('almonds'), ing('oats')]))
      .toEqual(['vegetarian']);
  });

  it('handles empty ingredients', () => {
    expect(classifyProteins([])).toEqual(['vegetarian', 'vegan']);
  });

  it('handles case-insensitive names', () => {
    expect(classifyProteins([ing('CHICKEN breast'), ing('SALMON')]))
      .toEqual(['chicken', 'seafood']);
  });

  it('handles multi-word first-word matches', () => {
    expect(classifyProteins([ing('sour cream'), ing('goat cheese'), ing('pasta')]))
      .toEqual(['vegetarian']); // dairy present → not vegan
  });

  it('deduplicates repeated proteins', () => {
    expect(classifyProteins([ing('chicken thighs'), ing('chicken breast'), ing('rice')]))
      .toEqual(['chicken']);
  });

  it('sorts categories deterministically', () => {
    const result = classifyProteins([ing('salmon'), ing('chicken'), ing('rice')]);
    expect(result).toEqual(['chicken', 'seafood']);
  });

  it('places vegetarian/vegan last', () => {
    const result = classifyProteins([ing('tofu'), ing('rice')]);
    expect(result).toEqual(['tofu', 'vegetarian', 'vegan']);
  });

  it('no meat but dairy — not vegan', () => {
    expect(classifyProteins([ing('pasta'), ing('parmesan'), ing('cream')]))
      .toEqual(['vegetarian']);
  });
});
