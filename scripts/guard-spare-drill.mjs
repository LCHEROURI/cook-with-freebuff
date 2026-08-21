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
// Single source of truth for the spare path: the classifier module exports
// SPARED_LIVE_SESSION_SIGNATURE (which verify-live.mjs embeds in the guard's
// fail(...)) and BLOCKING_SESSION_PREFIX (its "blocking the UI starter" head,
// embedded in the guard's note(...)). This comparator's regexes are DERIVED
// from those constants, so a reworded signature updates one place and the
// extraction tracks it automatically — no hard-coded literal to drift. The
// post-drill /api/status assertion below compares the recorded reason field
// against SPARED_LIVE_REASON (the same constant the recorder's Zod enum and
// the /status page derive from), so the live endpoint can never claim a
// reason value the rest of the chain does not recognize.
import {
  BLOCKING_SESSION_PREFIX,
  SPARED_LIVE_REASON,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';
import { renderNoteLine, renderSpareFailLine } from './drill-evidence-render.mjs';

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
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOTE_RE = new RegExp(`^\\s*-\\s+owner has (\\d+) ${escapeRegExp(BLOCKING_SESSION_PREFIX)} — archiving and retrying once: ([A-Za-z0-9-]+)… \\(([^,]+), ([^,]+), (\\d+)s idle\\)`);
const FAIL_RE = new RegExp(`^\\s*✗ FAIL:\\s+owner still has (\\d+) ${escapeRegExp(SPARED_LIVE_SESSION_SIGNATURE)}: ([A-Za-z0-9-]+)… \\(([^,]+), ([^,]+), (\\d+)s idle\\)`);

function normalize(line, re) {
  const m = line.match(re);
  if (!m) return null;
  return m;
}

// Regenerate the exact raw source log line from the captured groups through
// the SHARED renderer module (drill-evidence-render.mjs) — the same code path
// the goldens' source-template derivation uses, so the comparator and the
// golden can never drift apart. Drift detection: if the source fail(...)
// message changes wording, the regex breaks the extraction step above (so we
// fail-fast). If whitespace or order shifts, the substituted line differs
// from the raw log line and `compare` reports it. Either way, the golden is
// the canonical shape.
function expandNote(m) {
  const [, n, id, phase, recipe, idle] = m;
  return renderNoteLine({ n, id, phase, recipe, idle });
}
function expandFail(m) {
  const [, n, id, phase, recipe, idle] = m;
  return renderSpareFailLine({ n, id, phase, recipe, idle });
}

function extractLines(logText) {
  // CI logs are two tab-delimited fields + ISO-8601 timestamp + the actual
  // driver line. Strip the fields and the timestamp so we land at the raw
  // driver line, then collect the note line and the fail line independently.
  const stripped = logText
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, ''))
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, ''))
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
  const expectedTemplates = expectedLines().filter((l) => !l.startsWith('#')).filter(Boolean);
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

function fetchJobLog(jobId) {
  return gh(['run', 'view', '--job', String(jobId), '--log']);
}

