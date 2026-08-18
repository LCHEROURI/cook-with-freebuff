#!/usr/bin/env node
// ============================================================================
// scripts/verify-live-emulator.mjs — run the deterministic guided-flow check
// against the LOCAL Firestore + Auth emulators, never touching production.
//
// Why this exists: verify-live.mjs proves the DEPLOYED stack, but that means
// real Firestore reads/writes and a real identitytoolkit exchange on every
// run. This driver runs the SAME check offline:
//
//   1. Boots the Firestore (8080) + Auth (9099) emulators — reusing them if
//      they are already running (e.g. `npm run emulators` in another
//      terminal) so a second `verify:live:emulator` never fights for ports.
//   2. Reuses an emulator-pointed `next dev` server if one is already running
//      (detected via /api/build-info's `emulator: true`), else boots one with
//      FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST exported, so the
//      app's server-side admin SDK points at the emulators instead of the
//      real project (lib/server/admin.ts already branches on
//      FIRESTORE_EMULATOR_HOST).
//   3. Runs `node scripts/verify-live.mjs --app http://localhost:<port>
//      --emulator`, which mints a demo owner in the auth emulator, seeds a
//      recipe in the Firestore emulator, and drives the guided flow
//      (launch → prep steps → safety gate → timer) plus the deterministic
//      pantry turns (add → confirm → query → remove — no model dependency)
//      with zero production traffic. The Gemini/Chrome/live-host stages are
//      skipped in emulator mode (they are production-only), so the check is
//      fast and offline.
//   4. ALWAYS tears down the processes it started (dev server + emulators,
//      unless the emulators were reused). Exit code mirrors verify-live
//      (0 = PASS, 1 = FAIL).
//
// Usage:
//   npm run verify:live:emulator
//   VERIFY_EMULATOR_PORT=3200 npm run verify:live:emulator
//
// Notes:
//   - No .env.local, service account, or Gemini key is required — the
//     emulator run is self-contained.
//   - The Firestore emulator requires Java 21+ (see the README).
// ============================================================================

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const DEV_PORT = Number(process.env.VERIFY_EMULATOR_PORT ?? 3200);
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
const OWNER_UID = process.env.VERIFY_EMULATOR_OWNER_UID || 'verify-live-emulator-owner';
const EMULATOR_PROJECT = 'demo-cook-with-freebuff';
let BASE = `http://localhost:${DEV_PORT}`;

const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  - ${m}`);
const fail = (m) => { console.log(`  ✗ FAIL: ${m}`); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Small helpers ────────────────────────────────────────────────────────────
function portInUse(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; res(v); } };
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
    s.setTimeout(1_000, () => { s.destroy(); done(false); });
  });
}

async function waitForPort(port, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await sleep(1_000);
  }
  return false;
}

async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(4_000) });
      if (res.status >= 200 && res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(2_000);
  }
  return false;
}

// ── 1. Emulators: reuse if already running, else boot fresh ────────────────
const [fsPort] = FIRESTORE_HOST.split(':').slice(-1).map(Number);
const [authPort] = AUTH_HOST.split(':').slice(-1).map(Number);
const fsUp = await portInUse(fsPort);
const authUp = await portInUse(authPort);
const reuseEmulators = fsUp && authUp;

let emu = null;
let emuGroup = 0;
if (reuseEmulators) {
  note(`Firestore (${FIRESTORE_HOST}) + Auth (${AUTH_HOST}) emulators already running — reusing`);
} else {
  console.log(`\n=== verify:live:emulator — booting Firestore + Auth emulators ===`);
  emu = spawn(
    'npx',
    ['-y', 'firebase-tools@latest', 'emulators:start', '--only', 'firestore,auth', '--project', EMULATOR_PROJECT],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  );
  emuGroup = -emu.pid;
  let emuLog = '';
  const onData = (d) => { emuLog += d.toString(); };
  emu.stdout?.on('data', onData);
  emu.stderr?.on('data', onData);

  const ready = await waitForPort(fsPort, 240_000) && await waitForPort(authPort, 60_000);
  if (!ready) {
    fail(`emulators did not come up (Firestore ${fsPort} / Auth ${authPort})`);
    if (emu.exitCode !== null) note(`emulator process exited early with code ${emu.exitCode}`);
    console.log(emuLog.split('\n').filter(Boolean).slice(-12).join('\n'));
    try { process.kill(emuGroup, 'SIGKILL'); } catch { /* gone */ }
    process.exit(process.exitCode ?? 1);
  }
  // The ports bind just before the emulators finish internal init — give the
  // auth + firestore emulators a moment to be fully request-ready.
  await sleep(1_500);
  ok(`emulators up (Firestore ${fsPort}, Auth ${authPort})`);
}

// ── 2. Reuse an emulator-pointed dev server, or boot one ───────────────────
// The app's /api/build-info reports `emulator: true` when the server was
// started with FIRESTORE_EMULATOR_HOST (see app/api/build-info/route.ts), so
// an already-running emulator-pointed server (the README flow: `npm run
// emulators` + `npm run dev` with the emulator vars) is reused instead of
// booting a second one — and a production-pointed (or non-cook) server is
// never mistaken for one.
const devEnv = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
  FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST,
  NEXT_PUBLIC_USE_FIRESTORE_EMULATOR: '1',
  APP_OWNER_UID: OWNER_UID,
};

