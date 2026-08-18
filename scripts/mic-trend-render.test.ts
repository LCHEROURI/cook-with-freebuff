import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateMicTrend,
  buildTrendJson,
  renderReport,
  dropFreeProbability,
  probabilityExponent,
  PRE_FIX_DROP_RATE,
  PRE_CI_LOCAL,
  FIX_WINDOW_START,
  FOOTNOTES,
} from './mic-trend-render.mjs';

// ============================================================================
// scripts/mic-trend-render.test.ts — pin the PURE rendering half of the
// regenerable trend report with fixtures. The CLI (refresh-mic-trend.mjs)
// gathers the API data; this suite proves the aggregation + rendering are
// stable and that the historical footnote overrides stay consistent with the
// computed numbers (a bespoke cell that silently disagrees with the data
// would fail here).
//
// The main fixture mirrors the REAL Actions history verified on Aug 18 2026
// (every number cross-checked against gh run list + gh run view):
//   batches  — Aug 13: 2×6/6 · Aug 17: 1×6/6 · Aug 18: 1×6/6 (manual) +
//              1×5/6 (launch-503 run, no verdict) + 10×6/6 → 89/90
//   voice    — Aug 13: 12 clean + 2 red · Aug 14: 20 clean + 2 skipped +
//              2 cancelled · Aug 15: 13 clean · Aug 16: 13 clean ·
//              Aug 17: 13 clean + 3 red + 1 red-other + 1 cancelled ·
//              Aug 18: 6 clean → 77 clean / 82, 166 clean checks
// ============================================================================

const BATCH_RUNS = [
  // Aug 13 — the voice driver's rollout day (2 batches)
  { id: 'b1', createdAt: '2026-08-13T02:40:56Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b2', createdAt: '2026-08-13T11:20:28Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  // Aug 17 — the scheduled weekly batch
  { id: 'b3', createdAt: '2026-08-17T06:55:55Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  // Aug 18 — manual 6/6, then the 5/6 burst (run 1/6 launch 503 → no
  // verdict, excluded), then TEN 6/6 runs through 13:49.
  { id: 'b4', createdAt: '2026-08-18T12:48:30Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b5', createdAt: '2026-08-18T13:02:18Z', conclusion: 'failure', batch: { passes: 5, checks: 6, drops: 0 } },
  { id: 'b6', createdAt: '2026-08-18T13:02:59Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b7', createdAt: '2026-08-18T13:11:03Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b8', createdAt: '2026-08-18T13:15:36Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b9', createdAt: '2026-08-18T13:20:22Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b10', createdAt: '2026-08-18T13:25:13Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b11', createdAt: '2026-08-18T13:30:02Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b12', createdAt: '2026-08-18T13:34:33Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b13', createdAt: '2026-08-18T13:39:25Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b14', createdAt: '2026-08-18T13:44:16Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  { id: 'b15', createdAt: '2026-08-18T13:49:02Z', conclusion: 'success', batch: { passes: 6, checks: 6, drops: 0 } },
  // Cancelled runs (the 8 interleaved dispatches) must be excluded: null batch.
  { id: 'bx1', createdAt: '2026-08-18T13:02:22Z', conclusion: 'cancelled', batch: null },
  { id: 'bx2', createdAt: '2026-08-18T13:02:27Z', conclusion: 'cancelled', batch: null },
];

type VoiceStageKind = 'clean' | 'voice-red' | 'red-other' | 'skipped' | 'cancelled';
const VOICE_STAGES: Array<{ id: string; createdAt: string; kind: VoiceStageKind }> = [
  { id: 'v1', createdAt: '2026-08-13T14:37:38Z', kind: 'voice-red' },
  { id: 'v2', createdAt: '2026-08-13T15:49:46Z', kind: 'voice-red' },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `v13-${i}`,
    createdAt: `2026-08-13T1${i}:00:00Z`,
    kind: 'clean' as const,
  })),
  // Aug 14: 20 clean + 2 skipped + 2 cancelled
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `v14-${i}`,
    createdAt: `2026-08-14T0${i % 10}:00:00Z`,
    kind: 'clean' as const,
  })),
  { id: 'v14s1', createdAt: '2026-08-14T11:25:20Z', kind: 'skipped' },
  { id: 'v14s2', createdAt: '2026-08-14T17:50:57Z', kind: 'skipped' },
  { id: 'v14c1', createdAt: '2026-08-14T00:09:22Z', kind: 'cancelled' },
  { id: 'v14c2', createdAt: '2026-08-14T00:11:02Z', kind: 'cancelled' },
  // Aug 15 + 16: 13 clean each
  ...Array.from({ length: 26 }, (_, i) => ({
    id: `v1516-${i}`,
    createdAt: `2026-08-1${i < 13 ? 5 : 6}T0${i % 13}:00:00Z`,
    kind: 'clean' as const,
  })),
  // Aug 17: 13 clean + 3 red + 1 red-other + 1 cancelled
  ...Array.from({ length: 13 }, (_, i) => ({
    id: `v17-${i}`,
    createdAt: `2026-08-17T0${i}:00:00Z`,
    kind: 'clean' as const,
  })),
  { id: 'v17r1', createdAt: '2026-08-17T13:21:09Z', kind: 'voice-red' },
  { id: 'v17r2', createdAt: '2026-08-17T13:47:52Z', kind: 'voice-red' },
  { id: 'v17r3', createdAt: '2026-08-17T17:38:48Z', kind: 'voice-red' },
  { id: 'v17o1', createdAt: '2026-08-17T23:09:05Z', kind: 'red-other' },
  { id: 'v17c1', createdAt: '2026-08-17T17:29:48Z', kind: 'cancelled' },
  // Aug 18: 6 clean
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `v18-${i}`,
    createdAt: `2026-08-18T0${i + 1}:00:00Z`,
    kind: 'clean' as const,
  })),
  // Runs that predate the voice stage are excluded upstream — the aggregate
  // must tolerate nothing but the five kinds.
];

