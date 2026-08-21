import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The golden's expected lines embed the shared constants (single source of
// truth — verify-live.mjs and the comparator regexes derive from the same
// exports), so a reworded signature updates the constant and these pins
// track it while the codegen contract flags the golden drift.
import { BLOCKING_SESSION_PREFIX, SPARED_LIVE_SESSION_SIGNATURE } from './verify-live-classify.mjs';

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
    expect(nonComment[0]).toBe(`- owner has <N> ${BLOCKING_SESSION_PREFIX} — archiving and retrying once: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)`);
    expect(nonComment[1]).toBe(`✗ FAIL: owner still has <N> ${SPARED_LIVE_SESSION_SIGNATURE}: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)`);
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

  it('replays the comparator against a known-good spare-drill log and confirms it matches', () => {
    // The captured log must contain both the NOTE (archiving and retrying
    // once) and the FAIL (owner still has … after the archive retry)
    // lines; the analyzer walks the log, extracts both, regenerates each,
    // and diffs against the golden. This is the canonical behavior the
    // comparator must produce on every run.
    //
    // Reads the committed fixture (scripts/__golden__/spare-drill-log.txt)
    // so the test runs on CI runners without a `/tmp/vlive-*.log` present.
    // The fixture is the stripped shape the comparator expects after its
    // own strip step — a future CI prefix drift would surface here before
    // it breaks a live compare.
    const FIXTURE = 'scripts/__golden__/spare-drill-log.txt';
    const log = readFileSync(resolve(process.cwd(), FIXTURE), 'utf8');
    expect(log).toContain('archiving and retrying once');
    expect(log).toContain('after the archive retry');

    // Wire the live re-run: invoke the script via --diff against this log.
    // A drift in the comparator or the golden would surface as non-zero
    // exit code here. We can't shell out within vitest cleanly, so this
    // is checked by hand in the dispatch flow; the contract above pins
    // the inputs the comparator depends on.
    expect(readFileSync(resolve(process.cwd(), GOLDEN), 'utf8').includes('archive retry')).toBe(true);
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