// The verify-live driver prints its final RESULT line LAST (in the finally
// block after every stage, so any sub-driver RESULT output appears earlier).
// The LAST `RESULT: FAIL (N)` match is therefore the run's OWN failure
// count: 1 for a spare-only run, >= 2 for a MIXED run (spare + a
// co-occurring failure like a voice-driver flake), or 'crash' when the
// driver itself crashed. The count drives the reason assertion below:
// a spare-only failure MUST record the spared reason (a missing reason
// there is a real guard regression — the classifier/recorder broke), while
// a mixed run MUST record NO reason (the no-mask rule — the classifier
// refuses to label a run that also carries a real failure). The spare
// evidence itself was already proven by the golden diff; the mixed case is
// reported separately instead of reddening the drill.
function failureCountFromLog(logText) {
  const matches = [...logText.matchAll(/RESULT: FAIL \((\d+|crash)\)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1];
  return last === 'crash' ? 'crash' : Number(last);
}

// ── Live-reason assertion: the drill's reason must reach the DEPLOYED
//    endpoint, not just the log. After the golden match, mint a real owner
//    token (custom token → identitytoolkit, the same exchange verify-live.mjs
//    uses), GET the public /api/status route, and assert the recorded
//    verifyLive.reason against the failure count derived from the log. The
//    runUrl cross-check is load-bearing: /api/status reads the single-slot
//    deploy_status/verify_live doc, and a CONCURRENT ci.yml run (e.g. the
//    weekly boundary drill, or a push) can overwrite it after our drill
//    finished — asserting the runUrl belongs to THIS run first means a stale
//    or foreign record fails the drill instead of falsely passing it. ────────
async function assertLiveStatusReason(runId, failureCount) {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const OWNER_UID = process.env.APP_OWNER_UID;
  if (!SA_JSON || !API_KEY || !OWNER_UID) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT + NEXT_PUBLIC_FIREBASE_API_KEY + APP_OWNER_UID required for the /api/status reason assertion');
  }
  const sa = JSON.parse(SA_JSON);
  const app = getApps()[0] ?? initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'),
    }),
  });
  const customToken = await getAuth(app).createCustomToken(OWNER_UID);
  const exchange = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const idToken = (await exchange.json().catch(() => ({})))?.idToken;
  if (!idToken) throw new Error(`owner token exchange failed (HTTP ${exchange.status})`);
  const APP = (process.env.VERIFY_BASE_URL ?? 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app').replace(/\/$/, '');
  const res = await fetch(`${APP}/api/status`, {
    headers: { authorization: `Bearer ${idToken}` },
  });
  const body = await res.json().catch(() => ({}));
  const v = body?.verifyLive;
  if (!v) throw new Error(`/api/status returned no verifyLive record (HTTP ${res.status})`);
  if (typeof v.runUrl !== 'string' || !v.runUrl.includes(`/runs/${runId}`)) {
    throw new Error(`recorded runUrl ${v.runUrl ?? '<none>'} is not the drill run ${runId} — a concurrent run overwrote the record; cannot assert the live reason`);
  }
  if (failureCount === 1) {
    // Spare-ONLY failure: the classifier must have recorded the spared
    // reason. A missing/foreign reason here is a REAL guard regression —
    // red the drill exactly as before.
    if (v.reason !== SPARED_LIVE_REASON) {
      throw new Error(`/api/status reason is ${JSON.stringify(v.reason)}, expected the exported SPARED_LIVE_REASON constant (${SPARED_LIVE_REASON})`);
    }
    ok(`live /api/status: verifyLive.reason === SPARED_LIVE_REASON (${v.reason}) for run ${runId}`);
    return;
  }
  if (typeof failureCount === 'number' && failureCount >= 2) {
    // MIXED run: the spare sits next to a co-occurring failure (e.g. a
    // voice-driver flake). The no-mask rule REQUIRES reason to be null
    // here — a spared reason next to a real failure would mask it. The
    // spare evidence was already proven by the golden diff; report it
    // separately instead of reddening the drill.
    if (v.reason !== undefined && v.reason !== null) {
      throw new Error(`no-mask violation: mixed-failure run (${failureCount} failures) recorded reason ${JSON.stringify(v.reason)} — sparing masked a real failure`);
    }
    note(`run carried ${failureCount} failures (spare + ${failureCount - 1} co-occurring) — reason correctly null per the no-mask rule`);
    ok(`live /api/status: mixed-failure run (${failureCount} failures) — spare evidence proven separately (reason=${v.reason ?? 'null'}) for run ${runId}`);
    return;
  }
  // failureCount is 'crash' or null (unparseable): the run did not
  // complete a clean failure set, so the mixed-path exemption cannot be
  // claimed. Stay conservative — require the spared reason exactly as a
  // spare-only run would.
  if (v.reason !== SPARED_LIVE_REASON) {
    throw new Error(`/api/status reason is ${JSON.stringify(v.reason)}, expected the exported SPARED_LIVE_REASON constant (${SPARED_LIVE_REASON})`);
  }
  ok(`live /api/status: verifyLive.reason === SPARED_LIVE_REASON (${v.reason}) for run ${runId}`);
}
function modeDiff(argv) {
  const arg = argv['--diff'];
  if (!arg) { console.error('usage: --diff <verify-live-job-id> | <path-to-log>'); process.exit(2); }
  let log;
  if (arg.includes('/') || arg.includes('\\') || /\.log$/.test(arg)) log = readFileSync(arg, 'utf8');
  else log = fetchJobLog(arg);
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

  note('dispatching ci.yml on main (--ref main)');
  gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
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
    process.exitCode = 2; return;
  }
  note(`dispatched run: ${runId}`);

  try {
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
    if (!jobId) { fail('verify:live never went IN_PROGRESS'); process.exitCode = 2; return; }

    note('seeding drill-live-session (fresh, <60s idle → GUARD spares it)');
    // Delete-first (idempotent): a leaked session from a failed run — cleanup
    // previously ran only on the happy path, so a reason-assertion failure
    // left the doc ACTIVE and the next seed died with "already exists — delete
    // first" (nightly re-run 32482323556). --delete tolerates absence, so a
    // stale drill session self-heals here instead of blocking the dispatch.
    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--delete']);
    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--seed']);
    note('keep-alive touching every 15s through the guard window');
    for (let i = 1; i <= 24; i++) {
      await sleep(15_000);
      const out = runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--touch']).trim();
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
    writeFileSync('/tmp/vlive-guard-spare-drill.log', log);

    const parsed = extractLines(log);
    if (!parsed.noteGroups && !parsed.failGroups) {
      fail('no spare-path lines found in the verify-live log');
      process.exitCode = 2; return;
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
      process.exitCode = 1; return;
    }

    // The drill is not complete until the DEPLOYED endpoint reports the reason
    // it just produced. Run the live assertion only after the log golden
    // matched, so a log-shaped failure exits 1/2 before this step. The failure
    // count derived from the log's RESULT line tells the assertion whether the
    // run was spare-only (reason MUST be the spared constant) or mixed with a
    // co-occurring failure (reason MUST be null per the no-mask rule).
    await assertLiveStatusReason(runId, failureCountFromLog(log));
  } finally {
    note('cleanup: deleting drill-live-session');
    try {
      runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--delete']);
    } catch (e) { note(`cleanup: ${e.message?.slice(0, 80) ?? e}`); }
  }
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i]] = argv[i + 1];
  }
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });