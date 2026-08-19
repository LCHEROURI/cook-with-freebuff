import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFlakeStreakDoc,
  classifyRunFlake,
  extractArtifactBatchFlakeSignatures,
  extractFlakeSignature,
  flakeEscalationVerdict,
  flakeHealedVerdict,
  parseStreakWeeks,
  seedDrillPriorWeeks,
  signatureFromTitle,
  streakWindowStart,
  weekKeyOf,
} from './mic-flake-escalate.mjs';
import { HARD_PHASE_C_OUTCOMES, HARD_SIGNATURES } from './refresh-mic-trend.mjs';

/** Build a downloaded phase-c-runs artifact dir fixture: run-N/driver.log +
 * (optional) run-N/phase-c-summary.json. Returns the base dir (caller cleans). */
function makeBatch(runs: Record<string, { log?: string; summary?: string }>) {
  const base = mkdtempSync(join(tmpdir(), 'mic-flake-test-'));
  for (const [name, files] of Object.entries(runs)) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    if (files.log !== undefined) writeFileSync(join(dir, 'driver.log'), files.log);
    if (files.summary !== undefined) writeFileSync(join(dir, 'phase-c-summary.json'), files.summary);
  }
  return base;
}

// ============================================================================
// scripts/mic-flake-escalate.test.ts — lock the "same flake 3 weeks running"
// escalation that stops a persistent infra flake from being forgiven forever.
//
// The weekly batch forgives a transient flake (e.g. launch 503) up to the
// flake budget, so a single infra hiccup never opens a false-positive issue.
// But the SAME flake within budget every week is a persistent outage, not a
// transient — the escalation must fire when one signature appears in the
// current week AND in each of the two most recent prior weeks, even though no
// single week exceeded budget. The signature normalization (HTTP route →
// status, excluding the volatile JSON body) is what makes the week-to-week
// match stable.
// ============================================================================

describe('extractFlakeSignature · stable week-over-week keys', () => {
  it('collapses an HTTP route failure to `name → status`, dropping the volatile body', () => {
    expect(extractFlakeSignature('✗ FAIL: launch → 503 {"error":"boom","sessionId":"abc123"}')).toBe('launch → 503');
  });

  it('keeps a space-containing route intact', () => {
    expect(extractFlakeSignature('✗ FAIL: vision scan → 503 {"error":"x"}')).toBe('vision scan → 503');
  });

  it('falls back to a collapsed, bounded message for non-HTTP flakes', () => {
    expect(extractFlakeSignature('✗ FAIL:   starter   not   shown. Page text: lots of page text here')).toBe(
      'starter not shown. Page text: lots of page text here',
    );
  });

  it('bounds the fallback so a long volatile tail cannot fragment the match', () => {
    const sig = extractFlakeSignature(`✗ FAIL: ${'x'.repeat(300)}`);
    expect(sig).toHaveLength(120);
  });

  it('uses the FIRST ✗ FAIL: line as the root (not a downstream cascade)', () => {
    const log = '✗ FAIL: launch → 503 {"a":1}\n✗ FAIL: mic not found (cascade)\n';
    expect(extractFlakeSignature(log)).toBe('launch → 503');
  });

  it('returns null when the log has no failure line', () => {
    expect(extractFlakeSignature('all clean\nRESULT: PASS\n')).toBeNull();
  });
});

describe('classifyRunFlake · one artifact run dir (structured record)', () => {
  it('a passing run is not a flake (RESULT: PASS)', () => {
    expect(classifyRunFlake({ log: 'RESULT: PASS', summary: '{"outcome":"pass"}' })).toBeNull();
  });

  it('a structured hard outcome is never a flake, even with a non-route fail line', () => {
    expect(classifyRunFlake({ log: '✗ FAIL: some non-route message', summary: '{"outcome":"latency"}' })).toBeNull();
    expect(classifyRunFlake({ log: '✗ FAIL: some non-route message', summary: '{"outcome":"stuck"}' })).toBeNull();
  });

  it('a hard signature with no summary (crash before the write) is never a flake', () => {
    expect(classifyRunFlake({ log: '✗ FAIL: passing run but the blob reports a stuck queue', summary: null })).toBeNull();
  });

  it('a pre-mic flake (no summary) yields its signature', () => {
    expect(classifyRunFlake({ log: '✗ FAIL: launch → 503 {"x":1}', summary: null })).toBe('launch → 503');
  });

  it('a corrupt summary falls through to the log signals', () => {
    expect(classifyRunFlake({ log: '✗ FAIL: launch → 503 {"x":1}', summary: 'not-json' })).toBe('launch → 503');
  });

  it('a pass outcome with no fail line is not a flake', () => {
    expect(classifyRunFlake({ log: 'all clean', summary: '{"outcome":"pass"}' })).toBeNull();
  });
});

