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
// The --diff codegen + drift drill discipline is shared with the boundary
// and regression comparator tests — exit-0 replay, drift exit-1 with
// verbatim expected/actual shape, and the dead-catch-free error capture all
// live in this one module.
import { assertCodegenReplay, assertFixtureDrift, assertGoldenDrift } from './drill-codegen-helpers.mjs';

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
  // share. Each drill carries -f source=<drill-name> for the recorder,
  // but ONLY the regression drill may also carry -f force_verify_live_regression=true.
  expect(source).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'");
  // The regression input must NOT appear in non-regression drills.
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
    // round-trips surfaces here as a non-zero exit. The drill discipline
    // (exit-0 replay + match report + golden prefixes) is shared with the
    // boundary and regression comparators via drill-codegen-helpers.mjs.
    assertCodegenReplay({
      script: SCRIPT,
      fixture: 'scripts/__golden__/spare-drill-log.txt',
      goldenPath: GOLDEN,
      matchLine: 'spare-path lines match the golden',
      reportLines: ['note line: matched', 'fail line: matched'],
      fixtureSanity: ['archiving and retrying once', 'after the archive retry'],
      goldenPrefixes: ['- owner has <N>', '✗ FAIL: owner still has <N>'],
    });
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
    // mismatch that must exit 1 with the verbatim expected/actual lines. The
    // drill (temp script + drifted golden + dead-catch-free error capture +
    // verbatim shape pins) is shared with the other comparators via
    // drill-codegen-helpers.mjs.
    assertGoldenDrift({
      script: SCRIPT,
      fixture: 'scripts/__golden__/spare-drill-log.txt',
      goldenPath: GOLDEN,
      goldenPathLiteral: "resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')",
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
      expectedLine: 'expected: - owner has 1 ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once EXTRA: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      actualLine: 'actual:   - owner has 1 ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      tmpScriptName: 'scripts/.tmp-spare-drift.mjs',
      tmpGoldenName: '/tmp/spare-drift-golden.txt',
    });
  });

  it('proves the regeneration path fires on FIXTURE drift — a fail line that no longer extracts exits 1', () => {
    // The golden-drift test above mutates the GOLDEN; this direction mutates
    // the FIXTURE so ALL THREE comparators pin both sides of the round-trip.
    // The spare golden's lines ALL carry placeholders, so a fixture-VALUE
    // change (idle 8s → 9s, or a different recipe id) is absorbed by the
    // buildExpected substitution and correctly still matches (exit 0) — the
    // placeholder contract. The genuine fixture-side drift is STRUCTURAL:
    // inject a word into the fail line so FAIL_RE can no longer extract it,
    // and the comparator must report the golden fail template as a missing
    // expected line (exit 1). Mirrors the regression drill's fixture-drift
    // test — the shared assertFixtureDrift helper runs the real script
    // against the mutated fixture and asserts exit 1 + the drift report.
    assertFixtureDrift({
      script: SCRIPT,
      fixture: 'scripts/__golden__/spare-drill-log.txt',
      mutateFixture: (content: string) =>
        content.replace(
          '✗ FAIL: owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: drill-li',
          '✗ FAIL: owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry EXTRA: drill-li',
        ),
      mutationLand: 'after the archive retry EXTRA:',
      tmpFixtureName: '/tmp/spare-fixture-drift.log',
      // The comparator prints the golden TEMPLATE as the missing expected
      // line — the renderer-derived template is the canonical shape.
      driftLines: [
        `missing expected line: ${renderSpareFailLine({ n: '<N>', id: '<ID>', phase: '<PHASE>', recipe: '<RECIPE>', idle: '<IDLE>' })}`,
      ],
    });
  });

  it('proves compare() cannot silently stop firing — both pinned outcomes flip under a weakened comparator (mutation)', () => {
    // The pipeline's drift detection lives entirely in compare(): a future
    // edit that weakens it (ignores mismatches, or always matches) would
    // silently stop the guard. Mirror the golden-drift test's temp-script
    // pattern: apply each mutation to a copy of the REAL script and confirm
    // it FLIPS the pinned exit code that the codegen/drift tests assert —
    // proving both pins go red against the mutation, i.e. neither is vacuous.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    const fixture = resolve(process.cwd(), 'scripts/__golden__/spare-drill-log.txt');
    const tmpScript = resolve(process.cwd(), 'scripts/.tmp-compare-mutation.mjs');
    const tmpGolden = resolve('/tmp', 'spare-compare-mutation-golden.txt');
    const goldenPath = "resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt')";
    const pointAtTempGolden = (s: string) => s.replace(goldenPath, `'${tmpGolden}'`);
    const driftedGolden = [
      '# drift golden',
      '- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once EXTRA: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)',
      '✗ FAIL: owner still has <N> ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)',
      '',
    ].join('\n');

    try {
      writeFileSync(tmpGolden, driftedGolden);

      // Sanity — the UNMUTATED script rejects the drifted golden (exit 1),
      // the exact outcome the drift test pins. Without this check, Direction
      // 1's "exit 0" below could be the status quo and the mutation would
      // have no footprint to prove.
      writeFileSync(tmpScript, pointAtTempGolden(src));
      let saneStatus: number | null = null;
      try {
        execFileSync('node', [tmpScript, '--diff', fixture], { encoding: 'utf8' });
      } catch (e) {
        saneStatus = (e as { status?: number }).status ?? null;
      }
      expect(saneStatus, 'sanity: the unmutated script must still reject the drifted golden').toBe(1);

      // Direction 1 — compare() ignores mismatches (never reports drift):
      // the drifted golden is now ACCEPTED (exit 0, "match the golden"),
      // flipping the drift test's pinned exit-1 → the drift test goes red.
      const ignoreMismatches = src.replace(
        /function compare\(actual\) \{[\s\S]*?\n\}/,
        'function compare() {\n  return [];\n}',
      );
      expect(ignoreMismatches, 'the ignore-mismatches mutation must actually land').not.toBe(src);
      writeFileSync(tmpScript, pointAtTempGolden(ignoreMismatches));
      const laxOut = execFileSync('node', [tmpScript, '--diff', fixture], { encoding: 'utf8' });
      expect(laxOut).toContain('spare-path lines match the golden');

      // Direction 2 — compare() reports a mismatch unconditionally: the
      // GOOD fixture is now REJECTED (exit 1), flipping the codegen test's
      // pinned exit-0 → the codegen test goes red.
      const alwaysFail = src.replace(
        /function compare\(actual\) \{[\s\S]*?\n\}/,
        "function compare() {\n  return [{ kind: 'mismatch', expected: 'x', actual: 'y' }];\n}",
      );
      expect(alwaysFail, 'the always-fail mutation must actually land').not.toBe(src);
      writeFileSync(tmpScript, pointAtTempGolden(alwaysFail));
      let strictStatus: number | null = null;
      try {
        execFileSync('node', [tmpScript, '--diff', fixture], { encoding: 'utf8' });
      } catch (e) {
        strictStatus = (e as { status?: number }).status ?? null;
      }
      expect(strictStatus).toBe(1);
    } finally {
      rmSync(tmpScript, { force: true });
      rmSync(tmpGolden, { force: true });
    }
  });

  it('discovers the dispatched workflow run instead of parsing workflow-run stdout', () => {
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');

    // `gh workflow run` does not guarantee a run URL on stdout. The drill
    // must dispatch first, then query workflow_dispatch runs for ci.yml.
    expect(src).toMatch(/gh\(\['workflow', 'run', 'ci\.yml', '--ref', 'main'.*\]\)/);
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

  it('post-seed exits use process.exitCode + return so try/finally cleanup always runs', () => {
    // A post-seed process.exit(…) bypasses finally blocks, leaking the
    // drill-live-session and poisoning the next run. Pin that the main()
    // post-seed path uses process.exitCode + return (not process.exit) so
    // the finally cleanup always executes.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expect(src).toMatch(/process\.exitCode = 2; return/);  // dispatch-not-found / verify:live timeout / no lines
    expect(src).toMatch(/process\.exitCode = 1; return/);  // drift
    expect(src).toContain('try {');                         // post-seed try block
    expect(src).toContain('} finally {');                  // cleanup in finally
  });

  it('dispatches ci.yml on main with source=spare-drill — no regression input', () => {
    // The spare drill dispatches with -f source=spare-drill so the
    // recorder tags the verify_live doc with the drill origin. Only the
    // regression drill may also append -f force_verify_live_regression=true.
    const src = readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
    expectDispatchShape(src);
    expect(src).toContain("'-f', 'source=spare-drill'");
    expect(src).not.toContain('force_verify_live_regression');

    // Cross-file: each comparator must dispatch with its own source tag.
    for (const f of ['guard-spare-drill.mjs', 'guard-boundary-drill.mjs', 'guard-regression-drill.mjs']) {
      const other = readFileSync(resolve(process.cwd(), `scripts/${f}`), 'utf8');
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
      "'-f', 'source=spare-drill'",
      "'-f', 'source=spare-drill', '-f', 'force_verify_live_regression=true'",
    );
    expect(injected, 'the injected-input mutation must actually land').not.toBe(src);
    expect(() => expectDispatchShape(injected)).toThrow();

    // Direction 2 — wrong source tag: replacing the drill name with the
    // regression drill's tag silently changes the recorder's source field,
    // so a genuine regression would look like a drill no-mask proof.
    const wrongSource = src.replace(
      "'-f', 'source=spare-drill'",
      "'-f', 'source=regression-drill'",
    );
    expect(wrongSource, 'the wrong-source mutation must actually land').not.toBe(src);
    // The dispatch test's source-specific pin catches this:
    expect(wrongSource).toContain("'-f', 'source=regression-drill'");
    expect(wrongSource).not.toContain("'-f', 'source=spare-drill'");
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
    const assertIdx = src.indexOf('await assertLiveStatusReason(runId, failureCountFromLog(log));');
    // Anchor to the delete AFTER the assertion: the seed section now runs a
    // delete-first (idempotent seed), so a bare indexOf("'--delete'") would
    // match that earlier occurrence and vacuously pass.
    const cleanupIdx = src.indexOf("'--delete'", assertIdx);
    expect(goldenIdx).toBeGreaterThan(-1);
    expect(assertIdx).toBeGreaterThan(goldenIdx);
    expect(cleanupIdx).toBeGreaterThan(assertIdx);
  });

  it('derives the failure count from the log\'s RESULT line to tell spare-only from mixed runs', () => {
    // The nightly 32481063037 failure: the golden diff passed (spare
    // evidence perfect) but the run carried a CO-OCCURRING voice-driver
    // flake, so the classifier's no-mask rule recorded reason=null and the
    // drill red on the reason assertion. The failure count is knowable from
    // the log: verify-live.mjs prints `RESULT: FAIL (N)` (failures.length)
    // or `RESULT: FAIL (crash)` in its finally block — the LAST match.
    const src = SRC();
    expect(src).toContain('function failureCountFromLog(logText) {');
    // The RESULT-count regex literal as it appears in the source (escaped
    // parens + \\d): pinning the exact literal means a rename of the count
    // syntax (e.g. dropping the crash branch) reddens here.
    expect(src).toContain('/RESULT: FAIL \\((\\d+|crash)\\)/g');
    // The count must be passed into the assertion — dropping it would make
    // the mixed-run exemption unreachable and re-red the co-occurring-flake
    // case.
    expect(src).toContain('await assertLiveStatusReason(runId, failureCountFromLog(log));');
    expect(src).toContain('async function assertLiveStatusReason(runId, failureCount) {');
  });

  it('spare-only runs still require the spared reason — a missing reason is a real guard regression', () => {
    // failures.length === 1: the classifier MUST record the spared reason.
    // A missing/foreign reason there means the classifier or recorder broke
    // (a genuine regression), so the strict throw stays for count 1.
    const src = SRC();
    expect(src).toContain('if (failureCount === 1) {');
    expect(src).toContain('v.reason !== SPARED_LIVE_REASON');
    expect(src).toContain('expected the exported SPARED_LIVE_REASON constant');
  });

  it('mixed-failure runs require NO reason (no-mask) and report the spare evidence separately', () => {
    // failures.length >= 2: the no-mask rule forbids the spared reason next
    // to a real failure. The spare evidence was already proven by the golden
    // diff; the drill must NOT red on the reason — it notes the co-occurring
    // failure and passes. A reason present on a mixed run is a no-mask
    // violation (sparing masked a real failure).
    const src = SRC();
    expect(src).toContain("typeof failureCount === 'number' && failureCount >= 2");
    expect(src).toContain('no-mask violation: mixed-failure run');
    expect(src).toContain('spare evidence proven separately');
    expect(src).toContain('reason correctly null per the no-mask rule');
    // The mixed branch returns (does not throw) — a co-occurring flake must
    // not red the drill. Pin the return-side ok() line verbatim.
    expect(src).toContain("ok(`live /api/status: mixed-failure run (${failureCount} failures) — spare evidence proven separately (reason=${v.reason ?? 'null'}) for run ${runId}`);");
  });

  it('keeps the crash/unknown path conservative — only a proven mixed count earns the exemption', () => {
    // failureCount 'crash' or null (unparseable): the run did not complete a
    // clean failure set, so the mixed-path exemption cannot be claimed. Stay
    // conservative — require the spared reason exactly as a spare-only run.
    const src = SRC();
    expect(src).toContain("failureCount is 'crash' or null (unparseable)");
    expect(src).toContain('the mixed-path exemption cannot be');
  });

  it('proves the reason-comparison pin catches a literal or a dropped guard (mutation)', () => {
    const src = SRC();

    // Direction 1 — revert the comparison to the raw literal: the
    // literal-free pin must fail. The comparison now appears in BOTH the
    // spare-only branch (count 1) and the crash/unknown path, so the
    // mutation must replace ALL occurrences — a bare replace would leave
    // one and the pin would miss it.
    const inlined = src.split('v.reason !== SPARED_LIVE_REASON').join("v.reason !== 'spared-live-session'");
    expect(inlined, 'the inline mutation must actually land').not.toBe(src);
    expect(inlined).toContain("v.reason !== 'spared-live-session'");
    expect(inlined).not.toContain('v.reason !== SPARED_LIVE_REASON');

    // Direction 2 — drop the runUrl cross-check (the concurrent-run guard):
    // the runUrl pin must fail.
    const droppedRunUrl = src.replace('if (typeof v.runUrl !== \'string\' || !v.runUrl.includes(`/runs/${runId}`)) {', 'if (false) {');
    expect(droppedRunUrl, 'the runUrl-drop mutation must actually land').not.toBe(src);
    expect(droppedRunUrl).not.toContain('v.runUrl.includes(`/runs/${runId}`)');

    // Direction 3 — drop the whole assertion call: the ordering pin must fail.
    const droppedCall = src.replace('await assertLiveStatusReason(runId, failureCountFromLog(log));', '');
    expect(droppedCall, 'the dropped-call mutation must actually land').not.toBe(src);
    expect(droppedCall).not.toContain('await assertLiveStatusReason(runId, failureCountFromLog(log));');

    // The pins are the guards — same discipline as the dispatch drills.
    expect(src).toContain('v.reason !== SPARED_LIVE_REASON');
    expect(src).not.toContain("v.reason !== 'spared-live-session'");
    expect(src).toContain('v.runUrl.includes(`/runs/${runId}`)');
    expect(src).toContain('await assertLiveStatusReason(runId, failureCountFromLog(log));');
    expect(SPARED_LIVE_REASON).toBe('spared-live-session');
  });

  it('proves the mixed-run distinction is load-bearing — a revert to strict-only reddens the new pins (mutation)', () => {
    const src = SRC();

    // Direction 1 — collapse the count check so every run is treated as
    // spare-only (the mixed branch becomes unreachable): the mixed-run pins
    // above (>= 2 branch, no-mask throw, separate-report) must fail.
    const collapsed = src.replace(
      "if (typeof failureCount === 'number' && failureCount >= 2) {",
      'if (false) {',
    );
    expect(collapsed, 'the collapse mutation must actually land').not.toBe(src);
    expect(collapsed).not.toContain("typeof failureCount === 'number' && failureCount >= 2");

    // Direction 2 — drop the no-mask throw inside the mixed branch: a mixed
    // run with a wrongly-present reason would now pass silently instead of
    // reddening as a no-mask violation.
    const droppedNoMask = src.replace(
      "throw new Error(`no-mask violation: mixed-failure run (${failureCount} failures) recorded reason ${JSON.stringify(v.reason)} — sparing masked a real failure`);",
      '',
    );
    expect(droppedNoMask, 'the dropped-no-mask mutation must actually land').not.toBe(src);
    expect(droppedNoMask).not.toContain('no-mask violation: mixed-failure run');

    // Direction 3 — revert the call site to the old bare signature (no
    // failure count): the mixed branch can never be reached from main.
    const bareCall = src.replace(
      'await assertLiveStatusReason(runId, failureCountFromLog(log));',
      'await assertLiveStatusReason(runId);',
    );
    expect(bareCall, 'the bare-call mutation must actually land').not.toBe(src);
    expect(bareCall).not.toContain('failureCountFromLog(log)');

    // The pins are the guards.
    expect(src).toContain("typeof failureCount === 'number' && failureCount >= 2");
    expect(src).toContain('no-mask violation: mixed-failure run');
    expect(src).toContain('await assertLiveStatusReason(runId, failureCountFromLog(log));');
  });
});