describe('aggregateMicTrend', () => {
  it('aggregates the verified historical shape into per-day rows and totals', () => {
    const { rows, totals } = aggregateMicTrend(BATCH_RUNS, VOICE_STAGES);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
    ]);
    expect(totals).toMatchObject({
      batches: 15,
      batchChecks: 90,
      batchPasses: 89,
      batchFlakes: 1,
      voiceClean: 77,
      voiceRed: 5,
      voiceOther: 1,
      voiceSkipped: 2,
      voiceCancelled: 3,
      drops: 0,
    });
    // Cancelled batch runs (batch: null) contribute nothing.
    const aug18 = rows.find((r) => r.date === '2026-08-18');
    expect(aug18).toMatchObject({ batches: 12, batchChecks: 72, batchPasses: 71, batchFlakes: 1 });
    const aug17 = rows.find((r) => r.date === '2026-08-17');
    expect(aug17).toMatchObject({ voiceClean: 13, voiceRed: 3, voiceOther: 1, voiceCancelled: 1 });
  });

  it('counts voice drops and batch drops into the same drops column', () => {
    const { rows, totals } = aggregateMicTrend(
      [{ id: 'x', createdAt: '2026-08-20T00:00:00Z', conclusion: 'failure', batch: { passes: 5, checks: 6, drops: 1 } }],
      [{ id: 'y', createdAt: '2026-08-20T01:00:00Z', kind: 'voice-red', drops: 2 }],
    );
    expect(rows[0]).toMatchObject({ drops: 3 });
    expect(totals.drops).toBe(3);
  });

  it('renders no rows at all for an empty window (the CLI aborts upstream)', () => {
    const { rows, totals } = aggregateMicTrend([], []);
    expect(rows).toEqual([]);
    expect(totals).toMatchObject({ batchChecks: 0, voiceClean: 0, drops: 0 });
  });
});