describe('classifyRunFlake order · contract with the batch step shell block', () => {
  // Faithful JS mirror of the batch step's per-run shell block, so the SAME
  // adversarial fixtures can run through BOTH implementations and be required
  // to agree. The shell's `if node …; then` is the driver's exit code, and
  // the driver prints `RESULT: PASS` exactly when it exits 0 — so the
  // /RESULT: PASS/ proxy is the same signal. `summary` is the
  // phase-c-summary.json TEXT (the shell's `[ -f "$summary" ]` file check is
  // `summary != null` here), and the shell greps the PRETTY-PRINTED text the
  // driver writes (`JSON.stringify(summary, null, 2)` → `"outcome": "stuck"`).
  function batchShellFlakeSignature({ log, summary }: { log: string; summary: string | null }) {
    if (/RESULT: PASS/.test(log)) return null; // 1. pass (exit 0)
    if (summary != null) {
      const m = /"outcome": "([^"]*)"/.exec(summary);
      if (m && HARD_PHASE_C_OUTCOMES.includes(m[1])) return null; // 2. structured hard outcome
    }
    if (HARD_SIGNATURES.some((s) => log.includes(s))) return null; // 3. hard-signature log grep
    return extractFlakeSignature(log); // 4. else → flake
  }

  // Each fixture deliberately overlaps two signals so a REORDERED branch would
  // change the verdict: pass beats a hard summary, a structured hard beats a
  // flake-looking line, a non-hard/corrupt summary falls through to the log
  // grep, and a missing summary + hard signature is still never a flake.
  const CASES: Array<{ name: string; log: string; summary: string | null }> = [
    { name: 'RESULT: PASS beats a hard summary', log: 'RESULT: PASS', summary: '{\n  "outcome": "stuck"\n}' },
    { name: 'a structured hard outcome is never a flake', log: '✗ FAIL: some non-route message', summary: '{\n  "outcome": "latency"\n}' },
    { name: 'a pass outcome falls through to the hard-signature log grep', log: '✗ FAIL: the blob reports a stuck queue', summary: '{\n  "outcome": "pass"\n}' },
    { name: 'a corrupt summary falls through to the hard-signature log grep', log: '✗ FAIL: reports a stuck queue', summary: 'not-json' },
    { name: 'a hard signature with no summary is never a flake (crash before the write)', log: '✗ FAIL: second reply never drained', summary: null },
    { name: 'a pre-mic flake yields its signature', log: '✗ FAIL: launch → 503 {"x":1}', summary: null },
  ];

  it('agrees with the batch shell block on every adversarial fixture (order, not just membership)', () => {
    for (const c of CASES) {
      expect(classifyRunFlake({ log: c.log, summary: c.summary }), c.name).toBe(batchShellFlakeSignature(c));
    }
  });

  it('pins the shell block branch order: pass → summary hard → log-grep hard → flake', () => {
    const workflow = readFileSync('.github/workflows/mic-regression.yml', 'utf8');
    const loop = workflow.slice(workflow.indexOf('for i in 1 2 3 4 5 6'), workflow.indexOf('flake_budget='));
    const passAt = loop.indexOf('if node scripts/drive-live-voice.mjs');
    const summaryAt = loop.indexOf('elif [ -f "$summary" ]');
    const logGrepAt = loop.indexOf('elif grep -qE "${hard_signatures}"');
    const flakeAt = loop.indexOf('flake_failed="$flake_failed $i"');
    expect(passAt, 'pass branch missing').toBeGreaterThanOrEqual(0);
    expect(summaryAt, 'summary elif missing').toBeGreaterThanOrEqual(0);
    expect(logGrepAt, 'log-grep elif missing').toBeGreaterThanOrEqual(0);
    expect(flakeAt, 'flake else branch missing').toBeGreaterThanOrEqual(0);
    expect(passAt).toBeLessThan(summaryAt);
    expect(summaryAt).toBeLessThan(logGrepAt);
    expect(logGrepAt).toBeLessThan(flakeAt);
  });

  it('pins classifyRunFlake check order to the same sequence', () => {
    const src = readFileSync('scripts/mic-flake-escalate.mjs', 'utf8');
    const body = src.slice(src.indexOf('export function classifyRunFlake'), src.indexOf('export function extractArtifactBatchFlakeSignatures'));
    const passAt = body.indexOf('/RESULT: PASS/');
    const summaryAt = body.indexOf('HARD_PHASE_C_OUTCOMES.includes(outcome)');
    const logGrepAt = body.indexOf('HARD_SIGNATURES.some');
    const flakeAt = body.indexOf('return extractFlakeSignature(log)');
    expect(passAt).toBeGreaterThanOrEqual(0);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(logGrepAt).toBeGreaterThanOrEqual(0);
    expect(flakeAt).toBeGreaterThanOrEqual(0);
    expect(passAt).toBeLessThan(summaryAt);
    expect(summaryAt).toBeLessThan(logGrepAt);
    expect(logGrepAt).toBeLessThan(flakeAt);
  });
});

