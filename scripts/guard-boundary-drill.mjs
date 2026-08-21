#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/guard-boundary-drill.mjs — end-to-end guard-boundary drill
// comparator (mirror of scripts/guard-spare-drill.mjs).
//
// The boundary drill verifies the corrective path of the pre-stage guard:
// a session whose `lastActivityAt` sits just past LIVE_SESSION_GRACE_MS
// (60s) gets ARCHIVED on the retry, the next read is clean, and the run
// proceeds normally — no FAIL line, and the verifyLive verdict is PASS
// with reason === null. This script exercises that path end to end:
//
// Mode 1 (default): dispatches a ci.yml run on `main`, backdates a seeded
// drill-live-session to ~65s idle every ~15s through the guard window,
// downloads the verify-live job log, extracts the two boundary-path lines
// (NOTE + ARCHIVED-OK), normalizes them, and diffs them against the
// committed golden file (`scripts/__golden__/guard-boundary-drill.txt`).
// Exits 0 on match, 1 on drift, 2 on missing/unparseable lines.
//
// Mode 2 (--diff <run-id-or-log>): skip dispatch + backdating; fetch (or
// read) the log and just run the compare. Useful for replaying the
// comparison against a known-good run without re-running the drill.
//
// The script assumes APP_OWNER_UID + FIREBASE_SERVICE_ACCOUNT are loaded
// from ./.env.local (mirrors the drill-live-session helper), and uses the
// existing driver CLI (gh) for run/job lookups and log fetch.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Single source of truth for the NOTE line's shared prefix: the classifier
// module derives BLOCKING_SESSION_PREFIX from SPARED_LIVE_SESSION_SIGNATURE
// (which verify-live.mjs embeds in both the guard's note(...) and fail(...)).
// This comparator's NOTE_RE is built from that constant so a reworded
// signature updates the extraction automatically.
import { BLOCKING_SESSION_PREFIX, SPARED_LIVE_REASON } from './verify-live-classify.mjs';
import { renderArchiveOkLine, renderNoteLine } from './drill-evidence-render.mjs';

const ROOT = resolve(process.cwd());
const GOLDEN = resolve(ROOT, 'scripts/__golden__/guard-boundary-drill.txt');
// Boundary target: idle just past the 60s LIVE_SESSION_GRACE_MS. 65s gives
// the retry a clean transaction while still being unambiguously past the
// grace (a yank between the list read and the archive write would also
// spill to 65s — same fixed target). 60s exactly is too tight: a single
// ms of skew lands inside the grace and converts the drill into a spare.
const TARGET_IDLE_SECONDS = 65;
// Node-time check: the <N> count, idle, and other drill-run variants must not
// rewrite the golden's static shape. Any drift below is a script bug, not a
// guard regression.
const FIXED_TOKENS = ['<N>', '<ID>', '<PHASE>', '<RECIPE>', '<IDLE>'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); };
const note = (m) => console.log(`  - ${m}`);

// ── .env.local loader (mirrors drill-live-session.mjs so credentials are
//    available for the seed + backdate helpers). ─────────────────────────
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

// ── Log parser: extract the two boundary-path lines from the verify:live
//    log and normalize the drill-run-variant fields to the FIXED_TOKENS.
//    Boundary shape = NOTE (idle 65-70s) + ARCHIVED-OK (no FAIL). The
//    NOTE_RE is identical to the spare comparator's — the guard prints
//    it unconditionally on a blocker. The second regex matches the
//    archive-path OK line; a FAIL line is NOT expected here, the absence
//    is what proves the corrective path took the retry. ───────────────
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOTE_RE = new RegExp(`^\\s*-\\s+owner has (\\d+) ${escapeRegExp(BLOCKING_SESSION_PREFIX)} — archiving and retrying once: ([A-Za-z0-9-]+)… \\(([^,]+), ([^,]+), (\\d+)s idle\\)`);
// The archive-OK line carries no spare signature text ("archived N blocking
// session(s) — retried, owner is clean") — a distinct corrective-path message.
// The REGEX is derived from the shared renderer's output shape via the same
// escapeRegExp trick as NOTE_RE, so a reworded archive message updates the
// renderer and this regex tracks it (the boundary drill's test pins the
// renderer → golden lockstep).
const OK_RE = new RegExp(`^\\s*✓\\s+archived (\\d+) blocking session\\(s\\) — retried, owner is clean before the UI starter`);

function normalize(line, re) {
  const m = line.match(re);
  if (!m) return null;
  return m;
}