describe('probability math', () => {
  it('computes the pre-fix drop-free probability exactly', () => {
    // (2/3)^6 ≈ 0.0878 — a single weekly batch only had ~9% chance of all
    // green at the pre-fix 33% rate.
    expect(dropFreeProbability(6)).toBeCloseTo(Math.pow(2 / 3, 6), 12);
    expect(dropFreeProbability(166)).toBeCloseTo(Math.pow(2 / 3, 166), 12);
  });

  it('maps probabilities to human exponents (161 → 28, 166 → 29)', () => {
    expect(probabilityExponent(dropFreeProbability(161))).toBe(28);
    expect(probabilityExponent(dropFreeProbability(166))).toBe(29);
    expect(probabilityExponent(dropFreeProbability(6))).toBe(1);
  });

  it('documents the pre-fix drop rate constant', () => {
    expect(PRE_FIX_DROP_RATE).toBe('33%');
    expect(FIX_WINDOW_START).toBe('2026-08-13');
  });

  it('records the pre-CI local measurements — 4 drops pre-fix, 28/28 post-fix', () => {
    expect(PRE_CI_LOCAL).toHaveLength(2);
    expect(PRE_CI_LOCAL[0]).toMatchObject({ label: 'Pre-fix', drops: 4 });
    expect(PRE_CI_LOCAL[0].result).toBe(`${PRE_FIX_DROP_RATE} drop rate`);
    expect(PRE_CI_LOCAL[1]).toMatchObject({ label: 'Post-fix', drops: 0, result: '28/28 clean' });
  });
});

describe('renderReport — the verified historical fixture', () => {
  const { rows, totals } = aggregateMicTrend(BATCH_RUNS, VOICE_STAGES);
  const markdown = renderReport({ generatedAt: '2026-08-18T23:59:00Z', rows, totals });

  it('writes the window end and the confidence-bound verdict', () => {
    expect(markdown).toContain('**As of:** 2026-08-18 (UTC — regenerated by `npm run refresh:mic-trend`)');
    expect(markdown).toContain('**0 drops across 166 clean two-burst checks** (89 batch runs\n+ 77 post-deploy voice stages)');
    expect(markdown).toContain('P(166 consecutive clean) ≈ 10⁻29');
  });

  it('renders every verified table row verbatim', () => {
    expect(markdown).toContain('| 2026-08-13 | **12/12** (2 batches) | 12 clean + 2 red* | 0 | 0 |');
    expect(markdown).toContain('| 2026-08-14 | — | 20 clean (2 skipped†, 2 cancelled) | — | 0 |');
    expect(markdown).toContain('| 2026-08-15 | — | 13 clean | — | 0 |');
    expect(markdown).toContain('| 2026-08-16 | — | 13 clean | — | 0 |');
    expect(markdown).toContain('| 2026-08-17 | **6/6** (weekly) | 13 clean + 3 red‡ + 1 red-other§ (1 cancelled) | 0 | 0 |');
    expect(markdown).toContain(
      '| 2026-08-18 | 6/6 (manual) + **65/66** (11-batch burst: 10×6/6 + 1×5/6¶) | 6 clean | 1 | 0 |',
    );
    expect(markdown).toContain('| **Total** | **89/90** | **77 clean / 82** | **1** | **0** |');
  });

  it('assigns footnote markers sequentially and renders the block', () => {
    expect(markdown).toContain('\\* Aug 13 14:37 + 15:49 — the voice stage');
    expect(markdown).toContain('\\† verify:live skipped when emulator-compare gated');
    expect(markdown).toContain('\\‡ voice driver red at the dictation/LISTENING stage');
    expect(markdown).toContain('\\§ voice stage passed (Aug 17 23:09)');
    expect(markdown).toContain('\\¶ batch run 1/6 (13:02) failed with a cold-start launch 503');
  });

  it('does not double the marker on the overridden Aug 18 batch cell', () => {
    // The override carries its own ¶ in the text; the generic marker suffix
    // must NOT be appended again (the old bug produced "…1×5/6¶) (¶)").
    expect(markdown).not.toContain('1×5/6¶) (¶)');
    expect(markdown).not.toContain('(weekly))');
  });

  it('visualizes the pre-CI local measurements in the Caveats, marked as local', () => {
    expect(markdown).toContain('  | Local measurement (pre-CI) | Window | Drops | Result |');
    expect(markdown).toContain('  | Pre-fix | before `6683aab` | 4 | **33% drop rate** |');
    expect(markdown).toContain('  | Post-fix | Aug 12, before CI | 0 | 28/28 clean |');
    // The 33% "before" is presented next to the CI "after" (0 drops / 166).
    expect(markdown).toContain('pre-fix row is the "before" against the CI');
    expect(markdown).toContain('0 drops across 166 clean checks');
  });

  it('tells the reader how to regenerate', () => {
    expect(markdown).toContain('npm run refresh:mic-trend');
    expect(markdown).toContain('mic-trend-weekly.yml');
  });
});

