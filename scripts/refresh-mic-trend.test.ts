import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciWindowCoverage, classifyArtifactBatch, classifyRunVerdict, extractRootFailure, HARD_SIGNATURES } from './refresh-mic-trend.mjs';
import { OUTCOME } from './phase-c-summary.mjs';

/** Build a downloaded phase-c-runs artifact dir fixture: run-N/driver.log +
 * (optional) run-N/phase-c-summary.json. Returns the base dir (caller cleans). */
function makeBatch(runs: Record<string, { log?: string; summary?: string }>) {
  const base = mkdtempSync(join(tmpdir(), 'mic-trend-test-'));
  for (const [name, files] of Object.entries(runs)) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    if (files.log !== undefined) writeFileSync(join(dir, 'driver.log'), files.log);
    if (files.summary !== undefined) writeFileSync(join(dir, 'phase-c-summary.json'), files.summary);
  }
  return base;
}

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

describe('classifyRunVerdict · one artifact run dir (structured record)', () => {
  it('RESULT: PASS → pass, even with a hard outcome in the summary', () => {
    expect(classifyRunVerdict({ log: 'RESULT: PASS', summary: '{"outcome":"stuck"}' })).toBe('pass');
  });

  it('a structured hard outcome → drop (the authoritative signal)', () => {
    expect(classifyRunVerdict({ log: '✗ FAIL: some non-route message', summary: '{"outcome":"stuck"}' })).toBe('drop');
    expect(classifyRunVerdict({ log: 'all clean', summary: '{"outcome":"latency"}' })).toBe('drop');
  });

  it('a hard signature with no summary (crash before the write) → drop', () => {
    expect(classifyRunVerdict({ log: '✗ FAIL: passing run but the blob reports a stuck queue', summary: null })).toBe('drop');
  });

  it('a corrupt summary falls through to the log signals', () => {
    expect(classifyRunVerdict({ log: '✗ FAIL: reports a stuck queue', summary: 'not-json' })).toBe('drop');
  });

  it('a pre-mic flake (no summary, no hard signature) → flake', () => {
    expect(classifyRunVerdict({ log: '✗ FAIL: launch → 503', summary: null })).toBe('flake');
  });

  it('a pass outcome without the exit-0 proxy is still not a pass (RESULT: PASS is authoritative)', () => {
    expect(classifyRunVerdict({ log: 'all clean', summary: '{"outcome":"pass"}' })).toBe('flake');
  });
});

