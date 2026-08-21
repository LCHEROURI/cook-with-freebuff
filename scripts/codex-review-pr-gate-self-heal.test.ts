import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GATE = readFileSync('scripts/codex-review-pr-gate.mjs', 'utf8');

describe('Codex gate cancelled-run self-heal', () => {
  it('only considers PR-associated workflow runs as rerun candidates', () => {
    expect(GATE).toContain(
      "r.name === 'Codex review gate' && healedEvents.has(r.event ?? 'pull_request')",
    );
  });

  it('does not heal a cancellation that a newer completed gate already superseded', () => {
    expect(GATE).toContain(
      "const latestCancelledIndex = gateRuns.findIndex((r) => r.conclusion === 'cancelled');",
    );
    expect(GATE).toContain('const latestCompletedIndex = gateRuns.findIndex(');
    expect(GATE).toContain(
      'if (latestCompletedIndex === -1 || latestCompletedIndex < latestCancelledIndex) return;',
    );
  });
});
