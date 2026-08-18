import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stalenessVerdict, STALENESS_WINDOW_DAYS } from './mic-trend-staleness.mjs';

// ============================================================================
// scripts/mic-trend-staleness.test.ts — pin the staleness gate for the trend
// report. The gate's job: the report may be green (zero drops) but must also
// prove the monitor is still running — no new clean two-burst checks for two
// consecutive weeks fails the weekly job. Fixtures pin the trailing-window
// arithmetic (inclusive boundary), and the last test reads the REAL committed
// JSON twin the weekly workflow gates on.
// ============================================================================

/** A per-day row with the counts the staleness gate reads. */
const row = (date: string, batchPasses = 0, voiceClean = 0) => ({
  date,
  batches: 0,
  batchChecks: 0,
  batchPasses,
  voiceClean,
  voiceRed: 0,
  voiceOther: 0,
  voiceSkipped: 0,
  voiceCancelled: 0,
  drops: 0,
});

const data = (windowEnd: string, rows: unknown[]) => ({
  schemaVersion: 1,
  generatedAt: windowEnd,
  windowStart: '2026-08-13',
  windowEnd,
  summary: {},
  rows,
  totals: {},
});

// windowEnd 2026-09-01 → trailing 14 days inclusive = [2026-08-19, 2026-09-01].
describe('stalenessVerdict', () => {
  it('passes when clean checks landed within the trailing 14 days', () => {
    const v = stalenessVerdict(
      data('2026-09-01', [row('2026-08-13', 12, 12), row('2026-08-20', 6, 0)]),
    );
    // The Aug 13 checks are 19 days old (outside the window); only Aug 20 counts.
    expect(v.ok).toBe(true);
    expect(v.recentChecks).toBe(6);
    expect(v.lastCleanDate).toBe('2026-08-20');
    expect(v.errors).toEqual([]);
  });

  it('sums batch passes and clean voice stages across in-window days', () => {
    const v = stalenessVerdict(
      data('2026-09-01', [row('2026-08-20', 6, 0), row('2026-08-25', 0, 3), row('2026-08-30', 6, 1)]),
    );
    expect(v.ok).toBe(true);
    expect(v.recentChecks).toBe(16); // 6 + 3 + 7
    expect(v.lastCleanDate).toBe('2026-08-30');
  });

  it('fails when every clean check aged out — two consecutive silent weeks', () => {
    const v = stalenessVerdict(
      data('2026-09-01', [row('2026-08-13', 12, 12), row('2026-08-14', 0, 20), row('2026-08-18', 6, 6)]),
    );
    expect(v.ok).toBe(false);
    expect(v.recentChecks).toBe(0);
    expect(v.lastCleanDate).toBeNull();
    expect(v.errors.join('\n')).toContain('two consecutive weeks');
  });

  it('counts the inclusive boundary day and excludes the day before it', () => {
    // 2026-08-19 is exactly the start of the 14-day window; 2026-08-18 is not.
    const v = stalenessVerdict(data('2026-09-01', [row('2026-08-19', 6, 0), row('2026-08-18', 6, 0)]));
    expect(v.ok).toBe(true);
    expect(v.recentChecks).toBe(6);
    expect(v.lastCleanDate).toBe('2026-08-19');
  });

  it('fails a missing or unparseable windowEnd (an unreadable report cannot be green)', () => {
    expect(stalenessVerdict({}).ok).toBe(false);
    expect(stalenessVerdict({ windowEnd: 'not-a-date', rows: [row('2026-08-20', 6, 0)] }).ok).toBe(false);
    expect(stalenessVerdict({ windowEnd: 'not-a-date', rows: [] }).errors.join('\n')).toContain('no parseable windowEnd');
  });

  it('fails empty rows — no evidence at all is not growth', () => {
    const v = stalenessVerdict(data('2026-09-01', []));
    expect(v.ok).toBe(false);
    expect(v.recentChecks).toBe(0);
  });
});

describe('the committed JSON twin artifact', () => {
  it('is fresh right now (the same file the weekly job gates on)', () => {
    const json = JSON.parse(readFileSync('docs/mic-regression-trend.json', 'utf8'));
    const v = stalenessVerdict(json);
    expect(v.ok, `the committed report must show recent clean checks: ${v.errors.join('; ')}`).toBe(true);
    expect(v.recentChecks).toBeGreaterThan(0);
  });

  it('is wired as a runnable gate script with the exit-1 contract', () => {
    const gate = readFileSync('scripts/mic-trend-staleness.mjs', 'utf8');
    expect(gate).toContain("const JSON_REPORT = join(ROOT, 'docs', 'mic-regression-trend.json');");
    expect(gate).toContain('process.exit(1)');
    expect(gate).toContain('two consecutive weeks');
    expect(gate).toContain(`STALENESS_WINDOW_DAYS = ${STALENESS_WINDOW_DAYS}`);
  });
});
