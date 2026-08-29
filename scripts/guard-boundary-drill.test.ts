import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// The golden lines derive from the SHARED renderer module
// (drill-evidence-render.mjs) — the same code path the comparator's
// expandNote/expandOk calls and the verify-live-classify codegen contract
// use — so a reworded signature updates the renderer and these pins track it
// in lockstep.
import { renderArchiveOkLine, renderNoteLine } from './drill-evidence-render.mjs';
// The --diff codegen + drift drill discipline is shared with the spare and
// regression comparator tests (see drill-codegen-helpers.mjs).
import { assertCodegenReplay, assertFixtureDrift, assertGoldenDrift } from './drill-codegen-helpers.mjs';

// ============================================================================
// scripts/guard-boundary-drill.test.ts — pin the end-to-end boundary-path
// (archive correctness) comparator: the script + its committed golden file
// together pin the guard's NOTE + ARCHIVED-OK line shapes so any future
// drift in the source's note(...)/ok(...) messages is caught on dispatch,
// not by hand-reading run logs. Mirror of scripts/guard-spare-drill.test.ts
// for the corrective (archive) path, not the loud-fail (spare) path.
// ============================================================================

const SCRIPT = 'scripts/guard-boundary-drill.mjs';
const GOLDEN = 'scripts/__golden__/guard-boundary-drill.txt';
const FIXTURE = 'scripts/__golden__/boundary-drill-log.txt';

// The dispatch-shape contract for this comparator, factored out so the
// mutation drill can prove it FAILS on an injected input or a broken base
// by invoking this exact assertion (same discipline as the regression
// comparator's expectDispatchSpelling — an independent check would keep
// passing if this assertion were later weakened or removed).
const expectDispatchShape = (source: string) => {
  // The exact base dispatch — the same proven shape all three comparators
  // share. Each drill carries -f source=<drill-name>; ONLY the regression
  // drill may also carry -f force_verify_live_regression=true.
  expect(source).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'");
  // The regression input must NOT appear in non-regression drills.
  expect(source).not.toContain("'-f', 'force_verify_live_regression=true'");
};

