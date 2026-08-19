#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/guard-spare-drill.mjs — end-to-end guard-spare drill comparator.
//
// Mode 1 (default): dispatches a ci.yml run on `main`, keeps a seeded
// drill-live-session alive through the guard window, downloads the verify:live
// job log, extracts the two spare-path lines, normalizes them, and diffs them
// against the committed golden file (`scripts/__golden__/guard-spare-drill.txt`).
// Exits 0 on match, 1 on drift, 2 on missing/unparseable lines.
//
// Mode 2 (--diff <run-id-or-log>): skip dispatch + touching; fetch (or read)
// the log and just run the compare. Useful for replaying the comparison
// against a known-good run without re-running the drill.
//
// The script assumes APP_OWNER_UID + FIREBASE_SERVICE_ACCOUNT are loaded from
// ./.env.local (mirrors the drill-live-session helper), and uses the existing
// driver CLI (gh) for run/job lookups and log fetch.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const GOLDEN = resolve(ROOT, 'scripts/__golden__/guard-spare-drill.txt');
// Node-time check: the <N> count, idle, and other drill-run variants must not
// rewrite the golden's static shape. Any drift below is a script bug, not a
// guard regression.
const FIXED_TOKENS = ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); };
const note = (m) => console.log(`  - ${m}`);

// ── .env.local loader (mirrors drill-live-session.mjs so credentials are
//    available for the seed + touch helpers). ────────────────────────────
function loadEnv() {
  try {
    const text = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env.local — CI passes vars directly */ }
}
loadEnv();

// ── helpers ─────────────────────────────────────────────────────────────
const gh = (args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return e.stdout?.toString() ?? '';
  }
};
const ghJson = (args) => JSON.parse(gh(args));

// Load .env values for child processes (record step / driver need NextPublic keys).
function envAssign(target, source) {
  for (const [k, v] of Object.entries(source)) if (target[k] === undefined) target[k] = v;
}
function runNodeWithEnv(scriptPath, extraArgs = []) {
  const env = { ...process.env };
  envAssign(env, {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT,
    APP_OWNER_UID: process.env.APP_OWNER_UID,
  });
  return execFileSync('node', [scriptPath, ...extraArgs], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── Golden: builds the expected line set from the committed file. ────────
// The file is a text body split into lines; placeholders stay literal so a
// future rename in the guard breaks the diff before a rename in the golden.
function readGolden() {
  if (!existsSync(GOLDEN)) throw new Error(`missing golden: ${GOLDEN}`);
  return readFileSync(GOLDEN, 'utf8').split('\n');
}
function expectedLines() {
  // Strip the leading comment block so a future contributor-friendly header
  // change doesn't show as drift.
  const lines = readGolden();
  return lines.filter((l) => !l.startsWith('#'));
}

// ── Log parser: extract the two spare-path lines from the verify:live log
//    and normalize the drill-run-variant fields to the FIXED_TOKENS. ─────
const NOTE_RE = /^\s*-\s+owner has (\d+) ACTIVE\/PAUSED session\(s\) blocking the UI starter — archiving and retrying once: ([A-Za-z0-9-]+)… \(([^,]+), ([^,]+), (\d+)s idle\)/;
const FAIL_RE = /^\s*✗ FAIL:\s+owner still has (\d+) ACTIVE\/PAUSED session\(s\) blocking the UI starter after the archive retry: ([A-Za-z0-9-]+)… \(([^,]+), ([^,]+), (\d+)s idle\)/;

function normalize(line, re) {
  const m = line.match(re);
  if (!m) return null;
  return m;
}

// Substitute the captured groups into the golden template so it reproduces
// the exact raw source log line. Drift detection: if the source fail(...)
// message changes wording, the regex breaks the extraction step above (so we
// fail-fast). If whitespace or order shifts, the substituted line differs
// from the raw log line and `compare` reports it. Either way, the golden is
// the canonical shape.
function expandNote(m) {
  const [, n, id, phase, recipe, idle] = m;
  return `- owner has ${n} ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: ${id}… (${phase}, ${recipe}, ${idle}s idle)`;
}
function expandFail(m) {
  const [, n, id, phase, recipe, idle] = m;
  return `✗ FAIL: owner still has ${n} ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: ${id}… (${phase}, ${recipe}, ${idle}s idle)`;
}

function extractLines(logText) {
  // CI logs are two tab-delimited fields + ISO-8601 timestamp + the actual
  // driver line. Strip the fields and the timestamp so we land at the raw
  // driver line, then collect the note line and the fail line independently.
  const stripped = logText
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, ''))    // 2 tab-fields (run+step)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '')) // ISO timestamp + 1+ spaces
    .map((l) => l.trim());
  let noteGroups = null;
  let failGroups = null;
  for (const l of stripped) {
    if (!noteGroups) noteGroups = l.match(NOTE_RE);
    if (!failGroups) failGroups = l.match(FAIL_RE);
    if (noteGroups && failGroups) break;
  }
  return { noteGroups, failGroups };
}

function normalizedLines({ noteGroups, failGroups }) {
  const out = [];
  if (noteGroups) out.push({ kind: 'note', groups: noteGroups, raw: noteGroups[0], regenerated: expandNote(noteGroups) });
  if (failGroups) out.push({ kind: 'fail', groups: failGroups, raw: failGroups[0], regenerated: expandFail(failGroups) });
  return out;
}

// ── Compare: diff the actual extracted lines against the golden. The
//    golden contains placeholders for drill-run-variant fields ("<N>",
//    "<ID>", "<PHASE>", "<RECIPE>", "<IDLE>"); substitute the captured
//    groups to reproduce the exact raw source log line, then diff. A
//    surface-level drift (extra word, missing word, reorder) shows up as
//    a line mismatch; the regex itself is the deeper validator (a renamed
//    guard phrasing fails the extraction step). ─────────────────────────
function buildExpected(template, m) {
  const [, n, id, phase, recipe, idle] = m;
  const subs = [
    ['<N>', n], ['<ID>', id], ['<PHASE>', phase], ['<RECIPE>', recipe], ['<IDLE>', idle],
  ];
  let s = template;
  for (const [k, v] of subs) s = s.split(k).join(v);
  return s;
}

function compare(actual) {
  const expectedTemplates = expectedLines()
    .filter((l) => !l.startsWith('#'))
    .filter(Boolean);
  const failures = [];
  if (actual.length === 0) {
    failures.push({ kind: 'no-actual', expected: expectedTemplates, actual: '<missing>' });
    return failures;
  }
  if (actual[0].regenerated && expectedTemplates[0]) {
    if (actual[0].regenerated !== buildExpected(expectedTemplates[0], actual[0].groups)) {
      failures.push({ kind: 'mismatch', expected: buildExpected(expectedTemplates[0], actual[0].groups), actual: actual[0].regenerated });
    }
  }
  if (actual[1] && expectedTemplates[1]) {
    if (actual[1].regenerated !== buildExpected(expectedTemplates[1], actual[1].groups)) {
      failures.push({ kind: 'mismatch', expected: buildExpected(expectedTemplates[1], actual[1].groups), actual: actual[1].regenerated });
    }
  } else if (actual[1] && !expectedTemplates[1]) {
    failures.push({ kind: 'extra', expected: '<none>', actual: actual[1].regenerated });
  } else if (!actual[1] && expectedTemplates[1]) {
    failures.push({ kind: 'missing-line', expected: expectedTemplates[1], actual: '<missing>' });
  }
  return failures;
}

// ── Mode 2: --diff <run-id|log-path> — only fetch + compare. ────────────
function fetchJobLog(jobId) {
  const out = gh(['run', 'view', '--job', String(jobId), '--log']);
  return out;
}
function modeDiff(argv) {
  const arg = argv['--diff'];
  if (!arg) { console.error('usage: --diff <verify-live-job-id> | <path-to-log>'); process.exit(2); }
  let log;
  if (arg.includes('/') || arg.includes('\\') || /\.log$/.test(arg)) {
    log = readFileSync(arg, 'utf8');
  } else {
    log = fetchJobLog(arg);
  }
  const parsed = extractLines(log);
  if (!parsed.noteGroups && !parsed.failGroups) {
    fail('no spare-path lines found in the log');
    process.exit(2);
  }
  const norm = normalizedLines(parsed);
  const dr = compare(norm);
  if (dr.length === 0) {
    const idle = parsed.noteGroups?.[5] ?? parsed.failGroups?.[5];
    note(`note line: ${parsed.noteGroups ? 'matched' : 'absent'}`);
    note(`fail line: ${parsed.failGroups ? `matched (idle=${idle}s)` : 'absent'}`);
    ok('spare-path lines match the golden');
    return;
  }
  fail('drift detected against the golden:');
  for (const f of dr) {
    if (f.kind === 'mismatch') console.error(`    - expected: ${f.expected}\n      actual:   ${f.actual}`);
    else if (f.kind === 'extra') console.error(`    - extra unexpected line: ${f.actual}`);
    else if (f.kind === 'missing-line') console.error(`    - missing expected line: ${f.expected}`);
    else if (f.kind === 'no-actual') console.error(`    - no actual lines matched; expected: ${f.expected}`);
  }
  process.exit(1);
}

