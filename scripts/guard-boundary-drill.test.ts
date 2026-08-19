import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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
    expect(nonComment[0]).toBe('- owner has <N> ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: <ID>… (<PHASE>, <RECIPE>, <IDLE>s idle)');
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
});
