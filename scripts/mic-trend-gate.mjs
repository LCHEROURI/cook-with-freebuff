// ============================================================================
// scripts/mic-trend-gate.mjs — the trend report as a MONITORED ARTIFACT.
//
// The regenerable report (docs/mic-regression-trend.md) is only allowed to say
// ZERO two-burst drops: the whole point of the monitor is that the "first
// burst then dead" drop has never fired in CI since the drain-stuck fix, and
// the artifact must never claim otherwise. This tokenless gate reads the
// committed report and exits 1 when the drop count ever exceeds zero — so a
// hand-edit that hides or adds drops, a parser drift in the refresh CLI that
// stops counting them, or a committed red report all fail loudly.
//
// Runs as a step in ci.yml's validate job (every push — the artifact is
// checked on every commit) and in mic-trend-weekly.yml right after
// regeneration (a red week fails the refresh job itself, before any PR is
// opened). The pure extraction/judgement lives in extractDrops/gateReport so
// the logic is fixture-testable; main() is the thin file-reading shell.
//
// Reads the markdown AND its JSON twin (docs/mic-regression-trend.json): the
// Total row's last cell is the cumulative two-burst drop count, and each daily
// data row carries its own drops cell, so a tamper in either direction (Total
// zeroed while a day shows a drop, or a day zeroed while Total shows one) is
// caught independently. On top of the zero-everywhere rule, the Total row must
// EQUAL the sum of the daily drops cells — an internally inconsistent table
// (Total ≠ Σ daily) is a defect even if every individual cell happens to read
// 0. The gate also cross-checks the markdown against the JSON twin (Total
// drops, batch/voice totals, and every daily drops cell) so the two artifacts
// can never drift apart.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'docs', 'mic-regression-trend.md');
const JSON_REPORT = join(ROOT, 'docs', 'mic-regression-trend.json');

/** Daily data rows: `| 2026-08-13 | <batch cell> | <voice cell> | <drops> |`. */
// The drops cell may be bold (`**0**`) or plain (`0`) — the renderer bolds
// the Total row's cell, so both spellings must parse.
const DATA_ROW = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|.*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|$/gm;
/** The cumulative Total row's last cell is the all-time drop count. */
const TOTAL_ROW = /^\|\s*\*\*Total\*\*\s*\|.*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|$/m;

/**
 * Extract the drop counts the report declares: the Total row's cumulative
 * count and every daily data row's drops cell.
 *
 * @param {string} markdown
 * @returns {{ totalDrops: number|null, rows: Array<{date: string, drops: number}> }}
 */
export function extractDrops(markdown) {
  const rows = [];
  for (const m of markdown.matchAll(DATA_ROW)) {
    rows.push({ date: m[1], drops: Number(m[2]) });
  }
  const total = markdown.match(TOTAL_ROW);
  return { totalDrops: total ? Number(total[1]) : null, rows };
}

/** The Total row's batch + voice cells: `| **Total** | **89/90** | **77 clean / 82** | …`. */
const TOTAL_COUNTS_ROW = /^\|\s*\*\*Total\*\*\s*\|\s*\*{0,2}(\d+)\/(\d+)\*{0,2}\s*\|\s*\*{0,2}(\d+)\s*clean\s*\/\s*(\d+)\*{0,2}\s*\|/m;

/**
 * Extract the Total row's batch and voice headline counts, which the JSON
 * twin's totals must agree with.
 *
 * @param {string} markdown
 * @returns {{ batchPasses: number, batchChecks: number, voiceClean: number, voiceDenominator: number }|null}
 */
export function extractTotalCounts(markdown) {
  const m = markdown.match(TOTAL_COUNTS_ROW);
  if (!m) return null;
  return {
    batchPasses: Number(m[1]),
    batchChecks: Number(m[2]),
    voiceClean: Number(m[3]),
    voiceDenominator: Number(m[4]),
  };
}

/**
 * Cross-check the markdown against its JSON twin (docs/mic-regression-trend
 * .json): the Total drops, the batch/voice headline counts, and every daily
 * drops cell must agree. Returns the disagreement list (empty = consistent).
 *
 * @param {string} markdown
 * @param {any} json parsed JSON twin
 * @returns {string[]}
 */
