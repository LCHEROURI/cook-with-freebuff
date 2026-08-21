import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  BLOCKING_SESSION_PREFIX,
  SIMULATED_REGRESSION_SIGNATURE,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';

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
// The seam line is derived from the exported constant (single source of
// truth shared with verify-live.mjs's seam and the comparator's regex), so a
// reworded message updates the constant and this golden pin tracks it.
const SEAM_LINE = `✗ FAIL: ${SIMULATED_REGRESSION_SIGNATURE}`;

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
    expect(nonComment[0]).toBe(`- owner has <N> ${BLOCKING_SESSION_PREFIX} — archiving and retrying once: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)`);
    expect(nonComment[1]).toBe(`✗ FAIL: owner still has <N> ${SPARED_LIVE_SESSION_SIGNATURE}: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)`);
    expect(nonComment[2]).toBe(SEAM_LINE);
    expect(nonComment[3]).toBe('RESULT: FAIL (2)');
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
    expect(body).toContain(SIMULATED_REGRESSION_SIGNATURE);
    expect(body).toContain('RESULT: FAIL (2)');
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
    // that no longer round-trips surfaces here as a non-zero exit.
    const fixture = resolve(process.cwd(), FIXTURE);
    const goldenText = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    // Sanity: the fixture carries all four evidence lines (the comparator's
    // own extract step must find them; without them --diff would exit 2).
    const log = readFileSync(fixture, 'utf8');
    expect(log).toContain('archiving and retrying once');
    expect(log).toContain('after the archive retry');
    expect(log).toContain(SIMULATED_REGRESSION_SIGNATURE);
    expect(log).toContain('RESULT: FAIL (2)');

    // Run the comparator's real pipeline: extract -> normalize -> compare
    // (buildExpected golden-template expansion) against the fixture.
    const r = execFileSync('node', [SCRIPT, '--diff', fixture], { encoding: 'utf8' });
    expect(r).toContain('regression-path lines match the golden');
    // The comparator's own match report confirms all four lines were found
    // and regenerated — not just a clean exit on a partial match.
    expect(r).toContain('note line: matched');
    expect(r).toContain('spare-fail line: matched');
    expect(r).toContain('seam-fail line: matched');
    expect(r).toContain('result line: FAIL (2)');
    // The golden is exactly the four evidence lines (plus its header
    // comments) — the regeneration must cover each pinned line.
    for (const line of ['- owner has <N>', '✗ FAIL: owner still has <N>', `✗ FAIL: ${SIMULATED_REGRESSION_SIGNATURE}`, 'RESULT: FAIL (2)']) {
      expect(goldenText).toContain(line);
    }
  });

  it('proves the regeneration path fires on drift — a mutated fixture exits 1 with a mismatch report', () => {
    // The codegen pin above must not be vacuous: a golden or regex drift
    // must actually fail the comparison. Mutate ONLY the RESULT count in an
    // in-memory fixture copy (2 -> 3), write it to a temp file, and run the
    // comparator's --diff on it: buildExpected regenerates the golden
    // template (still FAIL (2)) while the mutated line regenerates as FAIL
    // (3) — a genuine mismatch that must exit 1.
    const fixture = resolve(process.cwd(), FIXTURE);
    const mutated = readFileSync(fixture, 'utf8').replace('RESULT: FAIL (2)', 'RESULT: FAIL (3)');
    expect(mutated, 'the mutation must actually land').toContain('RESULT: FAIL (3)');
    const tmp = resolve('/tmp', 'vlive-regression-drift-fixture.log');
    writeFileSync(tmp, mutated);
    try {
      expect(() => execFileSync('node', [SCRIPT, '--diff', tmp], { encoding: 'utf8' })).toThrow();
      // execFileSync throws on non-zero exit — capture the exit code + drift
      // report from the thrown error to assert the FAILURE SHAPE, not just
      // that it threw.
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      expect(err.status).toBe(1);
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      expect(out).toContain('drift detected against the golden:');
      expect(out).toContain('RESULT: FAIL (2)');
      expect(out).toContain('RESULT: FAIL (3)');
    } finally {
      rmSync(tmp, { force: true });
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