describe('historical footnote overrides stay consistent with the computed numbers', () => {
  it('validates every batchLabel/batchCell override against its day\'s aggregate', () => {
    const { rows } = aggregateMicTrend(BATCH_RUNS, VOICE_STAGES);
    const byDate = new Map(rows.map((r) => [r.date, r]));

    for (const [date, foot] of Object.entries(FOOTNOTES)) {
      const day = byDate.get(date);
      expect(day, `FOOTNOTES day ${date} has no data in the fixture`).toBeDefined();
      if (!day) throw new Error(`FOOTNOTES day ${date} has no data in the fixture`);
      if (foot.batchLabel) {
        // (weekly) etc. — a label with no implied numbers; the day must have
        // a full-pass batch so the label never masks a partial pass.
        expect(day.batchPasses).toBe(day.batchChecks);
        expect(day.batchChecks).toBeGreaterThan(0);
      }
      if (foot.batchCell) {
        // The bespoke cell splits the day (e.g. "6/6 (manual) + **65/66**
        // (11-batch burst…)") — SUM every N/M fraction in the cell and
        // require the implied totals to equal the aggregate for that day, so
        // a bespoke cell can never silently disagree with the data. The
        // parenthetical breakdown ("10×6/6 + 1×5/6") is explanatory prose
        // that repeats the burst numbers — strip it before summing.
        const core = foot.batchCell.replace(/\([^)]*\)/g, '');
        const fractions = [...core.matchAll(/(\d+)\/(\d+)/g)];
        expect(fractions.length, `override for ${date} must contain N/M fractions`).toBeGreaterThan(0);
        let impliedPasses = 0;
        let impliedChecks = 0;
        for (const f of fractions) {
          impliedPasses += Number(f[1]);
          impliedChecks += Number(f[2]);
        }
        expect(impliedPasses).toBe(day.batchPasses);
        expect(impliedChecks).toBe(day.batchChecks);
      }
    }
  });

  it('has footnote text for every day the fixture covers', () => {
    // The historical narrative must survive regeneration: Aug 13/14/17/18 all
    // carry annotations in the fixture, and no orphan footnote exists for a
    // day the data cannot produce.
    for (const date of ['2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18']) {
      expect(FOOTNOTES[date as keyof typeof FOOTNOTES]).toBeDefined();
    }
  });
});

describe('the refresh pipeline wiring', () => {
  it('exposes refresh:mic-trend and the zero-drop gate in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['refresh:mic-trend']).toBe('node scripts/refresh-mic-trend.mjs');
    expect(pkg.scripts['verify:mic-trend-zero']).toBe('node scripts/mic-trend-gate.mjs');
  });

  it('pins the CLI against the same renderer the report uses', () => {
    const cli = readFileSync('scripts/refresh-mic-trend.mjs', 'utf8');
    expect(cli).toContain("import { aggregateMicTrend, buildTrendJson, renderReport, FIX_WINDOW_START } from './mic-trend-render.mjs';");
    expect(cli).toContain("const REPORT = join(ROOT, 'docs', 'mic-regression-trend.md');");
    expect(cli).toContain("const REPORT_JSON = join(ROOT, 'docs', 'mic-regression-trend.json');");
    // A failed gather must never overwrite the report with a stale/empty one.
    expect(cli).toContain("process.exit(1)");
    expect(cli).toContain('writeFileSync(REPORT, markdown)');
    expect(cli).toContain('writeFileSync(REPORT_JSON, json)');
  });

  it('excludes force_stuck_blob drill runs from the batch drop count', () => {
    // A drill run injects the stuck signature on purpose — counting it would
    // corrupt the drop column and the confidence bound with synthetic reds.
    const cli = readFileSync('scripts/refresh-mic-trend.mjs', 'utf8');
    expect(cli).toContain("export const DRILL_MARKER = 'stuck signature injected into the judged blob';");
    expect(cli).toContain('if (log.includes(DRILL_MARKER) || log.includes(FLAKE_DRILL_MARKER)) return null;');
  });

  it('excludes force_flake_streak drill runs from the Infra flakes column', () => {
    // A flake-streak drill injects a synthetic flake on purpose — counting it
    // would pollute the Infra flakes column with rehearsals. The marker is
    // distinct from DRILL_MARKER so each drill is excluded by its own signal.
    const cli = readFileSync('scripts/refresh-mic-trend.mjs', 'utf8');
    expect(cli).toContain("export const FLAKE_DRILL_MARKER = 'drill: flake signature injected into the judged log';");
  });
});

