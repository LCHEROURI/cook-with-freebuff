// ============================================================================
// scripts/mic-trend-staleness.mjs — the trend report must prove the monitor
// is STILL RUNNING, not just that it once passed.
//
// The zero-drop gate (mic-trend-gate.mjs) only proves the two-burst drop has
// never fired. A monitor that stopped producing fresh evidence — the Monday
// batch gone silent and deploys no longer running verify:live — would keep
// publishing the same green total week after week: a "healthy-looking" report
// with no new data behind it. This gate closes that hole: it fails when the
// total clean-check count has not grown for two consecutive weeks.
//
// Signal: the clean two-burst checks (batch passes + clean voice stages)
// recorded in the trailing 14 days of the report's own window. The refresh
// step rewrites windowEnd to today just before this runs, so the window
// slides forward each week — after the first silent week the old evidence is
// still inside the window (gate stays green), after the second it has aged
// out (gate fails). Exactly the two-consecutive-weeks contract.
//
// Reads the machine-readable twin (docs/mic-regression-trend.json), not the
// markdown: the per-day rows carry batchPasses + voiceClean directly, so no
// table scraping. Runs in mic-trend-weekly.yml right after the zero-drop
// gate, before any PR is opened. The pure judgement lives in stalenessVerdict
// (fixture-testable); main() is the thin file-reading shell.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_REPORT = join(ROOT, 'docs', 'mic-regression-trend.json');

/** Two consecutive silent weeks: the trailing window that must show growth. */
export const STALENESS_WINDOW_DAYS = 14;

const MS_PER_DAY = 86400000;

/** Parse a YYYY-MM-DD date as a UTC epoch ms. */
function toEpoch(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * @typedef {object} StalenessVerdict
 * @property {boolean} ok
 * @property {number} recentChecks
 * @property {string|null} windowEnd
 * @property {number} windowDays
 * @property {string|null} lastCleanDate
 * @property {string[]} errors
 */

/**
 * Judge freshness: has the clean-check total grown within the trailing
 * `STALENESS_WINDOW_DAYS` of the report's window? ok=false means it has not
 * — two consecutive silent weeks, so a stopped monitor cannot look healthy.
 *
 * @param {any} data parsed docs/mic-regression-trend.json
 * @returns {StalenessVerdict}
 */
export function stalenessVerdict(data) {
  const errors = [];
  const windowEnd =
    data && typeof data.windowEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.windowEnd)
      ? data.windowEnd
      : null;
  if (!windowEnd) {
    return {
      ok: false,
      recentChecks: 0,
      windowEnd,
      windowDays: STALENESS_WINDOW_DAYS,
      lastCleanDate: null,
      errors: ['the JSON twin has no parseable windowEnd — a readable report must carry its window'],
    };
  }

  const end = toEpoch(windowEnd);
  // Inclusive window: [windowEnd - 13 days, windowEnd] = 14 calendar days.
  const start = end - (STALENESS_WINDOW_DAYS - 1) * MS_PER_DAY;
  const startStr = new Date(start).toISOString().slice(0, 10);

  let recentChecks = 0;
  let lastCleanDate = null;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  for (const row of rows) {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    const epoch = toEpoch(row.date);
    if (epoch < start || epoch > end) continue;
    const checks = (Number(row.batchPasses) || 0) + (Number(row.voiceClean) || 0);
    if (checks > 0) {
      recentChecks += checks;
      if (!lastCleanDate || row.date > lastCleanDate) lastCleanDate = row.date;
    }
  }

  if (recentChecks === 0) {
    errors.push(
      `the clean-check total has not grown in the last ${STALENESS_WINDOW_DAYS} days (${startStr}..${windowEnd}) — the monitor produced no clean two-burst checks for two consecutive weeks`,
    );
  }
  return { ok: errors.length === 0, recentChecks, windowEnd, windowDays: STALENESS_WINDOW_DAYS, lastCleanDate, errors };
}

function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(JSON_REPORT, 'utf8'));
  } catch {
    console.error(`✗ mic-trend staleness: ${JSON_REPORT.replace(ROOT + '/', '')} is missing or unparseable — the refresh must write the JSON twin before this gate`);
    process.exit(1);
  }
  const v = stalenessVerdict(data);
  if (!v.ok) {
    console.error('✗ mic-trend staleness: the report looks healthy but the monitor has not produced fresh evidence.');
    for (const e of v.errors) console.error(`  - ${e}`);
    console.error(`  Recent clean checks: ${v.recentChecks}; last clean check: ${v.lastCleanDate ?? 'none in window'}.`);
    console.error('  A stopped Monday batch or silent verify:live stages cannot keep publishing a green total — investigate before this lands.');
    process.exit(1);
  }
  console.log(`mic-trend staleness: ${v.recentChecks} clean two-burst checks in the last ${v.windowDays} days (window ends ${v.windowEnd}; last clean ${v.lastCleanDate}) — monitor is fresh`);
}

// Only run the shell when executed directly, so the fixture tests can import
// stalenessVerdict without the file-reading side effect (a stale committed
// JSON must never kill an unrelated test run).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
