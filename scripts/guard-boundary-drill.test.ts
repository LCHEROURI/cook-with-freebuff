import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// The golden NOTE line embeds the shared BLOCKING_SESSION_PREFIX (single
// source of truth — verify-live.mjs's note(...) and the comparator regexes
// derive from the same export), so a reworded signature updates the constant
// and this pin tracks it while the codegen contract flags the golden drift.
import { BLOCKING_SESSION_PREFIX } from './verify-live-classify.mjs';

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
  // share. Only the regression drill appends `-f force_verify_live_regression=true`.
  expect(source).toContain("gh(['workflow', 'run', 'ci.yml', '--ref', 'main'])");
  // This drill carries NO parameter flag — injecting one (a copy-paste from
  // the regression drill) would silently change the drill's shape.
  expect(source).not.toMatch(/'workflow', 'run', 'ci\.yml', '--ref', 'main', '-[fF]'/);
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
    expect(nonComment[0]).toBe(`- owner has <N> ${BLOCKING_SESSION_PREFIX} — archiving and retrying once: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)`);
    expect(nonComment[1]).toBe('✓ archived <N> blocking session(s) — retried, owner is clean before the UI starter');
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
    // 0: the ok() happy path; main().then(…) is the structural marker.
    expect(text).toMatch(/main\(\)\.then\(\(\) => process\.exit\(0\)\)/);
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

  it('exercises the /--diff <path> path end to end (returns 0 on the boundary fixture)', () => {
    // Same discipline as the spare comparator's exit-semantics test: shell
    // out and read the actual exit code so a future edit that swaps the
    // regex can't go unnoticed. The spare comparator's test does this same
    // external-call pattern against its own fixture.
    const r = execFileSync('node', [SCRIPT, '--diff', FIXTURE], { encoding: 'utf8' });
    expect(r).toContain('boundary-path lines match the golden');
  });

  it('dispatches ci.yml on main with the proven base shape — no drill input', () => {
    // The boundary drill's dispatch is the pure base shape all three
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
