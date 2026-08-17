import { describe, expect, it } from 'vitest';
import { parseServings } from './servings-parser';

describe('parseServings', () => {
  it('parses digits and number words', () => {
    expect(parseServings('8')).toBe(8);
    expect(parseServings('make it 6 servings please')).toBe(6);
    expect(parseServings('eight')).toBe(8);
    expect(parseServings('twenty-four')).toBe(24);
    expect(parseServings('twenty three')).toBe(23);
  });

  it('prefers an explicit digit', () => {
    expect(parseServings('four to 8 servings')).toBe(8);
  });

  it('clamps to the stepper range', () => {
    expect(parseServings('0')).toBe(1);
    expect(parseServings('99')).toBe(24);
  });

  it('does not treat number-word substrings as numbers', () => {
    expect(parseServings('none')).toBeNull();
    expect(parseServings('someone')).toBeNull();
    expect(parseServings('stone')).toBeNull();
  });

  it('returns null when no number exists', () => {
    expect(parseServings('a bit more')).toBeNull();
    expect(parseServings('')).toBeNull();
  });
});