// Substitute the captured groups into the golden template so it reproduces
// the exact raw source log line. Drift detection: if the source note(...)
// or ok(...) line changes wording, the regex breaks the extraction step
// above (so we fail-fast). If whitespace or order shifts, the substituted
// line differs from the raw log line and `compare` reports it. Either way,
// the golden is the canonical shape.
function expandNote(m) {
  const [, n, id, phase, recipe, idle] = m;
  return renderNoteLine({ n, id, phase, recipe, idle });
}
function expandOk(m) {
  const [, n] = m;
  return renderArchiveOkLine({ n });
}

function extractLines(logText) {
  // CI logs are two tab-delimited fields + ISO-8601 timestamp + the actual
  // driver line. Strip the fields and the timestamp so we land at the raw
  // driver line, then collect the note line and the archive-OK line
  // independently.
  const stripped = logText
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, ''))    // 2 tab-fields (run+step)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '')) // ISO timestamp + 1+ spaces
    .map((l) => l.trim());
  let noteGroups = null;
  let okGroups = null;
  for (const l of stripped) {
    if (!noteGroups) noteGroups = l.match(NOTE_RE);
    if (!okGroups) okGroups = l.match(OK_RE);
    if (noteGroups && okGroups) break;
  }
  return { noteGroups, okGroups };
}

function normalizedLines({ noteGroups, okGroups }) {
  const out = [];
  if (noteGroups) out.push({ kind: 'note', groups: noteGroups, raw: noteGroups[0], regenerated: expandNote(noteGroups) });
  if (okGroups) out.push({ kind: 'ok', groups: okGroups, raw: okGroups[0], regenerated: expandOk(okGroups) });
  return out;
}

// ── Compare: diff the actual extracted lines against the golden. The
//    golden contains placeholders for drill-run-variant fields ("<N>",
//    "<ID>", "<PHASE>", "<RECIPE>", "<IDLE>"); substitute the captured
//    groups to reproduce the exact raw source log line, then diff. The
//    archive-OK template is the same shape ("<N>" only — no other
//    variant fields) so the placeholder-substitution loop is harmless
//    on it. A surface-level drift (extra word, missing word, reorder)
//    shows up as a line mismatch; the regex itself is the deeper
//    validator (a renamed guard phrasing fails the extraction step). ──
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

// ── Failure count: the boundary path expects RESULT: PASS (clean run,
//    verdict=success). A co-occurring flake produces RESULT: FAIL (N).
//    The count tells the live assertion whether this was a clean boundary
//    run (verdict MUST be success) or a mixed run (boundary evidence was
//    perfect but an unrelated failure reddened the run). ──────────────────
function failureCountFromLog(logText) {
  const matches = [...logText.matchAll(/RESULT: FAIL \((\d+|crash)\)/g)];
  if (matches.length === 0) return 0;
  const last = matches[matches.length - 1][1];
  return last === 'crash' ? 'crash' : Number(last);
}

