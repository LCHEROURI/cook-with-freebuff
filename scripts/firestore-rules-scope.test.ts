import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertNonCookRulesUnchanged,
  splitUnionRules,
} from './firestore-rules-scope';

const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

describe('shared Firestore union-rules scope lock', () => {
  it('pins the real non-Cook prefix and catch-all suffix byte-for-byte', () => {
    expect(() => assertNonCookRulesUnchanged(rules)).not.toThrow();
  });

  it('rejects changes before the Cook section', () => {
    const sections = splitUnionRules(rules);
    expect(() => assertNonCookRulesUnchanged(
      `${sections.prefix.replace('function isAuthed()', 'function changedIsAuthed()')}${sections.cook}${sections.suffix}`,
    )).toThrow(/non-Cook prefix/i);
  });

  it('rejects changes to the catch-all suffix', () => {
    const sections = splitUnionRules(rules);
    expect(() => assertNonCookRulesUnchanged(
      `${sections.prefix}${sections.cook}${sections.suffix.replace('allow read, write: if false', 'allow read, write: if true')}`,
    )).toThrow(/catch-all suffix/i);
  });

  it('permits edits confined to the Cook section', () => {
    const sections = splitUnionRules(rules);
    expect(() => assertNonCookRulesUnchanged(
      `${sections.prefix}${sections.cook.replace('Kitchen Agent collections', 'Kitchen Agent collections (scoped edit)')}${sections.suffix}`,
    )).not.toThrow();
  });

  it('fails closed when either section marker is missing or duplicated', () => {
    const sections = splitUnionRules(rules);
    expect(() => splitUnionRules(`${sections.prefix}${sections.cook}`)).toThrow(/catch-all marker/i);
    expect(() => splitUnionRules(`${sections.prefix}${sections.cook}${sections.cook}${sections.suffix}`)).toThrow(/Cook section marker/i);
  });
});
