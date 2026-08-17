import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/drive-voice-everywhere.test.ts — lock the Voice Everywhere mic
// proofs in the raw-CDP drivers (spec 0004 §Contract).
//
// Same discipline as verify-live-cleanup.test.ts: read the REAL scripts from
// disk (never a fixture) and pin the load-bearing selectors. A future edit
// that removes a mic or renames its accessible label fails here before the
// deployed proof silently stops exercising the surface.
// ============================================================================

const RECIPES = readFileSync('scripts/drive-recipes-page.mjs', 'utf8');
const KITCHEN = readFileSync('scripts/drive-kitchen.mjs', 'utf8');
const VERIFY = readFileSync('scripts/verify-live.mjs', 'utf8');

describe('drive-voice-everywhere contract', () => {
  it('pins the recipes search mic proof', () => {
    expect(RECIPES).toContain('button[aria-label="Speak recipes search"]');
  });

  it('pins the kitchen pantry name mic proof', () => {
    expect(KITCHEN).toContain('button[aria-label="Speak pantry item name"]');
  });

  it('pins the kitchen dietary-profile mic proof', () => {
    expect(KITCHEN).toContain('button[aria-label="Speak Allergies, comma separated"]');
  });

  it('pins verify:live wiring the kitchen driver into the deployed proof', () => {
    expect(VERIFY).toContain("scripts/drive-kitchen.mjs");
  });
});