// ── Live-verdict assertion: the boundary drill's evidence is the
//    ARCHIVED-OK line (guard archived and retried). After the golden
//    match, read the deployed /api/status endpoint and assert:
//    - Clean run (failureCount === 0): verdict MUST be success, reason null.
//    - Mixed run (failureCount >= 1): verdict failure, reason null — the
//      boundary evidence was proven by the golden; report separately.
//    - Crash / unparseable: stay conservative, require success.
//    The runUrl cross-check is load-bearing (same as spare drill): a
//    concurrent ci.yml run can overwrite the doc after our drill finishes. ─
async function assertLiveStatusVerdict(runId, failureCount) {
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const OWNER_UID = process.env.APP_OWNER_UID;
  if (!SA_JSON || !API_KEY || !OWNER_UID) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT + NEXT_PUBLIC_FIREBASE_API_KEY + APP_OWNER_UID required for the /api/status verdict assertion');
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
    throw new Error(`recorded runUrl ${v.runUrl ?? '<none>'} is not the drill run ${runId} — a concurrent run overwrote the record; cannot assert the live verdict`);
  }
  if (failureCount === 0) {
    // Clean boundary run: the archive path worked, verify:live went green.
    // The verdict MUST be success with reason null.
    if (v.verdict !== 'success') {
      throw new Error(`/api/status verdict is '${v.verdict}', expected 'success' for a clean boundary run`);
    }
    if (v.reason !== undefined && v.reason !== null) {
      throw new Error(`/api/status reason is ${JSON.stringify(v.reason)}, expected null for a clean boundary run`);
    }
    ok(`live /api/status: verdict=success, reason=null for run ${runId}`);
    return;
  }
  if (typeof failureCount === 'number' && failureCount >= 1) {
    // Mixed run: the boundary evidence was proven by the golden diff, but
    // an unrelated co-occurring failure made verify:live red. The verdict
    // MUST be failure with reason null (no-mask rule).
    if (v.verdict !== 'failure') {
      throw new Error(`/api/status verdict is '${v.verdict}', expected 'failure' for a mixed-failure boundary run`);
    }
    if (v.reason !== undefined && v.reason !== null) {
      throw new Error(`no-mask violation: mixed-failure run (${failureCount} failures) recorded reason ${JSON.stringify(v.reason)} — a real failure was masked`);
    }
    note(`run carried ${failureCount} co-occurring failure(s) — boundary evidence proven separately`);
    ok(`live /api/status: mixed-failure run (${failureCount} failures) — boundary evidence separate (verdict=${v.verdict}, reason=${v.reason ?? 'null'}) for run ${runId}`);
    return;
  }
  // failureCount is 'crash' or unparseable: stay conservative — require
  // the clean-run verdict exactly.
  if (v.verdict !== 'success') {
    throw new Error(`/api/status verdict is '${v.verdict}', expected 'success' for a boundary run (unparseable failure count)`);
  }
  ok(`live /api/status: verdict=success for run ${runId} (unparseable failure count treated as clean)`);
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
  if (!parsed.noteGroups && !parsed.okGroups) {
    fail('no boundary-path lines found in the log');
    process.exit(2);
  }
  const norm = normalizedLines(parsed);
  const dr = compare(norm);
  if (dr.length === 0) {
    const idle = parsed.noteGroups?.[5] ?? '?';
    note(`note line: ${parsed.noteGroups ? 'matched' : 'absent'}`);
    note(`archive-ok line: ${parsed.okGroups ? 'matched' : 'absent'}`);
    ok(`boundary-path lines match the golden (idle=${idle}s)`);
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

// ── Mode 1 (default): end-to-end dispatch + backdate + extract + compare.
async function main() {
  if (process.argv.includes('--diff')) return modeDiff(parseArgv(process.argv));

  // 1. dispatch ci.yml on main
  note('dispatching ci.yml on main (--ref main)');
  const dispatched = gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
  // gh returns the URL of the run on the last line
  const runId = (dispatched.match(/actions\/runs\/(\d+)/) ?? [])[1];
  if (!runId) { fail(`could not parse run id from dispatch output: ${dispatched}`); process.exitCode = 2; return; }
  note(`dispatched run: ${runId}`);
  await sleep(8_000);

  try {
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
    if (!jobId) { fail('verify:live never went IN_PROGRESS'); process.exitCode = 2; return; }

    // 3. seed + backdate loop (the boundary drill shape: idle just past 60s
    //    so the guard's archive path accepts the session immediately).
    note(`seeding drill-live-session + backdating to ${TARGET_IDLE_SECONDS}s idle (boundary: GUARD archives)`);
    // Delete-first (idempotent): a leaked session from a failed run must never
    // block the next seed — --delete tolerates absence, so a stale drill
    // session self-heals here instead of dying with "already exists — delete
    // first" (nightly re-run 32482323556).
    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--delete']);
    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--seed']);
    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--backdate', String(TARGET_IDLE_SECONDS)]);
    note(`keep-alive backdating every 15s through the guard window (target idle ≈ ${TARGET_IDLE_SECONDS}s)`);
    for (let i = 1; i <= 24; i++) {
      await sleep(15_000);
      const out = runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--backdate', String(TARGET_IDLE_SECONDS)]).trim();
      console.log(out);
      // Break early if the run has completed.
      const status = gh(['run', 'view', String(runId), '--json', 'status', '--jq', '.status']);
      if (status.includes('completed')) {
        note(`run ${runId} completed (backdate cycle ${i})`);
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
    writeFileSync('/tmp/vlive-guard-boundary-drill.log', log);

    // 6. extract + normalize + compare
    const parsed = extractLines(log);
    if (!parsed.noteGroups && !parsed.okGroups) {
      fail('no boundary-path lines found in the verify-live log');
      process.exitCode = 2; return;
    }
    const norm = normalizedLines(parsed);
    const dr = compare(norm);
    if (dr.length === 0) {
      const idle = parsed.noteGroups?.[5] ?? '?';
      ok(`boundary-path lines match the golden (note=${parsed.noteGroups ? 'present' : 'absent'}, archive-ok=${parsed.okGroups ? 'present' : 'absent'}, idle=${idle}s)`);

      // The drill is not complete until the DEPLOYED endpoint reports the
      // verdict it just produced. A clean boundary run (RESULT: PASS, no
      // failures) MUST show verdict=success. A co-occurring flake (RESULT:
      // FAIL (N)) MUST show verdict=failure with reason=null — the boundary
      // evidence was already proven by the golden; the drill passes and
      // reports it separately instead of reddening.
      await assertLiveStatusVerdict(runId, failureCountFromLog(log));
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
  } finally {
    // 7. cleanup the session if it's still around (a successful archive
    //    moves it to ABANDONED — the helper's --delete handles that).
    //    try/finally ensures cleanup runs even when assertions fail.
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
