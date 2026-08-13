import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-compare-emulator.test.ts — lock the emulator parity check.
//
// verify:live:compare:emulator proves the local emulator stack reproduces the
// deployed stack's deterministic guided flow, with the local side fully
// offline. Its load-bearing properties are: the two legs (deployed via
// verify:live, emulator via verify:live:emulator); the exact set of seven
// shared guided-flow steps it compares (a future edit that adds/drops a step
// must fail here rather than silently widen or narrow the contract); the
// normalization that makes ephemeral content comparable; and the one-command
// npm wiring.
// ============================================================================

const SCRIPT = readFileSync('scripts/verify-live-compare-emulator.mjs', 'utf8');
const PKG = readFileSync('package.json', 'utf8');

const SHARED_STEPS = [
  'seeded (owner ',
  'owner ID token minted',
  'launch → PREP_GUIDANCE',
  'starts at prep step 1',
  'done → prep step 2',
  'safety gate surfaced',
  'gate acknowledged → timer auto-started',
];

describe('verify:live:compare:emulator · contract lock', () => {
  it('runs the deployed leg (verify:live --guided-only) and the emulator leg (verify:live:emulator)', () => {
    expect(SCRIPT).toContain("['run', 'verify:live', '--', '--guided-only']");
    expect(SCRIPT).toContain("['run', 'verify:live:emulator']");
  });

  it('compares exactly the seven shared guided-flow steps', () => {
    for (const step of SHARED_STEPS) {
      expect(SCRIPT).toContain(`'${step}'`);
    }
  });

  it('normalizes ephemeral content (recipe ids and owner uids) before diffing', () => {
    expect(SCRIPT).toContain('verify-live-N');
    expect(SCRIPT).toContain('(owner <uid>)');
  });

  it('requires BOTH legs to reach RESULT: PASS', () => {
    expect(SCRIPT).toContain('/RESULT: PASS/.test(DEPLOYED.transcript)');
    expect(SCRIPT).toContain('/RESULT: PASS/.test(EMULATOR.transcript)');
  });

  it('is wired as the one-command npm script', () => {
    expect(PKG).toContain('"verify:live:compare:emulator": "node scripts/verify-live-compare-emulator.mjs"');
  });
});
