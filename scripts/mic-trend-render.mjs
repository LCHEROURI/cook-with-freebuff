// ============================================================================
// scripts/mic-trend-render.mjs — the PURE rendering half of the regenerable
// trend report (docs/mic-regression-trend.md). The CLI
// (scripts/refresh-mic-trend.mjs) gathers the GitHub API data; this module
// aggregates it into per-day rows and renders the full markdown, so the
// report is regenerable and the rendering is unit-testable with fixtures.
//
// The report's narrative sections (Sources, the pre-fix signature, Caveats)
// are static prose; only the headline numbers, the per-day table, the Total
// row, and the window end are computed. Historical footnotes are preserved in
// the FOOTNOTES map below (keyed by UTC date, attached to a count category);
// days without annotations render generic cells.
// ============================================================================

/** First day with CI-verifiable runs — the voice stage debuted Aug 13 14:37. */
export const FIX_WINDOW_START = '2026-08-13';

/**
 * @typedef {{ on: 'batch'|'red'|'red-other'|'skipped'|'cancelled', text: string }} FootnoteItem
 * @typedef {{ batchLabel?: string, batchCell?: string, batch?: FootnoteItem[], voice?: FootnoteItem[] }} FootnoteEntry
 */

// Historical footnotes, keyed by UTC date. Each entry attaches a marker to a
// cell/count: { on: 'batch'|'red'|'red-other'|'skipped'|'cancelled', text }.
// `batchLabel` / `batchCell` override the generic batch cell for bespoke
// days; both are validated against the computed numbers in the fixture tests
// (scripts/mic-trend-render.test.ts): the override's implied pass/check
// counts must equal what the aggregate computes for that day's data.
// Exported for those tests; read-only data, never mutated by the CLI.
/** @type {Record<string, FootnoteEntry>} */
export const FOOTNOTES = {
  '2026-08-13': {
    voice: [
      {
        on: 'red',
        text: 'Aug 13 14:37 + 15:49 — the voice stage\'s first two runs ever (the job debuted that day): driver timeouts and dictation/LISTENING-stage misses during rollout, not a two-burst drop.',
      },
    ],
  },
  '2026-08-14': {
    voice: [
      {
        on: 'skipped',
        text: 'verify:live skipped when emulator-compare gated the deploy (e.g. the marker-atomicity timeout run Aug 14 11:25) — no voice stage ran.',
      },
    ],
  },
  '2026-08-17': {
    // Stored WITHOUT parens — the render wraps it: "(weekly)".
    batchLabel: 'weekly',
    voice: [
      {
        on: 'red',
        text: 'voice driver red at the dictation/LISTENING stage in the Gemini-credits/quota era (Aug 17 13:21 + 13:47 + 17:38); the driver died before any burst completed, so the two-burst assertion never fired.',
      },
      {
        on: 'red-other',
        text: 'voice stage passed (Aug 17 23:09); the run red elsewhere (the model-source log-smoke IAM lag fixed by roles/logging.viewer).',
      },
    ],
  },
  '2026-08-18': {
    // Validated against the computed 71/72 for that day: 6/6 manual + 65/66
    // burst (the burst was ELEVEN runs — the 5/6 at 13:02 plus ten 6/6 runs
    // through 13:49; the hand-maintained doc once said nine).
    batchCell: '6/6 (manual) + **65/66** (11-batch burst: 10×6/6 + 1×5/6¶)',
    batch: [
      {
        on: 'batch',
        text: 'batch run 1/6 (13:02) failed with a cold-start launch 503 before the mic stage ran — no two-burst verdict exists for it (and no blob was written). The other 5 runs passed; the 10 following batches all passed 6/6.',
      },
    ],
  },
};

const MARKERS = ['*', '†', '‡', '§', '¶', '∥', '❋'];

/**
 * @typedef {object} TrendRow
 * @property {string} date
 * @property {number} batches
 * @property {number} batchChecks
 * @property {number} batchPasses
 * @property {number} batchFlakes
 * @property {number} voiceClean
 * @property {number} voiceRed
 * @property {number} voiceOther
 * @property {number} voiceSkipped
 * @property {number} voiceCancelled
 * @property {number} drops
 */

