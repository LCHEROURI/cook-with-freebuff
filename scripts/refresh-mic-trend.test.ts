import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ciWindowCoverage, extractRootFailure, HARD_SIGNATURES } from './refresh-mic-trend.mjs';

// ============================================================================
// scripts/refresh-mic-trend.test.ts — pin the one-line per-run evidence
// extractor. Each red voice stage archives the FIRST ✗ FAIL: line from its
// verify:live log — the root cause — so a future red carries its cause in
// the trend JSON instead of requiring a re-query of the workflow log.
// ============================================================================

describe('extractRootFailure', () => {
  it('returns the FIRST ✗ FAIL: line — the root cause, not the cascade', () => {
    const log = [
      'Verify deployed app after deploy (verify:live)\tSTEP\t2026-08-17T13:28:32Z   ✗ FAIL: create_recipe → 400 {"code":"INTERNAL_ERROR"}',
      'Verify deployed app after deploy (verify:live)\tSTEP\t2026-08-17T13:33:20Z   ✗ FAIL: UI starter driver → exit 1',
      'Verify deployed app after deploy (verify:live)\tSTEP\t2026-08-17T13:33:20Z   ✗ FAIL: live voice driver → exit 1',
    ].join('\n');
    expect(extractRootFailure(log)).toBe('✗ FAIL: create_recipe → 400 {"code":"INTERNAL_ERROR"}');
  });

  it('strips the job/step/timestamp prefix and trailing whitespace', () => {
    const log = 'job\tstep\t2026-08-17T13:28:32Z   ✗ FAIL: something failed   \n';
    expect(extractRootFailure(log)).toBe('✗ FAIL: something failed');
  });

  it('returns null when the log carries no failure', () => {
    expect(extractRootFailure('all clean\nRESULT: PASS\n')).toBeNull();
    expect(extractRootFailure('')).toBeNull();
  });

  it('keeps the first line even when later lines also fail', () => {
    const log = '  ✗ FAIL: first root\n  ✗ FAIL: second cascade\n  ✗ FAIL: third cascade\n';
    expect(extractRootFailure(log)).toBe('✗ FAIL: first root');
  });
});

describe('ciWindowCoverage · the paged ci.yml fetch must reach the fix-window start', () => {
  it('covers the window when the oldest fetched run predates the start', () => {
    const runs = [
      { created_at: '2026-08-18T00:00:00Z' },
      { created_at: '2026-08-13T14:37:38Z' },
      { created_at: '2026-08-12T23:59:59Z' },
    ];
    expect(ciWindowCoverage(runs)).toEqual({ covered: true, oldestCreatedAt: '2026-08-12T23:59:59Z' });
  });

  it('does NOT cover when the fetch stops at the window start (the earliest in-window day may be missing)', () => {
    const runs = [
      { created_at: '2026-08-18T00:00:00Z' },
      { created_at: '2026-08-13T00:00:01Z' },
    ];
    expect(ciWindowCoverage(runs).covered).toBe(false);
  });

  it('does NOT cover an empty fetch', () => {
    expect(ciWindowCoverage([])).toEqual({ covered: false, oldestCreatedAt: null });
  });
});

describe('the paged ci.yml gather wiring', () => {
  it('pages the ci.yml runs instead of a --limit ceiling, and fails loudly when the window start is unreachable', () => {
    const cli = readFileSync('scripts/refresh-mic-trend.mjs', 'utf8');
    // The old --limit 2000 ceiling silently dropped the oldest in-window runs
    // once the workflow outgrew it — it must be gone.
    expect(cli).not.toContain('--limit 2000');
    expect(cli).toContain('listCiPushRunsPaged');
    expect(cli).toContain('event=push&branch=main');
    expect(cli).toContain('ciWindowCoverage');
    expect(cli).toContain('does not reach the fix-window start');
  });
});

describe('the CLI hard signatures stay in sync with the batch step\'s grep regex', () => {
  it('HARD_SIGNATURES equals the batch grep alternation, so the drops column cannot diverge from the batch verdict', () => {
    // The batch step classifies a run hard/flake by grepping driver.log for
    // this ERE alternation; the trend CLI classifies the SAME runs from the
    // same log via HARD_SIGNATURES. A future edit that adds/removes/renames a
    // signature in one place but not the other would make the trend's drops
    // column disagree with the weekly batch verdict — this pins the two as one
    // set. (The summary-outcome grep ends in "$summary", so only the
    // "$log"-suffixed alternation matches.)
    const workflow = readFileSync('.github/workflows/mic-regression.yml', 'utf8');
    const m = workflow.match(/grep -qE '([^']+)' "\$log"/);
    expect(m, 'batch log-grep regex not found').not.toBeNull();
    // The grep is an ERE alternation: split on | and undo the \( \) escaping
    // so the literals line up with the raw HARD_SIGNATURES strings.
    const grepSignatures = m![1]
      .split('|')
      .map((s) => s.replace(/\\([()])/g, '$1'));
    expect(grepSignatures.sort()).toEqual([...HARD_SIGNATURES].sort());
  });
});