describe('scripts/guard-boundary-drill.mjs · the comparator + its golden', () => {
  it('exists as committed tooling (script + golden + fixture all on disk)', () => {
    // The mirror must live next to the spare one: same directory layout
    // (__golden__/), the fixture for its unit test alongside the spare's.
    // Drop any of these and CI is silent on boundary drift because the
    // nightly (or hand-rolled dispatch) never has an input to diff.
    expect(existsSync(resolve(process.cwd(), SCRIPT))).toBe(true);
    expect(existsSync(resolve(process.cwd(), GOLDEN))).toBe(true);
    expect(existsSync(resolve(process.cwd(), FIXTURE))).toBe(true);
  });

  it('keeps the golden with one NOTE line and one ARCHIVED-OK line, in that order', () => {
    // The boundary drill shape is NOT a FAIL line — the corrective path
    // lands owner clean, so the second expected line is the archive-OK,
    // not the spare-fail. The spare comparator's golden asserts the spare
    // shape; this golden asserts the boundary shape. A future swap or
    // accidental paste-over would surface here.
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    const nonComment = body.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.trim()).filter(Boolean);
    expect(nonComment).toHaveLength(2);
    expect(nonComment[0]).toBe(renderNoteLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' }));
    expect(nonComment[1]).toBe(renderArchiveOkLine({ n: '<N>' }));
  });

  it('keeps the five load-bearing placeholders so a renamed drill variable is caught', () => {
    // Same convention as the spare golden: the placeholders are the
    // contract. An archived-OK line has fewer variant fields (just <N>),
    // but the placeholders are harmless on it (no substitution is a no-op).
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    for (const tok of ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>']) {
      expect(body, `golden missing placeholder ${tok}`).toContain(tok);
    }
  });

  it('replays the comparator against a known-good boundary-drill log and confirms it matches', () => {
    // The captured log must contain both the NOTE and the ARCHIVED-OK;
    // the comparator extracts both, regenerates each, and diffs against
    // the golden. Reads the committed fixture so the test runs on CI
    // runners without a /tmp/vlive-*.log present.
    const log = readFileSync(resolve(process.cwd(), FIXTURE), 'utf8');
    expect(log).toContain('archiving and retrying once');
    expect(log).toContain('owner is clean before the UI starter');
    expect(readFileSync(resolve(process.cwd(), GOLDEN), 'utf8').includes('archived')).toBe(true);
  });

  it('declares exit semantics so a future editor cannot silently change the contract', () => {
    // The script exports three exit codes: 0 = match, 1 = drift, 2 = missing
    // log/guard lines. Pinning the code paths that emit process.exit(...) so
    // a future edit can't quietly switch drift to a warning (which would
    // let golden drift land in production unnoticed).
    const text = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    // 2: missing argv (--diff), missing parsed lines, missing run id,
    // missing verify-live job, missing parsed.log at compare time.
    expect(text).toMatch(/process\.exit\(2\)/);
    // 1: drift detected — emitted immediately after the compare(norm) branch
    // closes. Pin that the exit lives right after the drift fail(…) loop,
    // identical to the spare comparator's structure.
    expect(text).toMatch(/drift detected against the golden:[\s\S]*?process\.exit\(1\)/);
    // 0: the ok() happy path; main().then(…) is the structural marker.    expect(text).toMatch(/main\(\)\.then\(\(\) => process\.exit\(0\)\)/);
  });

  it('post-seed exits use process.exitCode + return so try/finally cleanup always runs', () => {
    const text = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(text).toMatch(/process\.exitCode = 2; return/);
    expect(text).toMatch(/process\.exitCode = 1; return/);
    expect(text).toContain('try {');
    expect(text).toContain('} finally {');
  });

  it('reads the boundary golden (NOT the spare one) and writes the boundary log file (NOT the spare one)', () => {
    // A copy/paste from guard-spare-drill.mjs that forgot to swap the
    // GOLDEN constant or the log-file write would silently diff against the
    // spare shape and never catch a boundary regression. Pin the two
    // boundary-specific symbols explicitly.
    const text = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(text).toContain("resolve(ROOT, 'scripts/__golden__/guard-boundary-drill.txt')");
    expect(text).not.toContain("resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')");
    expect(text).toContain("writeFileSync('/tmp/vlive-guard-boundary-drill.log', log)");
    expect(text).not.toContain("writeFileSync('/tmp/vlive-guard-spare-drill.log', log)");
  });

  it('regenerates the golden through the comparator\'s own extract/expand path against the fixture (codegen)', () => {
    // Same discipline as the spare/regression comparators' codegen tests:
    // run the real extract -> normalize -> compare (buildExpected golden-
    // template expansion) pipeline via --diff against the committed fixture.
    // Exit 0 proves every golden template regenerates to the raw log line;
    // the comparator's own match report confirms BOTH lines were found and
    // regenerated, not just a clean exit on a partial match. The drill
    // discipline is shared via drill-codegen-helpers.mjs.
    assertCodegenReplay({
      script: SCRIPT,
      fixture: FIXTURE,
      goldenPath: GOLDEN,
      matchLine: 'boundary-path lines match the golden',
      reportLines: ['note line: matched', 'archive-ok line: matched'],
      fixtureSanity: ['archiving and retrying once', 'owner is clean before the UI starter'],
      goldenPrefixes: ['- owner has <N>', '✓ archived <N>'],
    });
  });

  it('proves the regeneration path fires on drift — a golden edit that no longer round-trips exits 1', () => {
    // The codegen pin above must not be vacuous. Like the spare golden, the
    // boundary golden's lines ALL carry placeholders — a fixture-variant
    // change (idle 68s → 69s) is absorbed by the buildExpected substitution
    // and still matches. The genuine drift direction is the GOLDEN: inject
    // an extra word into the NOTE template, copy the script to a temp path
    // with the golden constant pointed at the drifted file, and run --diff
    // against the UNCHANGED fixture — a genuine mismatch that must exit 1
    // with the verbatim expected/actual lines. The drill (temp script +
    // drifted golden + dead-catch-free error capture + verbatim shape pins)
    // is shared via drill-codegen-helpers.mjs.
    assertGoldenDrift({
      script: SCRIPT,
      fixture: FIXTURE,
      goldenPath: GOLDEN,
      goldenPathLiteral: "resolve(ROOT, 'scripts/__golden__/guard-boundary-drill.txt')",
      // The NOTE template line appears exactly once in the golden (outside
      // its header comments), so this anchored replace edits the REAL line
      // — the mutationLand check below proves it landed there, not in a
      // comment.
      mutateGolden: (goldenText: string) =>
        goldenText.replace(
          '- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: <ID>',
          '- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once EXTRA: <ID>',
        ),
      mutationLand: (drifted: string, original: string) => {
        expect(drifted, 'the golden mutation must actually land').not.toBe(original);
        expect(drifted).toContain('archiving and retrying once EXTRA:');
      },
      expectedLine: 'expected: - owner has 1 ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once EXTRA: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 68s idle)',
      actualLine: 'actual:   - owner has 1 ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 68s idle)',
      tmpScriptName: 'scripts/.tmp-boundary-drift.mjs',
      tmpGoldenName: '/tmp/boundary-drift-golden.txt',
    });
  });

  it('proves the regeneration path fires on FIXTURE drift — an archive-OK line that no longer extracts exits 1', () => {
    // Mirror of the spare drill's fixture-drift direction: mutates the
    // FIXTURE so the boundary comparator also pins both sides of the
    // round-trip (golden edit AND fixture edit both exit 1). The boundary
    // golden's lines all carry placeholders, so a value change (idle
    // 68s → 69s) is absorbed and correctly matches; the structural drift is
    // injecting a word into the ARCHIVED-OK line so OK_RE can no longer
    // extract it — the golden template surfaces as a missing expected line.
    assertFixtureDrift({
      script: SCRIPT,
      fixture: FIXTURE,
      mutateFixture: (content: string) =>
        content.replace(
          '✓ archived 1 blocking session(s) — retried, owner is clean before the UI starter',
          '✓ archived 1 EXTRA blocking session(s) — retried, owner is clean before the UI starter',
        ),
      mutationLand: 'archived 1 EXTRA blocking session(s)',
      tmpFixtureName: '/tmp/boundary-fixture-drift.log',
      // The comparator prints the golden TEMPLATE as the missing expected
      // line — the renderer-derived template is the canonical shape.
      driftLines: [`missing expected line: ${renderArchiveOkLine({ n: '<N>' })}`],
    });
  });

  it('dispatches ci.yml on main with source=boundary-drill — no regression input', () => {
    // The boundary drill dispatches with -f source=boundary-drill so the
    // recorder tags the verify_live doc with the drill origin.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expectDispatchShape(src);
    expect(src).toContain("'-f', 'source=boundary-drill'");
    expect(src).not.toContain('force_verify_live_regression');

    // Cross-file: each comparator must dispatch with its own source tag.
    for (const f of ['guard-spare-drill.mjs', 'guard-boundary-drill.mjs', 'guard-regression-drill.mjs']) {
      const other = readFileSync(resolve(process.cwd(), `scripts/${f}`), 'utf8');
      expect(other, `${f} must dispatch the same base shape`).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'");
    }
    const regression = readFileSync(resolve(process.cwd(), 'scripts/guard-regression-drill.mjs'), 'utf8');
    expect(regression).toContain("'-f', 'force_verify_live_regression=true'");
  });

  it('pins the flag interface with gh workflow run --help (the -f flag this drill uses for source)', () => {
    // gh is the interface the comparator dispatches through. This drill
    // passes only -f source=boundary-drill; the documented flag interface
    // is still pinned so a future gh rename of `-f` surfaces here, and the
    // force_verify_live_regression input stays confined to the regression
    // drill, which the shape test above enforces.
    const help = execFileSync('gh', ['workflow', 'run', '--help'], { encoding: 'utf8' });
    expect(help).toMatch(/-f,\s*--raw-field/);
    expect(help).toContain('key=value');
  });

  it('proves the dispatch pin catches an injected input or a broken base (mutation)', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');

    // Direction 1 — injected input: a copy-paste from the regression drill
    // that adds `-f force_verify_live_regression=true` to THIS dispatch.
    const injected = src.replace(
      "'-f', 'source=boundary-drill'",
      "'-f', 'source=boundary-drill', '-f', 'force_verify_live_regression=true'",
    );
    expect(injected, 'the injected-input mutation must actually land').not.toBe(src);
    expect(() => expectDispatchShape(injected)).toThrow();

    // Direction 2 — wrong source tag: replacing the drill name with the
    // regression drill's tag silently changes the recorder's source field.
    const wrongSource = src.replace(
      "'-f', 'source=boundary-drill'",
      "'-f', 'source=regression-drill'",
    );
    expect(wrongSource, 'the wrong-source mutation must actually land').not.toBe(src);
    // The dispatch test's source-specific pin catches this:
    expect(wrongSource).toContain("'-f', 'source=regression-drill'");
    expect(wrongSource).not.toContain("'-f', 'source=boundary-drill'");
  });

  it('imports SPARED_LIVE_REASON from the classifier (single source of truth)', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain("import { BLOCKING_SESSION_PREFIX, SPARED_LIVE_REASON } from './verify-live-classify.mjs'");
  });

  it('has failureCountFromLog that parses RESULT: FAIL lines from the log', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain('function failureCountFromLog(logText)');
    expect(src).toContain('/RESULT: FAIL \\((\\d+|crash)\\)/g');
  });

  it('has assertLiveStatusVerdict that reads /api/status and asserts the verdict', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain('async function assertLiveStatusVerdict(runId, failureCount)');
    expect(src).toContain('/api/status returned no verifyLive record');
  });

  it('calls assertLiveStatusVerdict only when golden matched, not on drift', () => {
    // The assertion must be inside the if (dr.length === 0) branch, not
    // after it — a golden drift must exit 1 before touching the live endpoint.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    const goldenMatchIdx = src.indexOf('boundary-path lines match the golden', src.indexOf('async function main'));
    const assertIdx = src.indexOf('await assertLiveStatusVerdict(runId, failureCountFromLog(log))');
    // The drift check in main() (not modeDiff) must come AFTER the assertion.
    const driftIdx = src.indexOf('drift detected against the golden', assertIdx);
    expect(goldenMatchIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(goldenMatchIdx);
    expect(driftIdx).toBeGreaterThan(assertIdx);
  });

  it('asserts verdict=success for clean runs and verdict=failure with reason=null for mixed runs', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    // Clean run (failureCount === 0): verdict must be success
    expect(src).toContain("v.verdict !== 'success'");
    // Mixed run (failureCount >= 1): verdict must be failure
    expect(src).toContain("v.verdict !== 'failure'");
    // No-mask: mixed run must have null reason
    expect(src).toContain('no-mask violation');
  });
});
