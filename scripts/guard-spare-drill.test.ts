import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The golden's expected lines derive from the SHARED renderer module
// (drill-evidence-render.mjs) — the same code path the comparator's
// expandNote/expandFail calls and the verify-live-classify codegen contract
// use — so a reworded signature updates the renderer and these pins track it
// in lockstep.
import { SPARED_LIVE_REASON } from './verify-live-classify.mjs';
import { renderNoteLine, renderSpareFailLine } from './drill-evidence-render.mjs';

// ============================================================================
// scripts/guard-spare-drill.test.ts — pin the end-to-end spare-drill
// comparator: the script + its committed golden file together pin the
// guard's note + fail line shapes so any future drift in the source's
// fail(...) message is caught on dispatch, not by hand-reading run logs.
// ============================================================================

const SCRIPT = 'scripts/guard-spare-drill.mjs';
const GOLDEN = 'scripts/__golden__/guard-spare-drill.txt';

// The dispatch-shape contract for this comparator, factored out so the
// mutation drill can prove it FAILS on an injected input or a broken base
// by invoking this exact assertion (same discipline as the regression
// comparator's expectDispatchSpelling — an independent check would keep
// passing if this assertion were later weakened or removed).
const expectDispatchShape = (source: string) => {
  // The exact base dispatch — the same proven shape all three comparators
  // share. Only the regression drill appends `-f force_verify_live_regression=true`.
  expect(source).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'])");
  // This drill carries NO parameter flag — injecting one (a copy-paste from
  // the regression drill) would silently change the drill's shape.
  expect(source).not.toMatch(/'workflow', 'run', 'ci\.yml', '--ref', 'main', '-[fF]'/);
  expect(source).not.toContain("'-f', 'force_verify_live_regression=true'");
};