describe('classifyArtifactBatch · the downloaded phase-c-runs artifact', () => {
  it('aggregates passes/drops across the six run dirs, treating flakes as neither', () => {
    const base = makeBatch({
      'run-1': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-2': { log: '✗ FAIL: launch → 503' },
      'run-3': { log: '✗ FAIL: reports a stuck queue', summary: '{"outcome":"stuck"}' },
      'run-4': { log: '✗ FAIL: launch → 503' },
      'run-5': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-6': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
    });
    try {
      expect(classifyArtifactBatch(base)).toEqual({ drill: false, incomplete: false, passes: 3, drops: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('excludes a whole drill batch (force_stuck_blob / force_flake_streak markers)', () => {
    const base = makeBatch({
      'run-1': { log: 'stuck signature injected into the judged blob' },
      'run-2': { log: 'RESULT: PASS' },
      'run-3': { log: 'RESULT: PASS' },
      'run-4': { log: 'RESULT: PASS' },
      'run-5': { log: 'RESULT: PASS' },
      'run-6': { log: 'RESULT: PASS' },
    });
    try {
      expect(classifyArtifactBatch(base)).toEqual({ drill: true, incomplete: false, passes: 0, drops: 0 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('marks a batch incomplete when any run dir lacks its driver.log', () => {
    const base = makeBatch({
      'run-1': { log: 'RESULT: PASS' },
      // run-2 omitted entirely
      'run-3': { log: 'RESULT: PASS' },
      'run-4': { log: 'RESULT: PASS' },
      'run-5': { log: 'RESULT: PASS' },
      'run-6': { log: 'RESULT: PASS' },
    });
    try {
      expect(classifyArtifactBatch(base)).toEqual({ drill: false, incomplete: true, passes: 1, drops: 0 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the batch-run gather reads the structured artifact, not the workflow log', () => {
  it('downloads phase-c-runs and classifies from the structured record', () => {
    const cli = readFileSync('scripts/refresh-mic-trend.mjs', 'utf8');
    expect(cli).toContain("'download'");
    expect(cli).toContain("'--name'");
    expect(cli).toContain("'phase-c-runs'");
    expect(cli).toContain("'--dir'");
    expect(cli).toContain('classifyArtifactBatch(dest)');
    expect(cli).toContain('mkdtempSync(join(tmpdir()');
    expect(cli).toContain('rmSync(scratch, { recursive: true, force: true })');
    // The old log-split path is gone — the batch gather no longer reads the
    // workflow log or splits it on the per-run marker.
    expect(cli).not.toContain('RUN_MARKER');
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

  it('every HARD_SIGNATURES entry is still produced by the driver, so a renamed fail line cannot silently drift', () => {
    // HARD_SIGNATURES and the grep are pinned to each other above, but neither
    // is the driver: rename a hard-failure fail() message in
    // drive-live-voice.mjs (e.g. reports a stuck queue → reports a blocked
    // queue) and the batch step stops matching it, silently budgeting a
    // two-burst regression as a flake. Each signature must still appear in a
    // line that produces ✗ FAIL: output — a fail()/console.error line in the
    // driver, or a latency-violation message: the driver interpolates into
    // its latency fail (the latency cannot be bounded signature lives in
    // scripts/phase-c-latency.mjs, not the driver).
    const driver = readFileSync('scripts/drive-live-voice.mjs', 'utf8');
    const latency = readFileSync('scripts/phase-c-latency.mjs', 'utf8');
    const outputLines = `${driver}\n${latency}`
      .split('\n')
      .filter((line) => /fail\(|✗ FAIL:|message:/.test(line));
    expect(outputLines.length, 'no fail/error/message output lines found').toBeGreaterThan(0);
    for (const sig of HARD_SIGNATURES) {
      expect(
        outputLines.some((line) => line.includes(sig)),
        `HARD_SIGNATURES entry '${sig}' is no longer produced by any driver fail line`,
      ).toBe(true);
    }
  });

  it('the batch summary grep derives from HARD_PHASE_C_OUTCOMES, so the outcome set lives in one place', () => {
    // The batch step no longer hardcodes the outcome alternation — it builds
    // it from the exported constant at runtime, so adding/renaming an outcome
    // touches only scripts/phase-c-summary.mjs. Assert the derivation is wired
    // and the old hardcoded alternation is gone.
    const workflow = readFileSync('.github/workflows/mic-regression.yml', 'utf8');
    expect(workflow).toContain('HARD_PHASE_C_OUTCOMES.join("|")');
    expect(workflow).toContain('${hard_outcomes}');
    expect(workflow).not.toContain('(stuck|undrained|unverifiable|latency|drop)');
  });

  it('the driver assigns summary.outcome from OUTCOME.* — the export the grep derives from — so no parallel literal list can drift', () => {
    // The driver's outcome values now come from the OUTCOME map in
    // phase-c-summary.mjs (the same export the batch grep derives from), so
    // there is no second list of literals to rename. Assert every assignment
    // references OUTCOME.* (no bare string) and the assigned keys equal the
    // OUTCOME keys exactly, with 'pass' written once at the shared exit.
    const driver = readFileSync('scripts/drive-live-voice.mjs', 'utf8');
    expect(driver).not.toMatch(/summary\.outcome = '[a-z]+'/);
    const keys = [...driver.matchAll(/summary\.outcome = OUTCOME\.([a-zA-Z]+)/g)].map((a) => a[1]);
    expect(keys.length, 'no summary.outcome = OUTCOME.* assignments found').toBeGreaterThan(0);
    expect([...new Set(keys)].sort()).toEqual(Object.keys(OUTCOME).sort());
    expect(keys.filter((k) => k === 'pass').length).toBe(1);
  });
});