const candidateUrls = [
  ...(process.env.VERIFY_EMULATOR_APP_URL ? [process.env.VERIFY_EMULATOR_APP_URL] : []),
  'http://localhost:3000',        // the README `npm run dev` default port
  `http://localhost:${DEV_PORT}`, // this driver's own port
];

async function findEmulatorServer() {
  for (const url of candidateUrls) {
    const base = url.replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/build-info`, { signal: AbortSignal.timeout(3_000) });
      if (res.status !== 200) continue;
      const body = await res.json().catch(() => null);
      if (body?.emulator === true) return base;
    } catch { /* not up, or not ours */ }
  }
  return null;
}

let dev = null;
let devGroup = 0;
let reusedDev = false;
const reusedServer = await findEmulatorServer();
if (reusedServer) {
  BASE = reusedServer;
  reusedDev = true;
  note(`reusing existing dev server at ${BASE} (it reports emulator: true)`);
} else {
  console.log(`\n=== verify:live:emulator — booting dev server on :${DEV_PORT} ===`);
  dev = spawn('npm', ['run', 'dev', '--', '--port', String(DEV_PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: 'inherit',
    env: devEnv,
  });
  devGroup = -dev.pid;

  const serverUp = await waitForServer();
  if (!serverUp) {
    fail(`dev server never answered on ${BASE} within 180s`);
    if (dev.exitCode !== null) note(`dev process exited early with code ${dev.exitCode} — is port ${DEV_PORT} already in use?`);
    try { process.kill(devGroup, 'SIGTERM'); } catch { /* gone */ }
    if (!reuseEmulators) { try { process.kill(emuGroup, 'SIGKILL'); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 1);
  }
  ok(`dev server answering on ${BASE}`);
}

// Warm the lazily-compiled API route so its first compile happens before
// verify:live's request timeouts start.
try {
  const res = await fetch(`${BASE}/api/cook`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  note(`warmed /api/cook → HTTP ${res.status} (401 = auth-gated, as expected)`);
} catch (e) {
  note(`warm /api/cook failed (${e instanceof Error ? e.message : e}) — continuing`);
}

// ── 3. Run the guided-flow check against the emulator-backed server ────────
console.log(`\n=== verify:live (emulator mode) against ${BASE} ===`);
const rc = await new Promise((resolveChild) => {
  const child = spawn(
    process.execPath,
    ['scripts/verify-live.mjs', '--app', BASE, '--emulator'],
    { cwd: ROOT, stdio: 'inherit', env: devEnv },
  );
  child.on('exit', (code) => resolveChild(code ?? 1));
});

// ── 4. Teardown (always runs) ───────────────────────────────────────────────
if (!reusedDev && devGroup) {
  try { process.kill(devGroup, 'SIGTERM'); } catch { /* gone */ }
  await sleep(1_500);
  try { process.kill(devGroup, 'SIGKILL'); } catch { /* gone */ }
  console.log(`\n=== teardown: dev server stopped ===`);
} else {
  note(`dev server left running (reused at ${BASE})`);
}

if (!reuseEmulators && emuGroup) {
  try { process.kill(emuGroup, 'SIGTERM'); } catch { /* gone */ }
  await sleep(1_500);
  try { process.kill(emuGroup, 'SIGKILL'); } catch { /* gone */ }
  console.log('=== teardown: emulators stopped ===');
} else {
  note('emulators left running (they were reused)');
}

if (rc === 0) ok(`verify:live:emulator PASS against ${BASE}`);
else fail(`verify:live (emulator mode) failed with exit ${rc}`);
process.exit(process.exitCode ?? rc);
