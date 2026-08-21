import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BLOCKING_SESSION_PREFIX, SPARED_LIVE_SESSION_SIGNATURE } from './verify-live-classify.mjs';
import {
  renderNoteLine,
  renderResultLine,
  renderSeamFailLine,
  renderSpareFailLine,
} from './drill-evidence-render.mjs';
// The --diff codegen + drift drill discipline is shared with the spare and
// boundary comparator tests (see drill-codegen-helpers.mjs).
import { assertCodegenReplay, assertFixtureDrift, assertGoldenDrift } from './drill-codegen-helpers.mjs';

// ============================================================================
// scripts/guard-regression-drill.test.ts — pin the end-to-end spare +
// SIMULATED regression comparator (the no-mask proof): the script + its
// committed golden file together pin the four evidence lines (NOTE, spare
// FAIL, seam FAIL, RESULT count) so any future drift in the source's
// fail(...) messages OR the seam's SIMULATED message is caught on dispatch.
// Mirror of guard-spare-drill.test.ts / guard-boundary-drill.test.ts for the
// two-failure drill that must record reason=null.
// ============================================================================

const SCRIPT = 'scripts/guard-regression-drill.mjs';
const GOLDEN = 'scripts/__golden__/guard-regression-drill.txt';
const FIXTURE = 'scripts/__golden__/regression-drill-log.txt';
// The seam + RESULT lines derive from the SHARED renderer module
// (drill-evidence-render.mjs) — the same code path the regression
// comparator's regenerate step calls and the verify-live-classify codegen
// contract uses — so a reworded message updates the renderer and this golden
// pin tracks it in lockstep.
const SEAM_LINE = renderSeamFailLine();
const RESULT_LINE = renderResultLine(2);