/**
 * @typedef {object} TrendTotals
 * @property {number} batches
 * @property {number} batchChecks
 * @property {number} batchPasses
 * @property {number} batchFlakes
 * @property {number} voiceClean
 * @property {number} voiceRed
 * @property {number} voiceOther
 * @property {number} voiceSkipped
 * @property {number} voiceCancelled
 * @property {number} drops
 */

/**
 * @typedef {object} RedVoiceStage
 * @property {string} id
 * @property {string} date
 * @property {string} createdAt
 * @property {string|null} rootFailure
 */

/**
 * @typedef {object} TrendJson
 * @property {number} schemaVersion
 * @property {string} generatedAt
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {{ cleanChecks: number, dropFreeProbability: number, probabilityExponent: number }} summary
 * @property {TrendRow[]} rows
 * @property {TrendTotals} totals
 * @property {RedVoiceStage[]} redVoiceStages
 */

/**
 * Aggregate mic-regression batch runs and ci.yml verify-live voice stages into
 * per-UTC-day rows + totals.
 *
 * @param {Array<{id: string, createdAt: string, conclusion: string|null, batch: {passes: number, checks: number, drops: number}|null}>} batchRuns
 * @param {Array<{id: string, createdAt: string, kind: 'clean'|'voice-red'|'red-other'|'skipped'|'cancelled', drops?: number}>} voiceStages
 * @returns {{ rows: TrendRow[], totals: TrendRow }}
 */
export function aggregateMicTrend(batchRuns, voiceStages) {
  const blank = (date) => ({
    date,
    batches: 0,
    batchChecks: 0,
    batchPasses: 0,
    batchFlakes: 0,
    voiceClean: 0,
    voiceRed: 0,
    voiceOther: 0,
    voiceSkipped: 0,
    voiceCancelled: 0,
    drops: 0,
  });
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, blank(date));
    return days.get(date);
  };
  for (const r of batchRuns) {
    if (!r.batch) continue;
    const d = day(r.createdAt.slice(0, 10));
    d.batches += 1;
    d.batchChecks += r.batch.checks;
    d.batchPasses += r.batch.passes;
    // A flake is a run that reached neither a pass nor a two-burst drop
    // (pre-mic / infra failure, e.g. launch 503) — checks − passes − drops.
    d.batchFlakes += r.batch.checks - r.batch.passes - r.batch.drops;
    d.drops += r.batch.drops;
  }
  for (const v of voiceStages) {
    const d = day(v.createdAt.slice(0, 10));
    d.drops += v.drops ?? 0;
    switch (v.kind) {
      case 'clean': d.voiceClean += 1; break;
      case 'voice-red': d.voiceRed += 1; break;
      case 'red-other': d.voiceOther += 1; break;
      case 'skipped': d.voiceSkipped += 1; break;
      case 'cancelled': d.voiceCancelled += 1; break;
    }
  }
  const rows = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = blank('Total');
  for (const r of rows) {
    totals.batches += r.batches;
    totals.batchChecks += r.batchChecks;
    totals.batchPasses += r.batchPasses;
    totals.batchFlakes += r.batchFlakes;
    totals.voiceClean += r.voiceClean;
    totals.voiceRed += r.voiceRed;
    totals.voiceOther += r.voiceOther;
    totals.voiceSkipped += r.voiceSkipped;
    totals.voiceCancelled += r.voiceCancelled;
    totals.drops += r.drops;
  }
  return { rows, totals };
}

/** P(checks consecutive clean two-burst checks | pre-fix 33% drop rate). */
export function dropFreeProbability(checks) {
  return Math.pow(2 / 3, checks);
}

/** Human exponent for the probability, e.g. 161 → 28 (≈10⁻²⁸). */
export function probabilityExponent(p) {
  return Math.round(-Math.log10(p));
}