describe('scripts/guard-spare-drill.mjs · the comparator + its golden', () => {
  it('exists as committed tooling (script + golden both on disk)', () => {
    expect(existsSync(resolve(process.cwd(), SCRIPT))).toBe(true);
    expect(existsSync(resolve(process.cwd(), GOLDEN))).toBe(true);
  });

  it('keeps the golden file with one note line and one fail line, in that order', () => {
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    const nonComment = body.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.trim()).filter(Boolean);
    expect(nonComment).toHaveLength(2);
    expect(nonComment[0]).toBe(renderNoteLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' }));
    expect(nonComment[1]).toBe(renderSpareFailLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' }));
  });

  it('keeps the five load-bearing placeholders so a renamed drill variable is caught', () => {
    // The placeholders are the contract: any reference to a variable that
    // is no longer named the same way (e.g. doc id renamed from drill-li-
    // to probe-) shows up as drift in the comparator's compare step.
    const body = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    for (const tok of ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>']) {
      expect(body, `golden missing placeholder ${tok}`).toContain(tok);
    }
  });

  it('regenerates the golden through the comparator\'s own extract/expand path against the fixture (codegen)', () => {
    // The golden derivation must come from the comparator's REGENERATION
    // path, not just the constants: the comparator extracts the NOTE + FAIL
    // lines from the log (extractLines), normalizes them (normalizedLines),
    // and diffs each regenerated line against the golden template via
    // buildExpected(golden, groups) (compare). Shelling out with --diff runs
    // that exact pipeline against the committed fixture — exit 0 proves
    // every golden template regenerates to the raw log line. A drift in any
    // regex, a reordered capture group, or a golden edit that no longer
    // round-trips surfaces here as a non-zero exit. (The regression
    // comparator's test does the same against its four-line fixture.)
    const fixture = resolve(process.cwd(), 'scripts/__golden__/spare-drill-log.txt');
    const goldenText = readFileSync(resolve(process.cwd(), GOLDEN), 'utf8');
    // Sanity: the fixture carries both evidence lines (the comparator's own
    // extract step must find them; without them --diff would exit 2).
    const log = readFileSync(fixture, 'utf8');
    expect(log).toContain('archiving and retrying once');
    expect(log).toContain('after the archive retry');

    // Run the comparator's real pipeline: extract -> normalize -> compare
    // (buildExpected golden-template expansion) against the fixture.
    const r = execFileSync('node', [SCRIPT, '--diff', fixture], { encoding: 'utf8' });
    expect(r).toContain('spare-path lines match the golden');
    // The comparator's own match report confirms both lines were found and
    // regenerated — not just a clean exit on a partial match.
    expect(r).toContain('note line: matched');
    expect(r).toContain('fail line: matched');
    // The golden is exactly the two evidence lines (plus its header
    // comments) — the regeneration must cover each pinned line.
    for (const line of ['- owner has <N>', '✗ FAIL: owner still has <N>']) {
      expect(goldenText).toContain(line);
    }
  });

  it('proves the regeneration path fires on drift — a golden edit that no longer round-trips exits 1', () => {
    // The codegen pin above must not be vacuous: a golden edit must actually
    // fail the comparison. Unlike the regression fixture's static RESULT
    // line (where mutating the FIXTURE fires), the spare golden's lines ALL
    // carry placeholders — a fixture-variant change (idle 8s → 9s) is
    // absorbed by the buildExpected substitution and still matches. The
    // genuine drift direction here is the GOLDEN: inject an extra word into
    // the NOTE template, copy the script to a temp path with the golden
    // constant pointed at the drifted file, and run --diff against the
    // UNCHANGED fixture: buildExpected regenerates the drifted template
    // (with EXTRA) while the actual line regenerates without it — a genuine
    // mismatch that must exit 1.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    const tmpScript = resolve(process.cwd(), 'scripts/.tmp-spare-drift.mjs');
    const tmpGolden = resolve('/tmp', 'spare-drift-golden.txt');
    const drifted = src.replace(
      "resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')",
      `'${tmpGolden}'`,
    );
    expect(drifted, 'the golden-path mutation must actually land').not.toContain(
      "resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')",
    );
    writeFileSync(tmpScript, drifted);
    writeFileSync(tmpGolden, [
      '# drift golden',
      '- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once EXTRA: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)',
      '✗ FAIL: owner still has <N> ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)',
      '',
    ].join('\n'));
    try {
      expect(() => execFileSync('node', [tmpScript, '--diff', resolve(process.cwd(), 'scripts/__golden__/spare-drill-log.txt')], { encoding: 'utf8' })).toThrow();
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      expect(err.status).toBe(1);
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      expect(out).toContain('drift detected against the golden:');
      expect(out).toContain('archiving and retrying once EXTRA:');
    } finally {
      rmSync(tmpScript, { force: true });
      rmSync(tmpGolden, { force: true });
    }
  });

  it('discovers the dispatched workflow run instead of parsing workflow-run stdout', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');

    // `gh workflow run` does not guarantee a run URL on stdout. The drill
    // must dispatch first, then query workflow_dispatch runs for ci.yml.
    expect(src).toMatch(/gh\(\['workflow', 'run', 'ci\.yml', '--ref', 'main'\]\)/);
    expect(src).toMatch(/'run',\s*'list'/);
    expect(src).toContain("'--event', 'workflow_dispatch'");
    expect(src).not.toMatch(/actions\\\/runs\\\/\(\\d\+\)/);
    expect(src).toContain('workflow dispatched but the new ci.yml run could not be located');
  });

  it('declares exit semantics so a future editor cannot silently change the contract', () => {
    // The script exports three exit codes: 0 = match, 1 = drift, 2 = missing
    // log/guard lines. Pinning the code paths that emit process.exit(...) so
    // a regression (say, exiting 0 on drift) fails CI instead of shipping
    // a fallen-over comparator.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain('process.exit(0)');                 // clean match / main exit
    expect(src).toMatch(/process\.exit\(1\)/);                  // drift
    expect(src).toMatch(/process\.exit\(2\)/);                  // missing/unparseable
    expect(src).toContain('drift detected against the golden');// drift message
  });

  it('dispatches ci.yml on main with the proven base shape — no drill input', () => {
    // The spare drill's dispatch is the pure base shape all three
    // comparators share: gh(['workflow', 'run', 'ci.yml', '--ref', 'main']).
    // Only the regression drill appends `-f force_verify_live_regression=true`
    // — a copy-paste that injects the input here would silently turn this
    // drill into a regression drill, so the exact literal + negative pins
    // below forbid it.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expectDispatchShape(src);

    // Cross-file: all three comparators must share the same base dispatch,
    // and ONLY the regression drill may append the input.
    for (const f of ['guard-spare-drill.mjs', 'guard-boundary-drill.mjs', 'guard-regression-drill.mjs']) {
      const other = readFileSync(resolve(process.cwd(), `scripts/${f}`), 'utf8');
      // The shared base is the dispatch PREFIX (up to but not including the
      // closing bracket) — the regression drill legitimately continues with
      // `, '-f', 'force_verify_live_regression=true'`.
      expect(other, `${f} must dispatch the same base shape`).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'");
    }
    const regression = readFileSync(resolve(process.cwd(), 'scripts/guard-regression-drill.mjs'), 'utf8');
    expect(regression).toContain("'-f', 'force_verify_live_regression=true'");
  });

  it('pins the flag interface with gh workflow run --help (the flags this drill deliberately omits)', () => {
    // gh is the interface the comparator dispatches through. This drill
    // passes no parameter flags (its dispatch is the pure base shape), but
    // the documented flag interface is still pinned so a future gh rename of
    // `-f` surfaces here even for drills that don't use it — and the
    // input-carrying `-f key=value` form stays confined to the regression
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
      "gh(['workflow', 'run', 'ci.yml', '--ref', 'main'])",
      "gh(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'force_verify_live_regression=true'])",
    );
    expect(injected, 'the injected-input mutation must actually land').not.toBe(src);
    expect(() => expectDispatchShape(injected)).toThrow();

    // Direction 2 — broken base: a whitespace/ref drift that changes the
    // dispatch without touching the flag patterns (breaks ONLY the exact
    // literal, so the exact-literal pin is individually load-bearing).
    const brokenBase = src.replace(
      "gh(['workflow', 'run', 'ci.yml', '--ref', 'main'])",
      "gh(['workflow', 'run', 'ci.yml', '--ref', 'main '])",
    );
    expect(brokenBase, 'the broken-base mutation must actually land').not.toBe(src);
    expect(() => expectDispatchShape(brokenBase)).toThrow();
  });
});

