#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/guard-regression-drill.mjs — end-to-end spare + SIMULATED
// regression drill comparator (the no-mask proof).
//
// The third drill exercises the classifier's no-mask guarantee: dispatch
// ci.yml with force_verify_live_regression=true, keep a seeded
// drill-live-session alive through the guard window (<60s idle → GUARD
// spares), so the verify:live run carries TWO failures — the spare and the
// seam's SIMULATED regression. The classifier must record
// verdict=failure with reason=null for that shape.
//
// Mode 1 (default): dispatches ci.yml on `main` with
// force_verify_live_regression=true, keeps the session fresh, downloads the
// verify:live job log, extracts the four evidence lines (NOTE, spare-FAIL,
// seam-FAIL, RESULT count), normalizes them, diffs them against the
// committed golden (`scripts/__golden__/guard-regression-drill.txt`), and —
// if the log matches — reads the recorded deploy_status/verify_live doc to
// assert verdict=failure with NO reason (the no-mask property, end to end).
// Exits 0 on match, 1 on drift, 2 on missing/unparseable lines/infra fault.
//
// Mode 2 (--diff <run-id-or-log>): skip dispatch + touching + the Firestore
// assertion; fetch (or read) the log and just run the line compare. Useful
// for replaying the comparison against a known-good run without re-running
// the drill.
//
// The script assumes APP_OWNER_UID + FIREBASE_SERVICE_ACCOUNT are loaded
// from ./.env.local (mirrors the drill-live-session helper), and uses the
// existing driver CLI (gh) for run/job lookups and log fetch.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Single source of truth for the drill's evidence shape: the classifier
// module exports SIMULATED_REGRESSION_SIGNATURE (the seam's fail(...) message),
// SPARED_LIVE_SESSION_SIGNATURE (embedded in the guard's fail(...)), and
// BLOCKING_SESSION_PREFIX (the guard's note(...) head). This comparator's
// regexes are DERIVED from those constants, so a reworded message updates
// one place and the extraction tracks it automatically — no hard-coded
// literals to drift.
import {
  BLOCKING_SESSION_PREFIX,
  SIMULATED_REGRESSION_SIGNATURE,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';
import {
  renderNoteLine,
  renderResultLine,
  renderSeamFailLine,
  renderSpareFailLine,
} from './drill-evidence-render.mjs';

const ROOT = resolve(process.cwd());
const GOLDEN = resolve(ROOT, 'scripts/__golden__/guard-regression-drill.txt');
// Node-time check: the <N> count, idle, and other drill-run variants must not
// rewrite the golden's static shape. Any drift below is a script bug, not a
// guard regression.
const FIXED_TOKENS = ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); };
const note = (m) => console.log(`  - ${m}`);

// ── .env.local loader (mirrors drill-live-session.mjs so credentials are
//    available for the seed + touch helpers and the Firestore assertion). ──
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
function readGolden() {
  if (!existsSync(GOLDEN)) throw new Error(`missing golden: ${GOLDEN}`);
  return readFileSync(GOLDEN, 'utf8').split('\n');
}
function expectedLines() {
  // Strip the leading comment block so a future contributor-friendly header
  // change doesn't show as drift.
  return readGolden().filter((l) => !l.startsWith('#'));
}

