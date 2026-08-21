// ─────────────────────────────────────────────────────────────────────────────
// scripts/drill-codegen-helpers.mjs — shared --diff codegen + drift drill
// helpers for the three guard-drill test files (guard-spare/boundary/
// regression-drill.test.ts).
//
// Each comparator test pins two things about its --diff replay path:
//   1. CODEGEN — `node SCRIPT --diff FIXTURE` exits 0 with the comparator's
//      own match report lines (proves the extract -> normalize -> compare
//      pipeline regenerates every golden template from the fixture).
//   2. DRIFT — a drifted golden (or drifted fixture) exits 1 with the
//      verbatim expected/actual mismatch lines (proves the exit code isn't
//      the only thing pinned; the failure SHAPE is too).
//
// The drill discipline lives here in ONE place so a fix to one drill (the
// dead-catch trap, the verbatim shape pin) applies to all three. Tests pass
// the per-drill specifics (script/golden paths, match phrases, the exact
// drifted golden content, the verbatim expected/actual lines).
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';

// Run `node SCRIPT --diff INPUT` and assert it exits 0 with the comparator's
// match report. The comparator's own report lines (e.g. "note line: matched")
// prove both lines were found AND regenerated — not just a clean exit on a
// partial match. `fixtureSanity` substrings must exist in the fixture (the
// extract step needs them; without them --diff would exit 2 instead);
// `goldenPrefixes` are template prefixes the committed golden must contain
// so the regeneration covers each pinned line.
export function assertCodegenReplay({ script, fixture, goldenPath, matchLine, reportLines, fixtureSanity, goldenPrefixes }) {
  const fixtureAbs = resolve(process.cwd(), fixture);
  const goldenText = readFileSync(resolve(process.cwd(), goldenPath), 'utf8');
  const log = readFileSync(fixtureAbs, 'utf8');
  for (const needle of fixtureSanity) {
    expect(log, `fixture missing expected substring: ${needle}`).toContain(needle);
  }
  const r = execFileSync('node', [script, '--diff', fixtureAbs], { encoding: 'utf8' });
  expect(r).toContain(matchLine);
  for (const line of reportLines) {
    expect(r).toContain(line);
  }
  for (const prefix of goldenPrefixes) {
    expect(goldenText).toContain(prefix);
  }
}

// Golden drift: inject an extra word into the NOTE template of a temp COPY of
// the golden, point a temp script copy at that golden, and run --diff against
// the UNCHANGED fixture. buildExpected regenerates the drifted template (with
// EXTRA) as the expected line while the actual line regenerates without it —
// a genuine mismatch that must exit 1 with the verbatim expected/actual lines.
// The error is captured OUTSIDE the toThrow wrapper: a `catch` around
// `expect(...).toThrow()` only runs when the command does NOT throw (exit 0),
// so assertions placed there never execute in the drift case — only the exit
// code would be pinned, never the failure shape.
export function assertGoldenDrift({
  script,
  fixture,
  goldenPathLiteral, // the exact golden-path expression in the script source
  driftedGoldenContent, // full content of the drifted temp golden (string)
  expectedLine, // verbatim "expected: ..." line the comparator must print
  actualLine, // verbatim "actual:   ..." line the comparator must print
  tmpScriptName,
  tmpGoldenName,
}) {
  const src = readFileSync(resolve(process.cwd(), script), 'utf8');
  const tmpScript = resolve(process.cwd(), tmpScriptName);
  const tmpGolden = resolve(tmpGoldenName);
  const drifted = src.replace(goldenPathLiteral, `'${tmpGolden}'`);
  expect(drifted, 'the golden-path mutation must actually land').not.toContain(goldenPathLiteral);
  writeFileSync(tmpScript, drifted);
  writeFileSync(tmpGolden, driftedGoldenContent);
  try {
    let err = null;
    try {
      execFileSync('node', [tmpScript, '--diff', resolve(process.cwd(), fixture)], { encoding: 'utf8' });
    } catch (e) {
      err = e;
    }
    expect(err, 'expected the drifted golden to exit non-zero').not.toBeNull();
    expect(err.status).toBe(1);
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    expect(out).toContain('drift detected against the golden:');
    expect(out).toContain(expectedLine);
    expect(out).toContain(actualLine);
  } finally {
    rmSync(tmpScript, { force: true });
    rmSync(tmpGolden, { force: true });
  }
}

// Fixture drift (regression only): mutate the fixture's RESULT count in
// memory, write a temp fixture, and run the REAL script's --diff against it:
// buildExpected regenerates the golden template (still FAIL (2)) while the
// mutated line regenerates as FAIL (3) — a genuine mismatch that must exit 1
// with the verbatim drift lines. Error captured outside toThrow (same
// dead-catch discipline as assertGoldenDrift).
export function assertFixtureDrift({ script, fixture, mutateFixture, mutationLand, tmpFixtureName, driftLines }) {
  const mutated = mutateFixture(readFileSync(resolve(process.cwd(), fixture), 'utf8'));
  if (mutationLand) {
    expect(mutated, 'the mutation must actually land').toContain(mutationLand);
  }
  const tmp = resolve(tmpFixtureName);
  writeFileSync(tmp, mutated);
  try {
    let err = null;
    try {
      execFileSync('node', [script, '--diff', tmp], { encoding: 'utf8' });
    } catch (e) {
      err = e;
    }
    expect(err, 'expected the drifted fixture to exit non-zero').not.toBeNull();
    expect(err.status).toBe(1);
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    expect(out).toContain('drift detected against the golden:');
    for (const line of driftLines) {
      expect(out).toContain(line);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