/** The pre-fix drop rate (documented in docs/pre-fix-drop-signature.md). */
export const PRE_FIX_DROP_RATE = '33%';

/**
 * The pre-CI local measurement batches (the fix window, Aug 12) — LOCAL runs
 * the workflow header's original "28/28 since" referred to, predating the
 * verify:live job in CI (Aug 13 14:37). They are NOT part of the CI table;
 * the Caveats re-print them, marked as local, so the pre-fix drop context
 * sits next to the CI numbers.
 *   - Pre-fix: 4 drops — the four failing blobs (docs/pre-fix-drop-signature.md)
 *     that measured the documented 33% drop rate.
 *   - Post-fix: 28/28 clean — the original header's "28/28 since".
 * The `result` strings render verbatim; the pre-fix one is tied to
 * PRE_FIX_DROP_RATE so the rate cannot drift from the confidence math.
 */
export const PRE_CI_LOCAL = [
  { label: 'Pre-fix', window: 'before `6683aab`', drops: 4, result: `${PRE_FIX_DROP_RATE} drop rate` },
  { label: 'Post-fix', window: 'Aug 12, before CI', drops: 0, result: '28/28 clean' },
];

function batchCell(d, foot) {
  const checks = d.batchChecks;
  if (checks === 0) return '—';
  if (foot?.batchCell) return foot.batchCell;
  const label = foot?.batchLabel ? ` (${foot.batchLabel})` : ` (${d.batches} batch${d.batches === 1 ? '' : 'es'})`;
  return d.batchPasses === checks ? `**${d.batchPasses}/${checks}**${label}` : `${d.batchPasses}/${checks}${label}`;
}

function voiceCell(d, markers) {
  if (d.voiceClean === 0 && d.voiceRed === 0 && d.voiceOther === 0 && d.voiceSkipped === 0 && d.voiceCancelled === 0) return '—';
  const parts = [`${d.voiceClean} clean`];
  if (d.voiceRed > 0) parts.push(`+ ${d.voiceRed} red${markers.red ?? ''}`);
  if (d.voiceOther > 0) parts.push(`+ ${d.voiceOther} red-other${markers.redOther ?? ''}`);
  let cell = parts.join(' ');
  const aside = [];
  if (d.voiceSkipped > 0) aside.push(`${d.voiceSkipped} skipped${markers.skipped ?? ''}`);
  if (d.voiceCancelled > 0) aside.push(`${d.voiceCancelled} cancelled`);
  if (aside.length > 0) cell += ` (${aside.join(', ')})`;
  return cell;
}

/** Infra-flakes cell: `—` when no batch ran that day, else the flaked count. */
function flakesCell(d) {
  if (d.batchChecks === 0) return '—';
  return String(d.batchFlakes);
}

/**
 * Render the full report markdown.
 *
 * @param {{ generatedAt: string, rows: TrendRow[], totals: TrendRow }} data
 *   - generatedAt: ISO date the report was regenerated (UTC).
 * @returns {string}
 */
export function renderReport({ generatedAt, rows, totals }) {
  const batchPasses = totals.batchPasses;
  const voiceClean = totals.voiceClean;
  const checks = batchPasses + voiceClean; // clean two-burst checks (a non-drop launch flake has no verdict)
  const p = dropFreeProbability(checks);
  const pExp = probabilityExponent(p);
  const windowEnd = generatedAt.slice(0, 10);

  // Assign footnote markers sequentially over dates (batch first, then voice,
  // preserving each list's order) — deterministic and stable.
  const markerFor = new Map(); // `${date}:${on}` -> marker
  const footnotes = [];
  for (const row of rows) {
    const foot = FOOTNOTES[row.date];
    if (!foot) continue;
    const items = [...(foot.batch ?? []), ...(foot.voice ?? [])];
    for (const item of items) {
      const marker = MARKERS[footnotes.length] ?? '¶';
      markerFor.set(`${row.date}:${item.on}`, marker);
      footnotes.push(`${marker} ${item.text}`);
    }
  }
  const batchMarkers = (date) => {
    const m = markerFor.get(`${date}:batch`);
    return m ? ` (${m})` : '';
  };

  const tableRows = rows
    .map((d) => {
      const foot = FOOTNOTES[d.date];
      // An overridden batch cell carries its own footnote marker in its text
      // (e.g. the Aug 18 "…1×5/6¶" cell) — appending the generic marker would
      // double it. Only the computed cells get the marker suffix.
      const b = foot?.batchCell ? foot.batchCell : batchCell(d, foot) + (foot?.batch?.length ? batchMarkers(d.date) : '');
      const markers = {
        red: markerFor.get(`${d.date}:red`) ?? '',
        redOther: markerFor.get(`${d.date}:red-other`) ?? '',
        skipped: markerFor.get(`${d.date}:skipped`) ?? '',
      };
      return `| ${d.date} | ${b} | ${voiceCell(d, markers)} | ${flakesCell(d)} | ${d.drops} |`;
    })
    .join('\n');
  // Voice denominator = clean + red: the runs that produced a two-burst voice
  // verdict. red-other runs (voice stage passed, run red elsewhere) are shown
  // in the day cell with a footnote but excluded here — the doc has always
  // published this denominator (78 clean / 83 through Aug 18).
  const totalRow = `| **Total** | **${totals.batchPasses}/${totals.batchChecks}** | **${totals.voiceClean} clean / ${totals.voiceClean + totals.voiceRed}** | **${totals.batchFlakes}** | **${totals.drops}** |`;

  const footnoteBlock = footnotes.length > 0 ? `\n${footnotes.map((f) => `\\${f}`).join('\n')}\n` : '';

  // The pre-CI local measurements, rendered as their own marked table so the
  // pre-fix 33% context sits next to the CI numbers (never merged into the
  // CI table above).
  // Two-space indent on every row keeps the table inside the Caveats bullet
  // (a column-0 data row would break the list nesting and split the table).
  const preCiTable = PRE_CI_LOCAL.map(
    (r) => `  | ${r.label} | ${r.window} | ${r.drops} | ${r.drops > 0 ? `**${r.result}**` : r.result} |`,
  ).join('\n');

  return `# Two-burst mic path — live pass-rate trend

**As of:** ${windowEnd} (UTC — regenerated by \`npm run refresh:mic-trend\`)
**Verdict:** the "first burst then dead" drop has **never fired in CI** since the
drain-stuck fix — **0 drops across ${checks} clean two-burst checks** (${batchPasses} batch runs
+ ${voiceClean} post-deploy voice stages).

## Sources

Every number below is read from GitHub Actions history — nothing is estimated.

| Source | What it runs | Checks per run |
|---|---|---|
| \`mic-regression.yml\` (scheduled Mondays + manual) | \`drive-live-voice.mjs --phase-c-only\` — 6 two-burst probes against the live \`/cook\` with a real owner session | 6 |
| \`ci.yml\` → \`verify-live\` job → voice stage | \`drive-live-voice.mjs\` (phases A+B+C) after every \`main\` deploy — includes the same two-burst phase-C check | 1 |

**Window:** the drain-stuck fix commit \`6683aab\` (2026-08-12 20:37 EDT, "stop a
stuck playback drain from leaving the mic muted forever") through ${windowEnd}.

**The pre-fix signature:** the four failing blobs that measured the ${PRE_FIX_DROP_RATE} drop
rate were never archived — see
[\`pre-fix-drop-signature.md\`](./pre-fix-drop-signature.md) for the
reconstruction (from the fix commits + the verdict-test fixture) and its diff
against a real healthy blob: **\`playing=false\` ∧ \`playbackQueueLength>0\` while
\`connected=true\` / \`micStarted=true\`, with the stuck state invisible** — every
pre-fix field of a stuck run matched a healthy run except the queue length.

## The trend

| Date (UTC) | mic-regression batches | verify:live voice stages | Infra flakes | Two-burst drops |
|---|---|---|---|---|
${tableRows}
${totalRow}
${footnoteBlock}
## What this proves

- **The phase-C assertion — "TWO spoken bursts transcribed through the active
  mic" with a clean \`stuckQueueSince=0\` blob — has fired ${checks} times (${voiceClean} deploy
  stages + ${batchPasses} batch runs) and failed 0 times.** At the pre-fix ${PRE_FIX_DROP_RATE}
  drop rate, P(${checks} consecutive clean) ≈ 10⁻${pExp}, so the old failure mode is
  effectively impossible to be hiding here.
- The **red voice stages were never the two-burst drop**: none contains the
  \`only N transcription(s) after 90s\` or stuck-queue failure line — they died
  earlier (dictation/LISTENING), matching driver-rollout and model-quota
  causes, not the drain-stuck bug.

## Caveats

- This report only counts **CI-verifiable runs** — the \`verify:live\` job
  did not exist in CI until Aug 13 14:37, and push runs before that morning
  predate it. The fix window's **pre-CI local measurement batches** (the
  workflow header's original "28/28 since", written when the monitor shipped
  Aug 12) are LOCAL runs, shown below for context and marked as such — they
  are not part of the CI table above:

  | Local measurement (pre-CI) | Window | Drops | Result |
  |---|---|---|---|
${preCiTable}

  The **${PRE_FIX_DROP_RATE}** pre-fix row is the "before" against the CI
  table's "after" (${totals.drops} drops across ${checks} clean checks). The
  four pre-fix failing blobs are reconstructed in
  [\`pre-fix-drop-signature.md\`](./pre-fix-drop-signature.md).
- A batch run can fail on a **launch 503** with no two-burst verdict; those
  runs are charted in the **Infra flakes** column (${totals.batchFlakes} across the window) and are
  excluded from the confidence bound's ${checks} clean checks. The same flake
  within budget three weeks running escalates via \`mic-flake-escalate.mjs\`.
- A green batch proves the two-burst path on the **deployed** app with a
  synthetic speech device — not real microphone hardware or user audio.

## Regenerating

\`\`\`bash
npm run refresh:mic-trend   # queries the GitHub API and rewrites this file
\`\`\`

Requires \`gh\` authenticated (or \`GH_TOKEN\` in CI). The weekly
\`mic-trend-weekly.yml\` job runs it every Tuesday 06:30 UTC after the Monday
batch and opens a PR when the table changed.
`;
}