describe('extractArtifactBatchFlakeSignatures · the downloaded phase-c-runs artifact', () => {
  it('collects flakes across runs, skipping passes and hard failures', () => {
    const base = makeBatch({
      'run-1': { log: '✗ FAIL: launch → 503 {"x":1}' },
      'run-2': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-3': { log: '✗ FAIL: reports a stuck queue', summary: '{"outcome":"stuck"}' },
      'run-4': { log: '✗ FAIL: launch → 503 {"x":2}' },
      'run-5': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-6': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
    });
    try {
      expect(extractArtifactBatchFlakeSignatures(base)).toEqual({ drill: false, signatures: ['launch → 503'] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('excludes a whole drill batch (force_stuck_blob / force_flake_streak markers)', () => {
    const base = makeBatch({
      'run-1': { log: 'drill: flake signature injected into the judged log (--force-flake-streak)\n✗ FAIL: drill-flake → 503' },
      'run-2': { log: 'RESULT: PASS' },
    });
    try {
      expect(extractArtifactBatchFlakeSignatures(base)).toEqual({ drill: true, signatures: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('skips a run whose driver.log never landed (no crash, no verdict)', () => {
    const base = makeBatch({
      'run-1': { log: '✗ FAIL: launch → 503 {"x":1}' },
      // run-2 omitted entirely
      'run-3': { log: '✗ FAIL: vision scan → 500 {"x":1}' },
    });
    try {
      expect(extractArtifactBatchFlakeSignatures(base)).toEqual({
        drill: false,
        signatures: ['launch → 503', 'vision scan → 500'],
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns an empty set for an all-green batch', () => {
    const base = makeBatch({
      'run-1': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-2': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-3': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-4': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-5': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
      'run-6': { log: 'RESULT: PASS', summary: '{"outcome":"pass"}' },
    });
    try {
      expect(extractArtifactBatchFlakeSignatures(base)).toEqual({ drill: false, signatures: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('flakeEscalationVerdict · the 3-week streak', () => {
  const wk = (date: string, signatures: string[]) => ({ date, signatures });

  it('escalates when one signature appears in the current + 2 prior weeks', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(true);
    expect(v.signature).toBe('launch → 503');
    expect(v.dates).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('does not escalate with fewer than two prior weeks of history', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(false);
  });

  it('does not escalate when the streak broke (a clean week in between)', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', [])],
    });
    expect(v.escalate).toBe(false);
  });

  it('does not escalate a DIFFERENT flake each week', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['mic not found']), wk('2026-08-10', ['launch → 500'])],
    });
    expect(v.escalate).toBe(false);
  });

  it('escalates on the first signature that actually appears in the prior weeks', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 502', 'launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(true);
    expect(v.signature).toBe('launch → 503');
  });
});

describe('seedDrillPriorWeeks · the escalation drill seeds a 3-week streak in one dispatch', () => {
  it('seeds the two prior Mondays carrying the same signature, oldest first', () => {
    expect(seedDrillPriorWeeks('2026-08-17', 'drill-flake → 503')).toEqual([
      { date: '2026-08-03', signatures: ['drill-flake → 503'] },
      { date: '2026-08-10', signatures: ['drill-flake → 503'] },
    ]);
  });

  it('feeds the REAL verdict so the streak escalates end-to-end', () => {
    const v = flakeEscalationVerdict({
      current: { date: '2026-08-17', signatures: ['drill-flake → 503'] },
      previous: seedDrillPriorWeeks('2026-08-17', 'drill-flake → 503'),
    });
    expect(v.escalate).toBe(true);
    expect(v.signature).toBe('drill-flake → 503');
    expect(v.dates).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('crosses month boundaries without drifting the Monday anchor', () => {
    expect(seedDrillPriorWeeks('2026-08-03', 'launch → 503')).toEqual([
      { date: '2026-07-20', signatures: ['launch → 503'] },
      { date: '2026-07-27', signatures: ['launch → 503'] },
    ]);
  });
});

describe('signatureFromTitle · parsing the escalation issue title', () => {
  it('extracts the signature from the created title', () => {
    expect(signatureFromTitle('Mic regression: same flake “launch → 503” 3 weeks running')).toBe('launch → 503');
  });

  it('returns null for an edited/unrecognized title (left open, not mis-closed)', () => {
    expect(signatureFromTitle('Some edited title without the shape')).toBeNull();
    expect(signatureFromTitle('')).toBeNull();
  });
});

describe('flakeHealedVerdict · a subsequent week shows the flake gone', () => {
  const cur = (signatures: string[]) => ({ date: '2026-08-24', signatures });

  it('heals when the signature is absent from the current week', () => {
    expect(flakeHealedVerdict({ signature: 'launch → 503', current: cur([]) })).toBe(true);
    expect(flakeHealedVerdict({ signature: 'launch → 503', current: cur(['vision scan → 502']) })).toBe(true);
  });

  it('does NOT heal when the flake is still present this week', () => {
    expect(flakeHealedVerdict({ signature: 'launch → 503', current: cur(['launch → 503']) })).toBe(false);
  });
});

describe('wiring · the escalation issue is created and auto-closed end to end', () => {
  const script = readFileSync('scripts/mic-flake-escalate.mjs', 'utf8');

  it('creates the issue with the exact title shape signatureFromTitle parses', () => {
    expect(script).toContain('same flake “${verdict.signature}” 3 weeks running');
    expect(script).toContain('export function signatureFromTitle');
  });

  it('auto-closes healed issues on green weeks, never during a drill', () => {
    expect(script).toContain('async function autoCloseHealedIssues(current)');
    expect(script).toContain("'--json', 'number,title'");
    expect(script).toContain('if (!drillStreak) {');
    expect(script).toContain('await autoCloseHealedIssues(current)');
    expect(script).toContain("['issue', 'close'");
  });
});

describe('parseStreakWeeks · the escalation body carries the streak dates', () => {
  it('parses the three streak Mondays from the body line', () => {
    const body = '- **Flake:** `launch → 503`\n- **Weeks:** 2026-08-03 → 2026-08-10 → 2026-08-17\n- **Run:** https://…';
    expect(parseStreakWeeks(body)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('returns [] when the body has no Weeks line (edited/unrecognized)', () => {
    expect(parseStreakWeeks('some body without the line')).toEqual([]);
    expect(parseStreakWeeks('')).toEqual([]);
  });
});

describe('buildFlakeStreakDoc · the /status page doc reflects open issues', () => {
  const runUrl = 'https://github.com/LCHEROURI/cook-with-freebuff/actions/runs/1';

  it('reports an active streak from the open issue title + body', () => {
    const doc = buildFlakeStreakDoc({
      openIssues: [
        {
          title: 'Mic regression: same flake “launch → 503” 3 weeks running',
          body: '- **Weeks:** 2026-08-03 → 2026-08-10 → 2026-08-17',
        },
      ],
      ranAt: '2026-08-17T00:00:00Z',
      runUrl,
    });
    expect(doc.active).toBe(true);
    expect(doc.recurringCount).toBe(1);
    expect(doc.signature).toBe('launch → 503');
    expect(doc.weeks).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
    expect(doc.ranAt).toBe('2026-08-17T00:00:00Z');
  });

  it('reports no streak when no escalation issue is open', () => {
    const doc = buildFlakeStreakDoc({ openIssues: [], ranAt: '2026-08-17T00:00:00Z', runUrl });
    expect(doc.active).toBe(false);
    expect(doc.recurringCount).toBe(0);
    expect(doc.signature).toBeNull();
    expect(doc.weeks).toEqual([]);
  });

  it('treats an unrecognized title as active-but-unknown rather than fabricated', () => {
    const doc = buildFlakeStreakDoc({ openIssues: [{ title: 'Edited title', body: '' }], ranAt: 'x', runUrl });
    expect(doc.active).toBe(true);
    expect(doc.recurringCount).toBe(1);
    expect(doc.signature).toBeNull();
  });
});

describe('wiring · the flake-streak state reaches the /status page', () => {
  const script = readFileSync('scripts/mic-flake-escalate.mjs', 'utf8');

  it('records the active streak to deploy_status/flake_streak with the admin SDK', () => {
    expect(script).toContain("collection('deploy_status').doc('flake_streak')");
    expect(script).toContain('buildFlakeStreakDoc');
    expect(script).toContain("'--json', 'number,title,body'");
    expect(script).toContain("import('firebase-admin/app')");
    expect(script).toContain('FIREBASE_SERVICE_ACCOUNT missing — skipping the flake-streak status write');
  });

  it('never records a drill synthetic streak (gated off --drill-streak)', () => {
    expect(script).toContain('if (!drillStreak) {');
    expect(script).toContain('await recordFlakeStreakToFirestore()');
  });
});

describe('wiring · prior weeks classify from the uploaded artifact', () => {
  const script = readFileSync('scripts/mic-flake-escalate.mjs', 'utf8');

  it('downloads the phase-c-runs artifact instead of grepping the workflow log', () => {
    expect(script).toContain("'download'");
    expect(script).toContain("'--name'");
    expect(script).toContain("'phase-c-runs'");
    expect(script).toContain("'--dir'");
    expect(script).toContain('extractArtifactBatchFlakeSignatures(dest)');
    // The old whole-workflow-log grep is gone.
    expect(script).not.toContain("'run', 'view'");
    expect(script).not.toContain('extractBatchFlakeSignatures(log)');
  });

  it('skips a run whose artifact is unavailable (expired / self-cleaned drill)', () => {
    expect(script).toContain('async function downloadBatchArtifact');
    expect(script).toContain('if (!(await downloadBatchArtifact(r.databaseId, dest))) continue;');
    expect(script).toContain('phase-c-runs artifact unavailable');
  });

  it('limits the gather to the streak window so it never downloads ancient or irrelevant artifacts', () => {
    // The verdict reads only previous.slice(-2), so the run list is filtered
    // to [currentMonday-14, currentMonday) BEFORE any `gh run download` — a run
    // outside that window cannot be part of a contiguous 3-week streak.
    expect(script).toContain('streakWindowStart(current.date)');
    expect(script).toContain('return key && key >= streakStart && key < current.date;');
    // The filter runs on the list result, before the per-run download loop.
    const filterAt = script.indexOf('return key && key >= streakStart');
    const downloadAt = script.indexOf('downloadBatchArtifact(r.databaseId, dest)');
    expect(filterAt).toBeGreaterThanOrEqual(0);
    expect(downloadAt).toBeGreaterThan(filterAt);
  });
});

describe('streakWindowStart · the prior-week gather window', () => {
  it('is the Monday two weeks before the current Monday', () => {
    expect(streakWindowStart('2026-08-17')).toBe('2026-08-03');
  });

  it('crosses a month boundary without drifting the Monday anchor', () => {
    expect(streakWindowStart('2026-08-03')).toBe('2026-07-20');
  });

  it('crosses a year boundary', () => {
    expect(streakWindowStart('2026-01-05')).toBe('2025-12-22');
  });
});

describe('weekKeyOf · Monday anchors the streak week', () => {
  it('maps a Monday to itself', () => {
    expect(weekKeyOf('2026-08-17T06:00:00Z')).toBe('2026-08-17'); // Mon
  });

  it('rolls a Sunday back to the Monday of that week', () => {
    expect(weekKeyOf('2026-08-16T23:59:00Z')).toBe('2026-08-10'); // Sun → Mon
  });

  it('returns null for an unparseable timestamp', () => {
    expect(weekKeyOf('not-a-date')).toBeNull();
  });
});
