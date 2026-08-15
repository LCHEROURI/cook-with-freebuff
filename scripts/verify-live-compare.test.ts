import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-compare.test.ts — lock the parity noise filter.
//
// verify:live:compare diffs the deployed and local transcripts line for line.
// Both stacks emit ✓ status lines, but the local leg also emits its own ✓
// warm-up notes (dev server boot, route/page warm-up) and inherits the dev
// server's compiler chatter. DRIVER_NOISE drops those so only verify-live
// status lines compare. The load-bearing property is that the local warm-up
// message is ALWAYS matched by DRIVER_NOISE: a rename (e.g. "API routes
// compiled" → "routes and /login page compiled") that slips out of the filter
// adds a local-only line and flips the comparison to FAIL even when both
// application runs agree. This test re-derives the filter from the source and
// proves it still matches whatever the warm-up message currently says.
// ============================================================================

const COMPARE = readFileSync('scripts/verify-live-compare.mjs', 'utf8');
const LOCAL = readFileSync('scripts/verify-live-local.mjs', 'utf8');

const NOISE_MATCH = COMPARE.match(/const DRIVER_NOISE = \/(.+)\/;/);
const WARM_MATCH = LOCAL.match(/ok\('([^']*compiled[^']*)'\)/);

describe('verify:live:compare · noise filter vs the local warm-up message', () => {
  it('defines a DRIVER_NOISE filter and a compiled warm-up message', () => {
    expect(NOISE_MATCH).not.toBeNull();
    expect(WARM_MATCH).not.toBeNull();
  });

  it('drops the local warm-up ✓ message (DRIVER_NOISE matches it)', () => {
    const noise = new RegExp(NOISE_MATCH![1]);
    const warm = WARM_MATCH![1];
    expect(noise.test(`  ✓ ${warm}`)).toBe(true);
  });

  it('still drops the dev server compiler chatter ("✓ Compiled in ...")', () => {
    const noise = new RegExp(NOISE_MATCH![1]);
    expect(noise.test('  ✓ Compiled in 587ms (587 modules)')).toBe(true);
    expect(noise.test('  ✓ Ready in 1.2s')).toBe(true);
  });
});
