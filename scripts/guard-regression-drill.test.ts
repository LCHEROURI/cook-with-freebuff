import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SIMULATED_REGRESSION_SIGNATURE } from './verify-live-classify.mjs';

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
    expect(nonComment[0]).toBe('- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)');
    expect(nonComment[1]).toBe('✗ FAIL: owner still has <N> ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)');
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

  it('replays the comparator against the committed fixture and confirms it matches', () => {
    // The fixture captures the live third drill (run 32429029312). The
    // comparator must extract all four evidence lines and diff clean against
    // the golden — the canonical behavior the weekly job depends on.
    const log = readFileSync(resolve(process.cwd(), FIXTURE), 'utf8');
    expect(log).toContain('archiving and retrying once');
    expect(log).toContain('after the archive retry');
    expect(log).toContain(SIMULATED_REGRESSION_SIGNATURE);
    expect(log).toContain('RESULT: FAIL (2)');
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
    expect(src).toMatch(/'workflow', 'run', 'ci\.yml', '--ref', 'main', '-f', 'force_verify_live_regression=true'/);
    expect(src).toContain('workflow dispatched but the new ci.yml run could not be located');
    expect(src).toContain("'--event', 'workflow_dispatch'");
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