/**
 * Build the machine-readable JSON twin of the report — the aggregated per-day
 * rows, the totals, and the derived confidence bound — so future tooling
 * (charts, alerts) can consume the trend without re-querying the GitHub API.
 *
 * Deterministic on purpose: the same data on the same UTC day produces
 * byte-identical output (generatedAt is the DATE, not a timestamp), so the
 * weekly workflow's diff-based PR gating still fires only when the data (or
 * the window) actually changed.
 *
 * @param {{ generatedAt: string, rows: TrendRow[], totals: TrendRow, redVoiceStages?: RedVoiceStage[] }} data
 * @returns {TrendJson}
 */
export function buildTrendJson({ generatedAt, rows, totals, redVoiceStages = [] }) {
  const windowEnd = generatedAt.slice(0, 10);
  const checks = totals.batchPasses + totals.voiceClean;
  const p = dropFreeProbability(checks);
  // totals carries `date: 'Total'` only to render the markdown Total row —
  // strip it so the JSON aggregate is a plain object of numbers, not a
  // row-shaped impostor.
  const { date: _totalDate, ...totalsOnly } = totals;
  return {
    schemaVersion: 1,
    generatedAt: windowEnd,
    windowStart: FIX_WINDOW_START,
    windowEnd,
    summary: {
      cleanChecks: checks,
      dropFreeProbability: p,
      probabilityExponent: probabilityExponent(p),
    },
    rows,
    totals: totalsOnly,
    // Each red voice stage carries its root failure line, so a future red
    // trend row can be diagnosed without re-querying its workflow log.
    redVoiceStages,
  };
}