// ── Log parser: extract the four evidence lines from the verify:live log
//    and normalize the drill-run-variant fields to the FIXED_TOKENS. ─────
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOTE_RE = new RegExp(`^\\s*-\\s+owner has (\\d+) ${escapeRegExp(BLOCKING_SESSION_PREFIX)} — archiving and retrying once: ([A-Za-z0-9-]+)… \\(([^,]+), ([^,]+), (\\d+)s idle\\)`);
const SPARE_FAIL_RE = new RegExp(`^\\s*✗ FAIL:\\s+owner still has (\\d+) ${escapeRegExp(SPARED_LIVE_SESSION_SIGNATURE)}: ([A-Za-z0-9-]+)… \\(([^,]+), ([^,]+), (\\d+)s idle\\)`);
// The seam's fail() message is fully static — no drill-run variants. The
// regex is DERIVED from the exported SIMULATED_REGRESSION_SIGNATURE (single
// source of truth shared with verify-live.mjs's seam), so a reworded seam
// message updates one constant and this regex tracks it automatically. The
// golden still carries the literal and the codegen contract pins golden ===
// the constant, so the human-readable file can't drift either.
const SEAM_FAIL_RE = new RegExp(`^\\s*✗ FAIL:\\s+${escapeRegExp(SIMULATED_REGRESSION_SIGNATURE)}$`);
// The RESULT count line proves exactly TWO failures (spare + seam). A third
// unexpected failure changes the count and breaks the diff — the no-mask
// shape must stay exactly two.
const RESULT_RE = /^\s*RESULT: FAIL \((\d+)\)$/;

function extractLines(logText) {
  // CI logs are two tab-delimited fields + ISO-8601 timestamp + the actual
  // driver line. Strip the fields and the timestamp so we land at the raw
  // driver line, then collect each evidence line independently.
  const stripped = logText
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, ''))    // 2 tab-fields (run+step)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '')) // ISO timestamp + 1+ spaces
    .map((l) => l.trim());
  const groups = { note: null, spareFail: null, seamFail: null, result: null };
  for (const l of stripped) {
    if (!groups.note) groups.note = l.match(NOTE_RE);
    if (!groups.spareFail) groups.spareFail = l.match(SPARE_FAIL_RE);
    if (!groups.seamFail) groups.seamFail = l.match(SEAM_FAIL_RE);
    if (!groups.result) groups.result = l.match(RESULT_RE);
    if (groups.note && groups.spareFail && groups.seamFail && groups.result) break;
  }
  return groups;
}

function normalizedLines(groups) {
  // Regenerate every evidence line through the SHARED renderer module
  // (drill-evidence-render.mjs) — the same code path the goldens' source-
  // template derivation uses. Regenerating (rather than echoing the raw
  // line) proves the captured groups re-render to the canonical shape, so
  // a regex-group drift or a renderer/golden divergence fails here instead
  // of only surfacing as a raw-line diff.
  const out = [];
  if (groups.note) {
    const [, n, id, phase, recipe, idle] = groups.note;
    out.push({ kind: 'note', groups: groups.note, raw: groups.note[0], regenerated: renderNoteLine({ n, id, phase, recipe, idle }) });
  }
  if (groups.spareFail) {
    const [, n, id, phase, recipe, idle] = groups.spareFail;
    out.push({ kind: 'spareFail', groups: groups.spareFail, raw: groups.spareFail[0], regenerated: renderSpareFailLine({ n, id, phase, recipe, idle }) });
  }
  if (groups.seamFail) {
    out.push({ kind: 'seamFail', groups: groups.seamFail, raw: groups.seamFail[0], regenerated: renderSeamFailLine() });
  }
  if (groups.result) {
    const [, count] = groups.result;
    out.push({ kind: 'result', groups: groups.result, raw: groups.result[0], regenerated: renderResultLine(count) });
  }
  return out;
}

// Substitute the captured groups into the golden template so it reproduces
// the exact raw source log line. Static lines (seam FAIL, RESULT) carry no
// placeholders, so the substitution is a no-op there.
function buildExpected(template, m) {
  const [, n, id, phase, recipe, idle] = m;
  const subs = [
    ['<N>', n], ['<ID>', id], ['<PHASE>', phase], ['<RECIPE>', recipe], ['<IDLE>', idle],
  ];
  let s = template;
  for (const [k, v] of subs) if (v !== undefined) s = s.split(k).join(v);
  return s;
}