describe('buildTrendJson — the machine-readable twin', () => {
  const { rows, totals } = aggregateMicTrend(BATCH_RUNS, VOICE_STAGES);
  const data = buildTrendJson({ generatedAt: '2026-08-18T23:59:00Z', rows, totals });

  it('round-trips to JSON with the schema version and window', () => {
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.schemaVersion).toBe(1);
    expect(data.generatedAt).toBe('2026-08-18');
    expect(data.windowStart).toBe('2026-08-13');
    expect(data.windowEnd).toBe('2026-08-18');
  });

  it('carries the same per-day rows the report renders', () => {
    expect(data.rows).toEqual(rows);
    expect(data.rows).toHaveLength(6);
    expect(data.rows[0]).toMatchObject({
      date: '2026-08-13', batches: 2, batchChecks: 12, batchPasses: 12, batchFlakes: 0,
      voiceClean: 12, voiceRed: 2, voiceOther: 0, voiceSkipped: 0, voiceCancelled: 0, drops: 0,
    });
  });

  it('strips the markdown-only date:Total from the totals aggregate', () => {
    expect(data.totals).not.toHaveProperty('date');
    expect(data.totals).toMatchObject({
      batches: 15, batchChecks: 90, batchPasses: 89, batchFlakes: 1,
      voiceClean: 77, voiceRed: 5, voiceOther: 1, voiceSkipped: 2, voiceCancelled: 3, drops: 0,
    });
    // The aggregate is the column-wise sum of the per-day rows — a chart or
    // alert can trust it without re-summing.
    expect(data.totals.batches).toBe(rows.reduce((s, r) => s + r.batches, 0));
    expect(data.totals.drops).toBe(rows.reduce((s, r) => s + r.drops, 0));
  });

  it('derives the confidence-bound summary from the aggregate', () => {
    expect(data.summary.cleanChecks).toBe(166);
    expect(data.summary.dropFreeProbability).toBeCloseTo(dropFreeProbability(166), 12);
    expect(data.summary.probabilityExponent).toBe(29);
  });

  it('is deterministic — the timestamp is reduced to the date, never the clock', () => {
    const a = buildTrendJson({ generatedAt: '2026-08-18T01:02:03Z', rows, totals });
    const b = buildTrendJson({ generatedAt: '2026-08-18T23:59:59Z', rows, totals });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('archives each red voice stage with its root failure line', () => {
    const reds = [
      { id: 'r1', date: '2026-08-17', createdAt: '2026-08-17T13:21:09Z', rootFailure: '✗ FAIL: create_recipe → 400 …' },
      { id: 'r2', date: '2026-08-17', createdAt: '2026-08-17T13:47:52Z', rootFailure: '✗ FAIL: create_recipe → 400 …' },
    ];
    const d = buildTrendJson({ generatedAt: '2026-08-18T23:59:00Z', rows, totals, redVoiceStages: reds });
    expect(d.redVoiceStages).toEqual(reds);
    // Absent by default → an empty list, never undefined, so consumers can
    // iterate without a null guard.
    expect(buildTrendJson({ generatedAt: '2026-08-18T23:59:00Z', rows, totals }).redVoiceStages).toEqual([]);
  });
});