// ── Mode 1 (default): end-to-end dispatch + touch + extract + compare. ──
async function main() {
  if (process.argv.includes('--diff')) return modeDiff(parseArgv(process.argv));

  // 1. dispatch ci.yml on main
  note('dispatching ci.yml on main (--ref main)');
  const dispatched = gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
  // gh returns the URL of the run on the last line
  const runId = (dispatched.match(/actions\/runs\/(\d+)/) ?? [])[1];
  if (!runId) { fail(`could not parse run id from dispatch output: ${dispatched}`); process.exit(2); }
  note(`dispatched run: ${runId}`);
  await sleep(8_000);

  // 2. poll until verify-live is in_progress
  let jobId = null;
  for (let i = 0; i < 40; i++) {
    const out = ghJson(['run', 'view', String(runId), '--json', 'jobs']);
    const verify = (out.jobs ?? []).find((j) => /Verify deployed/.test(j.name));
    if (verify?.status === 'in_progress') {
      jobId = String(verify.databaseId);
      ok(`verify:live IN_PROGRESS after ${i} polls, job ${jobId}`);
      break;
    }
    await sleep(15_000);
  }
  if (!jobId) { fail('verify:live never went IN_PROGRESS'); process.exit(2); }

  // 3. seed + keep-alive touch (the spare drill shape)
  note('seeding drill-live-session (fresh, <60s idle → GUARD spares it)');
  runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--seed']);
  note('keep-alive touching every 15s through the guard window');
  for (let i = 1; i <= 24; i++) {
    await sleep(15_000);
    const out = runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--touch']).trim();
    console.log(out);
    // Break early if the run has completed.
    const status = gh(['run', 'view', String(runId), '--json', 'status', '--jq', '.status']);
    if (status.includes('completed')) {
      note(`run ${runId} completed (touch cycle ${i})`);
      break;
    }
  }

  // 4. wait for run completion (if not already)
  for (let i = 0; i < 30; i++) {
    const status = gh(['run', 'view', String(runId), '--json', 'status', '--jq', '.status']);
    if (status.includes('completed')) break;
    await sleep(15_000);
  }

  // 5. fetch the verify-live log
  const log = fetchJobLog(jobId);
  writeFileSync('/tmp/vlive-guard-spare-drill.log', log);

  // 6. extract + normalize + compare
  const parsed = extractLines(log);
  if (!parsed.noteGroups && !parsed.failGroups) {
    fail('no spare-path lines found in the verify-live log');
    process.exit(2);
  }
  const norm = normalizedLines(parsed);
  const dr = compare(norm);
  if (dr.length === 0) {
    const idle = parsed.noteGroups?.[5] ?? parsed.failGroups?.[5];
    ok(`spare-path lines match the golden (note=${parsed.noteGroups ? 'present' : 'absent'}, fail=${parsed.failGroups ? 'present' : 'absent'}, idle=${idle}s)`);
  } else {
    fail('drift detected against the golden:');
    for (const f of dr) {
      if (f.kind === 'mismatch') console.error(`    - expected: ${f.expected}\n      actual:   ${f.actual}`);
      else if (f.kind === 'extra') console.error(`    - extra unexpected line: ${f.actual}`);
      else if (f.kind === 'missing-line') console.error(`    - missing expected line: ${f.expected}`);
      else if (f.kind === 'no-actual') console.error(`    - no actual lines matched; expected: ${f.expected.join('\\n')}`);
    }
    process.exit(1);
  }

  // 7. cleanup the session
  note('cleanup: deleting drill-live-session');
  runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--delete']);
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i]] = argv[i + 1];
  }
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