function compare(actual) {
  const expectedTemplates = expectedLines().filter(Boolean);
  const failures = [];
  if (actual.length === 0) {
    failures.push({ kind: 'no-actual', expected: expectedTemplates, actual: '<missing>' });
    return failures;
  }
  for (let i = 0; i < Math.max(actual.length, expectedTemplates.length); i++) {
    const actualLine = actual[i];
    const expectedTemplate = expectedTemplates[i];
    if (actualLine && expectedTemplate) {
      const expected = buildExpected(expectedTemplate, actualLine.groups);
      if (actualLine.regenerated !== expected) {
        failures.push({ kind: 'mismatch', expected, actual: actualLine.regenerated });
      }
    } else if (actualLine && !expectedTemplate) {
      failures.push({ kind: 'extra', expected: '<none>', actual: actualLine.regenerated });
    } else if (!actualLine && expectedTemplate) {
      failures.push({ kind: 'missing-line', expected: expectedTemplate, actual: '<missing>' });
    }
  }
  return failures;
}

function fetchJobLog(jobId) {
  return gh(['run', 'view', '--job', String(jobId), '--log']);
}

// ── No-mask assertion: the drill's whole point. With TWO failures the
//    recorded verdict must be failure with NO reason — sparing must never
//    mask a genuine failure next to it. Read the recorded doc the drill's
//    own recorder step wrote (last-write-wins; our drill is the latest
//    ci.yml dispatch in the sequential weekly chain, so its record is the
//    freshest write — cross-checked via runUrl). ────────────────────────
async function assertRecordedNoMask(runId) {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!SA_JSON) throw new Error('FIREBASE_SERVICE_ACCOUNT required for the no-mask assertion');
  const sa = JSON.parse(SA_JSON);
  const app = getApps()[0] ?? initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'),
    }),
  });
  const db = getFirestore(app);
  const snap = await db.collection('deploy_status').doc('verify_live').get();
  if (!snap.exists) throw new Error('deploy_status/verify_live missing after the drill — the recorder step did not write');
  const d = snap.data();
  if (typeof d.runUrl !== 'string' || !d.runUrl.includes(`/runs/${runId}`)) {
    throw new Error(`recorded runUrl ${d.runUrl ?? '<none>'} is not the drill run ${runId} — a concurrent run overwrote the record; cannot assert no-mask`);
  }
  if (d.verdict !== 'failure') {
    throw new Error(`expected recorded verdict 'failure', got '${d.verdict}'`);
  }
  if (d.reason !== undefined && d.reason !== null) {
    throw new Error(`no-mask violation: reason '${d.reason}' recorded with 2 failures — sparing masked a real regression`);
  }
  ok(`no-mask: recorded verdict=failure, reason=${d.reason ?? 'null'} for run ${runId}`);
}