// The dispatch-spelling contract for the regression drill, factored out so
// the mutation drill below can prove it FAILS on a dropped input or swapped
// flag by invoking this exact assertion (same discipline as the string-input
// and env-threading drills — an independent check would keep passing if this
// assertion were later weakened or removed).
const expectDispatchSpelling = (source: string) => {
  // The EXACT dispatch array. `-f` is the short flag gh documents for
  // `workflow run` key=value parameters (help: `-f, --raw-field key=value`),
  // and the input rides as ONE `-f key=value` token. The live third drill
  // (32429029312) proved this exact spelling propagates
  // FORCE_VERIFY_LIVE_REGRESSION=true end to end.
  expect(source).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'force_verify_live_regression=true'])");
  // Wrong spellings that would silently change dispatch semantics:
  expect(source).not.toContain("'-F', 'force_verify_live_regression=true'");
  expect(source).not.toMatch(/'--field',\s*'force_verify_live_regression/);
  expect(source).not.toMatch(/'--raw-field',\s*'force_verify_live_regression/);
  // The value must ride in the same token — a split would make `true` a
  // positional arg instead of the input's value.
  expect(source).not.toContain("'-f', 'force_verify_live_regression', 'true'");
};

describe('scripts/guard-regression-drill.mjs · the comparator + its golden', () => {
  it('exists as committed tooling (script + golden + fixture all on disk)', () => {
    // The third comparator must live next to the spare and boundary ones —
    // same directory layout, fixture alongside. Drop any of these and CI is
    // silent on a no-mask drift because the weekly never has an input to diff.
    expect(existsSync(resolve(process.cwd(), SCRIPT))).toBe(true);
    expect(existsSync(resolve(process.cwd(), GOLDEN))).toBe(true);
    expect(existsSync(resolve(process.cwd(), FIXTURE))).toBe(true);
  });

  it('keeps the golden with NOTE, spare-FAIL, seam-FAIL, and RESULT lines in order', () => {
    // The regression drill shape is the two-failure evidence: the guard's
    // NOTE + spare FAIL (same as the spare golden), then the seam's
    // SIMULATED regression FAIL, then the RESULT count proving exactly two
    // failures. Any reorder, paste-over, or count change surfaces here.
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    const nonComment = body.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.trim()).filter(Boolean);
    expect(nonComment).toHaveLength(4);
    expect(nonComment[0]).toBe(renderNoteLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' }));
    expect(nonComment[1]).toBe(renderSpareFailLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' }));
    expect(nonComment[2]).toBe(SEAM_LINE);
    expect(nonComment[3]).toBe(RESULT_LINE);
  });

  it('keeps the regression-drill-log.txt fixture lines equal to the source-derived renderer templates', () => {
    // The fixture is the comparator's --diff input, so it must equal EXACTLY
    // what verify-live.mjs's producers emit (through the shared renderer
    // module) — never a hand-edited copy that drifted from the guard's
    // messages. Each non-comment fixture line is re-derived from
    // renderNoteLine/renderSpareFailLine/renderSeamFailLine/renderResultLine
    // with the concrete drill values captured from live run 32429029312, so
    // a reworded guard message (or a stale fixture) fails here in lockstep
    // with the golden and the comparator's regex extraction.
    const fixture = readFileSync(resolve(process.cwd(), FIXTURE), 'utf8');
    const lines = fixture.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.trim()).filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(renderNoteLine({
      n: '1', id: 'drill-li', phase: 'COLLECTING_INGREDIENTS', recipe: 'chicken_rice_onion_001', idle: '12',
    }));
    expect(lines[1]).toBe(renderSpareFailLine({
      n: '1', id: 'drill-li', phase: 'COLLECTING_INGREDIENTS', recipe: 'chicken_rice_onion_001', idle: '13',
    }));
    expect(lines[2]).toBe(SEAM_LINE);
    expect(lines[3]).toBe(RESULT_LINE);
  });

  it('keeps the five load-bearing placeholders AND the fully-static seam + count lines', () => {
    // The first two lines carry the drill-run-variant placeholders (same
    // convention as the spare golden). The seam line and the RESULT count
    // are FULLY static — a reworded seam message or a third failure changes
    // them and the comparator's regex/diff catches it.
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    for (const tok of ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>']) {
      expect(body, `golden missing placeholder ${tok}`).toContain(tok);
    }
    expect(body).toContain(SEAM_LINE);
    expect(body).toContain(RESULT_LINE);
  });

  it('regenerates the golden through the comparator\'s own extract/expand path against the fixture (codegen)', () => {
    // The golden derivation must come from the comparator's REGENERATION
    // path, not just the constants: the comparator extracts the four
    // evidence lines from the log (extractLines), normalizes them
    // (normalizedLines), and diffs each regenerated line against the golden
    // template via buildExpected(golden, groups) (compare). Shelling out
    // with --diff runs that exact pipeline against the committed fixture —
    // exit 0 proves every golden template regenerates to the raw log line.
    // A drift in any regex, a reordered capture group, or a golden edit
    // that no longer round-trips surfaces here as a non-zero exit. The
    // drill discipline is shared with the spare/boundary comparators via
    // drill-codegen-helpers.mjs.
    assertCodegenReplay({
      script: SCRIPT,
      fixture: FIXTURE,
      goldenPath: GOLDEN,
      matchLine: 'regression-path lines match the golden',
      reportLines: ['note line: matched', 'spare-fail line: matched', 'seam-fail line: matched', 'result line: FAIL (2)'],
      fixtureSanity: ['archiving and retrying once', 'after the archive retry', SEAM_LINE, RESULT_LINE],
      goldenPrefixes: ['- owner has <N>', '✗ FAIL: owner still has <N>', SEAM_LINE, RESULT_LINE],
    });
  });

  it('proves the regeneration path fires on drift — a mutated fixture exits 1 with a mismatch report', () => {
    // The codegen pin above must not be vacuous: a golden or regex drift
    // must actually fail the comparison. Mutate ONLY the RESULT count in an
    // in-memory fixture copy (2 -> 3), write it to a temp file, and run the
    // comparator's --diff on it: buildExpected regenerates the golden
    // template (still FAIL (2)) while the mutated line regenerates as FAIL
    // (3) — a genuine mismatch that must exit 1 with the verbatim drift
    // lines. The drill (dead-catch-free error capture + verbatim shape
    // pins) is shared via drill-codegen-helpers.mjs.
    assertFixtureDrift({
      script: SCRIPT,
      fixture: FIXTURE,
      mutateFixture: (content: string) => content.replace('RESULT: FAIL (2)', 'RESULT: FAIL (3)'),
      mutationLand: 'RESULT: FAIL (3)',
      tmpFixtureName: '/tmp/vlive-regression-drift-fixture.log',
      driftLines: ['RESULT: FAIL (2)', 'RESULT: FAIL (3)'],
    });
  });

  it('proves the regeneration path fires on GOLDEN drift — a golden edit exits 1 against the unchanged fixture', () => {
    // The fixture-mutation direction above pins one side of the round-trip
    // (a drifted FIXTURE line is caught); this direction pins the other
    // side (a drifted GOLDEN template is caught against the unchanged
    // fixture). Mutate the RESULT count in a temp COPY of the committed
    // golden (2 -> 9), point a temp script copy at that golden, and run
    // --diff against the UNCHANGED fixture: buildExpected regenerates the
    // drifted template as FAIL (9) while the actual line regenerates as
    // FAIL (2) — a genuine mismatch that must exit 1.
    //
    // The mutation must be ANCHORED to the actual golden line: the golden's
    // header comment also contains "RESULT: FAIL (2)", so a bare replace
    // would edit the comment and leave the real line untouched — the drill
    // would pass vacuously.
    // The anchored golden mutation now lives in assertGoldenDrift's shared
    // mutateGolden/mutationLand discipline (drill-codegen-helpers.mjs): the
    // golden's header comment ALSO contains "RESULT: FAIL (2)", so the
    // replace must be anchored to the real line — the mutationLand check
    // proves the edit landed on that line, never the comment, or the drill
    // passes vacuously.
    assertGoldenDrift({
      script: SCRIPT,
      fixture: FIXTURE,
      goldenPath: GOLDEN,
      goldenPathLiteral: "resolve(ROOT, 'scripts/__golden__/guard-regression-drill.txt')",
      mutateGolden: (goldenText: string) =>
        goldenText.replace(/^RESULT: FAIL \(2\)$/m, 'RESULT: FAIL (9)'),
      mutationLand: (drifted: string, original: string) => {
        expect(drifted, 'the golden mutation must land on the real line').not.toBe(original);
        expect(drifted.split('\n').filter((l) => l.startsWith('RESULT:'))).toEqual(['RESULT: FAIL (9)']);
      },
      expectedLine: 'expected: RESULT: FAIL (9)',
      actualLine: 'actual:   RESULT: FAIL (2)',
      tmpScriptName: 'scripts/.tmp-regression-golden-drift.mjs',
      tmpGoldenName: '/tmp/regression-drift-golden.txt',
    });
  });

  it('proves compare() cannot silently stop firing — both drift directions flip under a weakened comparator (mutation)', () => {
    // The pipeline's drift detection lives entirely in compare(): a future
    // edit that weakens it (ignores mismatches) would silently stop BOTH
    // drift directions (fixture-drift AND golden-drift), and one that
    // always reports drift would break the codegen happy-path. Mirror the
    // spare drill's temp-script pattern: apply each mutation to a copy of
    // the REAL script and confirm it FLIPS the pinned exit codes that the
    // drift + codegen tests assert — proving both pins go red against the
    // mutation, i.e. neither is vacuous.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    const fixture = resolve(process.cwd(), FIXTURE);
    const tmpScript = resolve(process.cwd(), 'scripts/.tmp-regression-compare-mutation.mjs');
    const tmpGolden = resolve('/tmp', 'regression-compare-mutation-golden.txt');
    const tmpFixture = resolve('/tmp', 'regression-compare-mutation-fixture.log');
    const goldenPath = "resolve(ROOT, 'scripts/__golden__/guard-regression-drill.txt')";
    const pointAtTempGolden = (s: string) => s.replace(goldenPath, `'${tmpGolden}'`);

    // Same anchored mutations as the fixture-drift + golden-drift tests:
    // RESULT 2 -> 3 in the fixture, RESULT 2 -> 9 on the golden's REAL
    // line (never the header comment).
    const driftedFixture = readFileSync(fixture, 'utf8').replace('RESULT: FAIL (2)', 'RESULT: FAIL (3)');
    const driftedGolden = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8')
      .replace(/^RESULT: FAIL \(2\)$/m, 'RESULT: FAIL (9)');

    const run = (script: string, log: string): number | null => {
      try {
        execFileSync('node', [script, '--diff', log], { encoding: 'utf8' });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? null;
      }
    };

    try {
      writeFileSync(tmpFixture, driftedFixture);
      writeFileSync(tmpGolden, driftedGolden);

      // Sanity — the UNMUTATED script rejects both drifted inputs (exit 1),
      // exactly the outcomes the fixture-drift and golden-drift tests pin.
      // Without this, Direction 1's "exit 0" below could be the status quo
      // and the mutation would have no footprint to prove.
      writeFileSync(tmpScript, src);
      expect(run(tmpScript, tmpFixture), 'sanity: the unmutated script must reject the drifted fixture').toBe(1);
      writeFileSync(tmpScript, pointAtTempGolden(src));
      expect(run(tmpScript, fixture), 'sanity: the unmutated script must reject the drifted golden').toBe(1);

      // Direction 1 — compare() ignores mismatches (never reports drift):
      // both drifted inputs are now ACCEPTED (exit 0, "match the golden"),
      // flipping BOTH drift tests' pinned exit-1 -> both go red.
      const ignoreMismatches = src.replace(
        /function compare\(actual\) \{[\s\S]*?\n\}/,
        'function compare() {\n  return [];\n}',
      );
      expect(ignoreMismatches, 'the ignore-mismatches mutation must actually land').not.toBe(src);
      writeFileSync(tmpScript, ignoreMismatches);
      const laxFixtureOut = execFileSync('node', [tmpScript, '--diff', tmpFixture], { encoding: 'utf8' });
      expect(laxFixtureOut).toContain('regression-path lines match the golden');
      writeFileSync(tmpScript, pointAtTempGolden(ignoreMismatches));
      const laxGoldenOut = execFileSync('node', [tmpScript, '--diff', fixture], { encoding: 'utf8' });
      expect(laxGoldenOut).toContain('regression-path lines match the golden');

      // Direction 2 — compare() reports a mismatch unconditionally: the
      // GOOD fixture is now REJECTED (exit 1), flipping the codegen test's
      // pinned exit-0 -> the codegen test goes red.
      const alwaysFail = src.replace(
        /function compare\(actual\) \{[\s\S]*?\n\}/,
        "function compare() {\n  return [{ kind: 'mismatch', expected: 'x', actual: 'y' }];\n}",
      );
      expect(alwaysFail, 'the always-fail mutation must actually land').not.toBe(src);
      writeFileSync(tmpScript, alwaysFail);
      expect(run(tmpScript, fixture), 'the good fixture must be rejected under always-fail').toBe(1);
    } finally {
      rmSync(tmpScript, { force: true });
      rmSync(tmpGolden, { force: true });
      rmSync(tmpFixture, { force: true });
    }
  });

  it('declares exit semantics so a future editor cannot silently change the contract', () => {
    // 0 = match, 1 = drift, 2 = missing/unparseable. Pinning the exit paths
    // so a regression (say, exiting 0 on drift) fails CI instead of shipping
    // a fallen-over comparator.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toMatch(/main\(\)\.then\(\(\) => process\.exit\(0\)\)/);
    expect(src).toMatch(/drift detected against the golden:[\s\S]*?process\.exit\(1\)/);
    expect(src).toMatch(/process\.exit\(2\)/);
  });

  it('post-seed exits use process.exitCode + return so try/finally cleanup always runs', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toMatch(/process\.exitCode = 2; return/);
    expect(src).toMatch(/process\.exitCode = 1; return/);
    expect(src).toContain('try {');
    expect(src).toContain('} finally {');
  });

  it('dispatches ci.yml WITH force_verify_live_regression=true and discovers the run by listing', () => {
    // The regression drill's dispatch MUST carry the input — without it the
    // seam never fires and the log would only show a lone spare (which the
    // spare comparator already covers). Also mirrors the spare comparator's
    // run-discovery fix (list, don't parse stdout).
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expectDispatchSpelling(src);
    expect(src).toContain('workflow dispatched but the new ci.yml run could not be located');
    expect(src).toContain("'--event', 'workflow_dispatch'");
  });

  it('pins the `-f` spelling against gh workflow run --help (the interface gh documents)', () => {
    // gh is the interface the comparator dispatches through. `workflow run`
    // documents `-f, --raw-field key=value` as a parameter-passing flag —
    // the comparator must keep using exactly this spelling, and a future gh
    // release that renames or drops the short flag surfaces here before it
    // silently breaks the drill's dispatch. (Live proof: run 32429029312
    // recorded FORCE_VERIFY_LIVE_REGRESSION: true with this spelling.)
    const help = execFileSync('gh', ['workflow', 'run', '--help'], { encoding: 'utf8' });
    expect(help).toMatch(/-f,\s*--raw-field/);
    expect(help).toContain('key=value');
  });

  it('proves the dispatch pin catches a dropped input or swapped flag (mutation)', () => {
    // The pin must have discriminating power, not pass vacuously. Mutate
    // ONLY the dispatch array in in-memory copies of the REAL script source
    // (never on disk) and invoke the ACTUAL assertion (expectDispatchSpelling)
    // on each: it must throw. If a future edit weakens or removes the pin,
    // this mutation test goes red with it instead of passing on an
    // independent check.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');

    // Direction 1 — dropped input: the `-f force_verify_live_regression=true`
    // pair is removed, so the seam would never fire.
    const dropped = src.replace(
      ", '-f', 'force_verify_live_regression=true'",
      '',
    );
    expect(dropped, 'the drop mutation must actually land').not.toBe(src);
    expect(() => expectDispatchSpelling(dropped)).toThrow();

    // Direction 2 — swapped flag: `-f` becomes `-F` (the other documented
    // parameter flag with different quoting semantics).
    const swapped = src.replace(
      "'-f', 'force_verify_live_regression=true'",
      "'-F', 'force_verify_live_regression=true'",
    );
    expect(swapped, 'the flag-swap mutation must actually land').not.toBe(src);
    expect(() => expectDispatchSpelling(swapped)).toThrow();

    // Direction 3 — split tokens: the value split into its own token, which
    // gh would read as a positional arg instead of the input's value.
    const split = src.replace(
      "'-f', 'force_verify_live_regression=true'",
      "'-f', 'force_verify_live_regression', 'true'",
    );
    expect(split, 'the split-token mutation must actually land').not.toBe(src);
    expect(() => expectDispatchSpelling(split)).toThrow();
  });

  it('asserts the no-mask record end to end: recorded verdict=failure with NO reason', () => {
    // The log diff pins the two-failure SHAPE; the no-mask PROPERTY is the
    // recorded doc: deploy_status/verify_live must show verdict=failure and
    // no reason. Pin the assertion's load-bearing pieces so a future edit
    // can't silently drop the Firestore read or the reason check.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain("db.collection('deploy_status').doc('verify_live').get()");
    expect(src).toContain('expected recorded verdict');
    expect(src).toContain('no-mask violation: reason');
    expect(src).toContain('no-mask: recorded verdict=failure');
    // The runUrl cross-check keeps the assertion honest: if a concurrent run
    // overwrote the record, fail rather than assert against a stale doc.
    expect(src).toContain('is not the drill run');
  });

  it('reads the regression golden (NOT the spare/boundary ones) and writes the regression log file', () => {
    // A copy/paste that forgot to swap GOLDEN or the log-file write would
    // silently diff against the wrong shape. Pin the three regression-
    // specific symbols explicitly.
    const text = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(text).toContain("resolve(ROOT, 'scripts/__golden__/guard-regression-drill.txt')");
    expect(text).not.toContain("resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')");
    expect(text).not.toContain("resolve(ROOT, 'scripts/__golden__/guard-boundary-drill.txt')");
    expect(text).toContain("writeFileSync('/tmp/vlive-guard-regression-drill.log', log)");
    expect(text).not.toContain("writeFileSync('/tmp/vlive-guard-spare-drill.log', log)");
  });

  it('exercises the /--diff <path> path end to end (returns 0 on the regression fixture)', () => {
    const r = execFileSync('node', [SCRIPT, '--diff', FIXTURE], { encoding: 'utf8' });
    expect(r).toContain('regression-path lines match the golden');
  });
});