describe('scripts/guard-spare-drill.mjs · the live /api/status reason assertion', () => {
  // After the log golden matches, the drill must ALSO prove the recorded
  // reason reached the DEPLOYED endpoint: it mints a real owner token, GETs
  // /api/status, and asserts verifyLive.reason equals the exported
  // SPARED_LIVE_REASON constant. These pins keep that assertion deriving
  // from the constant (never a second literal) and load-bearing (dropping
  // or weakening it fails the mutation drill).
  const SRC = () => readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');

  it('imports SPARED_LIVE_REASON from the classifier module', () => {
    const src = SRC();
    expect(src).toContain("from './verify-live-classify.mjs'");
    expect(src).toContain('  SPARED_LIVE_REASON,');
    // The assertion must compare against the constant — a page-style literal
    // would reintroduce a second copy of the reason value.
    expect(src).toContain('v.reason !== SPARED_LIVE_REASON');
    expect(src).not.toContain("v.reason !== 'spared-live-session'");
  });

  it('reads the deployed /api/status route with a real owner bearer token', () => {
    const src = SRC();
    expect(src).toContain('${APP}/api/status');
    expect(src).toContain("headers: { authorization: `Bearer ${idToken}` }");
    // The token mint mirrors verify-live.mjs: custom token → identitytoolkit.
    expect(src).toContain('signInWithCustomToken');
    expect(src).toContain('getAuth(app).createCustomToken(OWNER_UID)');
  });

  it('cross-checks runUrl against the drill run before trusting the reason', () => {
    // /api/status reads the single-slot deploy_status/verify_live doc, which
    // a concurrent ci.yml run can overwrite. Without this guard the drill
    // could assert against a FOREIGN record and falsely pass.
    const src = SRC();
    expect(src).toContain('v.runUrl.includes(`/runs/${runId}`)');
    expect(src).toContain('a concurrent run overwrote the record; cannot assert the live reason');
  });

  it('calls the assertion only after the golden matched, before cleanup', () => {
    const src = SRC();
    const goldenIdx = src.indexOf('spare-path lines match the golden');
    const assertIdx = src.indexOf('await assertLiveStatusReason(runId);');
    const cleanupIdx = src.indexOf("'--delete'");
    expect(goldenIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(goldenIdx);
    expect(cleanupIdx).toBeGreaterThan(assertIdx);
  });

  it('proves the reason-comparison pin catches a literal or a dropped guard (mutation)', () => {
    const src = SRC();

    // Direction 1 — revert the comparison to the raw literal: the
    // literal-free pin must fail.
    const inlined = src.replace('v.reason !== SPARED_LIVE_REASON', "v.reason !== 'spared-live-session'");
    expect(inlined, 'the inline mutation must actually land').not.toBe(src);
    expect(inlined).toContain("v.reason !== 'spared-live-session'");
    expect(inlined).not.toContain('v.reason !== SPARED_LIVE_REASON');

    // Direction 2 — drop the runUrl cross-check (the concurrent-run guard):
    // the runUrl pin must fail.
    const droppedRunUrl = src.replace('if (typeof v.runUrl !== \'string\' || !v.runUrl.includes(`/runs/${runId}`)) {', 'if (false) {');
    expect(droppedRunUrl, 'the runUrl-drop mutation must actually land').not.toBe(src);
    expect(droppedRunUrl).not.toContain('v.runUrl.includes(`/runs/${runId}`)');

    // Direction 3 — drop the whole assertion call: the ordering pin must fail.
    const droppedCall = src.replace('await assertLiveStatusReason(runId);', '');
    expect(droppedCall, 'the dropped-call mutation must actually land').not.toBe(src);
    expect(droppedCall).not.toContain('await assertLiveStatusReason(runId);');

    // The pins are the guards — same discipline as the dispatch drills.
    expect(src).toContain('v.reason !== SPARED_LIVE_REASON');
    expect(src).not.toContain("v.reason !== 'spared-live-session'");
    expect(src).toContain('v.runUrl.includes(`/runs/${runId}`)');
    expect(src).toContain('await assertLiveStatusReason(runId);');
    expect(SPARED_LIVE_REASON).toBe('spared-live-session');
  });
});