function modeDiff(argv) {
  const arg = argv['--diff'];
  if (!arg) { console.error('usage: --diff <verify-live-job-id> | <path-to-log>'); process.exit(2); }
  let log;
  if (arg.includes('/') || arg.includes('\\') || /\.log$/.test(arg)) log = readFileSync(arg, 'utf8');
  else log = fetchJobLog(arg);
  const parsed = extractLines(log);
  if (!parsed.note && !parsed.spareFail && !parsed.seamFail) {
    fail('no spare+regression lines found in the log');
    process.exit(2);
  }
  const norm = normalizedLines(parsed);
  const dr = compare(norm);
  if (dr.length === 0) {
    note(`note line: ${parsed.note ? 'matched' : 'absent'}`);
    note(`spare-fail line: ${parsed.spareFail ? 'matched' : 'absent'}`);
    note(`seam-fail line: ${parsed.seamFail ? 'matched' : 'absent'}`);
    note(`result line: ${parsed.result ? `FAIL (${parsed.result[1]})` : 'absent'}`);
    ok('regression-path lines match the golden');
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

async function main() {
  if (process.argv.includes('--diff')) return modeDiff(parseArgv(process.argv));

  // Snapshot existing dispatch runs before triggering CI. Without this guard,
  // `gh run list --limit 1` can return a stale earlier workflow_dispatch run
  // while GitHub is still indexing the run we just created.
  const beforeDispatch = ghJson([
    'run', 'list',
    '--workflow', 'ci.yml',
    '--branch', 'main',
    '--event', 'workflow_dispatch',
    '--limit', '20',
    '--json', 'databaseId',
  ]);
  const existingRunIds = new Set((beforeDispatch ?? []).map((r) => String(r.databaseId)));
  const dispatchedAfter = Date.now() - 2_000;

  note('dispatching ci.yml on main with force_verify_live_regression=true (--ref main)');
  gh(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'force_verify_live_regression=true']);
  await sleep(5_000);

  let runId = null;
  for (let i = 0; i < 12; i++) {
    const runs = ghJson([
      'run', 'list',
      '--workflow', 'ci.yml',
      '--branch', 'main',
      '--event', 'workflow_dispatch',
      '--limit', '20',
      '--json', 'databaseId,status,createdAt',
    ]);
    const fresh = (runs ?? []).find((run) => {
      if (!run?.databaseId || existingRunIds.has(String(run.databaseId))) return false;
      const created = Date.parse(run.createdAt ?? '');
      return Number.isFinite(created) && created >= dispatchedAfter;
    });
    if (fresh?.databaseId) {
      runId = String(fresh.databaseId);
      break;
    }
    await sleep(5_000);
  }
  if (!runId) {
    fail('workflow dispatched but the new ci.yml run could not be located');
    process.exit(2);
  }
  note(`dispatched run: ${runId}`);

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

  note('seeding drill-live-session (fresh, <60s idle → GUARD spares it)');
  runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--seed']);
  note('keep-alive touching every 15s through the guard window');
  for (let i = 1; i <= 24; i++) {
    await sleep(15_000);
    const out = runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--touch']).trim();
    console.log(out);
    const status = gh(['run', 'view', String(runId), '--json', 'status', '--jq', '.status']);
    if (status.includes('completed')) {
      note(`run ${runId} completed (touch cycle ${i})`);
      break;
    }
  }

  for (let i = 0; i < 30; i++) {
    const status = gh(['run', 'view', String(runId), '--json', 'status', '--jq', '.status']);
    if (status.includes('completed')) break;
    await sleep(15_000);
  }

  const log = fetchJobLog(jobId);
  writeFileSync('/tmp/vlive-guard-regression-drill.log', log);

  const parsed = extractLines(log);
  if (!parsed.note && !parsed.spareFail && !parsed.seamFail) {
    fail('no spare+regression lines found in the verify-live log');
    process.exit(2);
  }
  const norm = normalizedLines(parsed);
  const dr = compare(norm);
  if (dr.length === 0) {
    ok(`regression-path lines match the golden (note=${parsed.note ? 'present' : 'absent'}, spare-fail=${parsed.spareFail ? 'present' : 'absent'}, seam-fail=${parsed.seamFail ? 'present' : 'absent'}, result=${parsed.result ? `FAIL (${parsed.result[1]})` : 'absent'})`);
  } else {
    fail('drift detected against the golden:');
    for (const f of dr) {
      if (f.kind === 'mismatch') console.error(`    - expected: ${f.expected}\n      actual:   ${f.actual}`);
      else if (f.kind === 'extra') console.error(`    - extra unexpected line: ${f.actual}`);
      else if (f.kind === 'missing-line') console.error(`    - missing expected line: ${f.expected}`);
      else if (f.kind === 'no-actual') console.error(`    - no actual lines matched; expected: ${f.expected.join('\n')}`);
    }
    process.exit(1);
  }

  // The no-mask proof, end to end: the recorded doc must show verdict=failure
  // with NO reason — with two failures the classifier must not label the run
  // as spared.
  await assertRecordedNoMask(runId);

  note('cleanup: deleting drill-live-session (spared → still ACTIVE)');
  try {
    runNodeWithEnv(resolve(ROOT, '.freebuff/drill-live-session.mjs'), ['--delete']);
  } catch (e) { note(`cleanup: ${e.message?.slice(0, 80) ?? e}`); }
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i]] = argv[i + 1];
  }
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
