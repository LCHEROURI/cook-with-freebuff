import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  gatePresenceVerdict,
  isGateWired,
  GATE_STEP_NAME,
  GATE_RUN_CMD,
  GATE_PRESENCE_WINDOW_DAYS,
} from './mic-trend-gate-presence.mjs';

// ============================================================================
// scripts/mic-trend-gate-presence.test.ts — pin the weekly check that the
// zero-drop gate is still wired into ci.yml AND has actually executed in a
// recent run. A disabled gate (step removed, or a job restructure that stops
// it reaching the step) must fail the weekly job, never silently un-guard
// the artifact.
// ============================================================================

const WIRED = `jobs:\n  validate:\n    steps:\n      - name: ${GATE_STEP_NAME}\n        run: ${GATE_RUN_CMD}\n`;
const UNWIRED = `jobs:\n  validate:\n    steps:\n      - name: Some other step\n        run: npm run check\n`;

const run = (id: string, conclusion: 'success' | 'failure' | 'skipped' | 'cancelled' | null) => ({
  id,
  createdAt: '2026-08-18T12:00:00Z',
  gateStepConclusion: conclusion,
});

describe('gatePresenceVerdict', () => {
  it('passes when the gate is wired and a recent run executed it (success)', () => {
    const v = gatePresenceVerdict({ ciYml: WIRED, runs: [run('r1', 'success')] });
    expect(v.ok).toBe(true);
    expect(v.gateWired).toBe(true);
    expect(v.lastExecution?.id).toBe('r1');
    expect(v.errors).toEqual([]);
  });

  it('treats a failing execution as ran — the gate protected the artifact even when it reddened', () => {
    const v = gatePresenceVerdict({ ciYml: WIRED, runs: [run('r2', 'failure')] });
    expect(v.ok).toBe(true);
    expect(v.lastExecution?.id).toBe('r2');
  });

  it('fails when the step was removed from ci.yml, even if an older run executed it', () => {
    // The gate ran recently, but is no longer wired in NOW — the artifact is
    // unguarded going forward, so this must fail regardless of history.
    const v = gatePresenceVerdict({ ciYml: UNWIRED, runs: [run('r3', 'success')] });
    expect(v.ok).toBe(false);
    expect(v.gateWired).toBe(false);
    expect(v.errors.join('\n')).toContain('no longer guarded on every push');
  });

  it('fails when wired but no run executed the step (all skipped)', () => {
    const v = gatePresenceVerdict({ ciYml: WIRED, runs: [run('r4', 'skipped'), run('r5', 'cancelled')] });
    expect(v.ok).toBe(false);
    expect(v.lastExecution).toBeNull();
    expect(v.errors.join('\n')).toContain('no ci.yml run has executed the gate step');
  });

  it('fails when the repo went silent — no ci.yml runs in the window at all', () => {
    const v = gatePresenceVerdict({ ciYml: WIRED, runs: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('disabled gate has silently stopped protecting');
  });

  it('does not count a skipped or cancelled step as an execution', () => {
    expect(gatePresenceVerdict({ ciYml: WIRED, runs: [run('x', 'skipped')] }).ok).toBe(false);
    expect(gatePresenceVerdict({ ciYml: WIRED, runs: [run('x', 'cancelled')] }).ok).toBe(false);
    expect(gatePresenceVerdict({ ciYml: WIRED, runs: [run('x', null)] }).ok).toBe(false);
  });

  it('reports the window in the dynamic error', () => {
    const v = gatePresenceVerdict({ ciYml: WIRED, runs: [] });
    expect(v.errors.join('\n')).toContain(`last ${GATE_PRESENCE_WINDOW_DAYS} days`);
  });
});

describe('the committed ci.yml artifact', () => {
  it('still wires the gate step right now (static half)', () => {
    const ciYml = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(isGateWired(ciYml), 'ci.yml must still define the gate step').toBe(true);
    expect(ciYml).toContain(GATE_STEP_NAME);
    expect(ciYml).toContain(GATE_RUN_CMD);
  });

  it('is wired as a runnable script with the exit-1 contract', () => {
    const script = readFileSync('scripts/mic-trend-gate-presence.mjs', 'utf8');
    expect(script).toContain("const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml');");
    expect(script).toContain('process.exit(1)');
    expect(script).toContain('disabled gate has silently stopped protecting');
    expect(script).toContain(`GATE_PRESENCE_WINDOW_DAYS = ${GATE_PRESENCE_WINDOW_DAYS}`);
  });
});