export function crossCheckMarkdownJson(markdown, json) {
  const jt = json && typeof json === 'object' && json.totals && typeof json.totals === 'object' ? json.totals : null;
  const jrows = json && Array.isArray(json.rows) ? json.rows : null;
  if (!jt || !jrows) {
    return ['the JSON twin has no totals or rows — the markdown cannot be cross-checked against it'];
  }
  const errors = [];
  const { totalDrops, rows } = extractDrops(markdown);
  const totals = extractTotalCounts(markdown);
  if (totalDrops !== null && Number(jt.drops) !== totalDrops) {
    errors.push(`markdown **Total** drops ${totalDrops} ≠ JSON totals.drops ${jt.drops} — the two artifacts disagree`);
  }
  if (totals) {
    if (Number(jt.batchPasses) !== totals.batchPasses || Number(jt.batchChecks) !== totals.batchChecks) {
      errors.push(`markdown batch ${totals.batchPasses}/${totals.batchChecks} ≠ JSON totals ${jt.batchPasses}/${jt.batchChecks} — the two artifacts disagree`);
    }
    const jsonVoiceDenom = Number(jt.voiceClean ?? 0) + Number(jt.voiceRed ?? 0);
    if (Number(jt.voiceClean) !== totals.voiceClean || jsonVoiceDenom !== totals.voiceDenominator) {
      errors.push(`markdown voice ${totals.voiceClean} clean / ${totals.voiceDenominator} ≠ JSON totals ${jt.voiceClean} clean / ${jsonVoiceDenom} — the two artifacts disagree`);
    }
  }
  const jsonByDate = new Map(jrows.map((r) => [r.date, Number(r.drops)]));
  for (const r of rows) {
    if (!jsonByDate.has(r.date)) errors.push(`markdown day ${r.date} has no JSON twin row — the two artifacts disagree`);
    else if (jsonByDate.get(r.date) !== r.drops) errors.push(`markdown day ${r.date} drops ${r.drops} ≠ JSON row drops ${jsonByDate.get(r.date)} — the two artifacts disagree`);
  }
  const mdDates = new Set(rows.map((r) => r.date));
  for (const jr of jrows) {
    if (!mdDates.has(jr.date)) errors.push(`JSON row ${jr.date} has no markdown day — the two artifacts disagree`);
  }
  return errors;
}
export function gateReport(markdown) {
  const { totalDrops, rows } = extractDrops(markdown);
  const sumDrops = rows.reduce((s, r) => s + r.drops, 0);
  const errors = [];
  if (totalDrops === null) {
    errors.push('the report has no parseable **Total** row — the artifact must carry the cumulative drop count');
  } else {
    if (totalDrops !== 0) {
      errors.push(`the Total row declares ${totalDrops} two-burst drop(s), not 0`);
    }
    // The cumulative Total row must be the arithmetic sum of its daily rows.
    // A hand-edit that zeroes one side but not the other produces a table
    // whose own numbers contradict each other — fail it regardless of the
    // individual cells.
    if (totalDrops !== sumDrops) {
      errors.push(`the **Total** row declares ${totalDrops} drop(s) but the daily rows sum to ${sumDrops} — the table is internally inconsistent`);
    }
  }
  for (const r of rows) {
    if (r.drops > 0) errors.push(`day ${r.date} reports ${r.drops} two-burst drop(s)`);
  }
  return { ok: errors.length === 0, totalDrops, sumDrops, rows, errors };
}

function main() {
  let markdown;
  try {
    markdown = readFileSync(REPORT, 'utf8');
  } catch {
    console.error(`✗ mic-trend gate: ${REPORT.replace(ROOT + '/', '')} is missing — the monitored artifact must exist to be green`);
    process.exit(1);
  }
  let json;
  try {
    json = JSON.parse(readFileSync(JSON_REPORT, 'utf8'));
  } catch {
    console.error(`✗ mic-trend gate: ${JSON_REPORT.replace(ROOT + '/', '')} is missing or unparseable — the markdown cannot be cross-checked against it`);
    process.exit(1);
  }
  const { ok, totalDrops, sumDrops, rows, errors } = gateReport(markdown);
  const crossErrors = crossCheckMarkdownJson(markdown, json);
  if (!ok || crossErrors.length > 0) {
    console.error('✗ mic-trend gate: the trend report shows two-burst drops, an inconsistent table, or disagrees with its JSON twin — the artifact must stay at 0.');
    for (const e of errors) console.error(`  - ${e}`);
    for (const e of crossErrors) console.error(`  - ${e}`);
    const offenders = rows.filter((r) => r.drops > 0).map((r) => `${r.date}=${r.drops}`);
    if (offenders.length > 0) console.error(`  - offending days: ${offenders.join(', ')}`);
    console.error('  A two-burst drop in CI means the drain-stuck regression is back — investigate before this can land.');
    process.exit(1);
  }
  console.log(`mic-trend gate: **Total** two-burst drops = ${totalDrops} = sum of ${rows.length} day rows (${sumDrops}), matches the JSON twin — report artifact green`);
}

// Only run the shell when executed directly, so the fixture tests can import
// the pure functions without a file-reading side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
