#!/usr/bin/env node
// ============================================================================
// scripts/verify-live-local.mjs — verify the app against a LOCAL dev server,
// all in one command, with guaranteed teardown.
//
// Why this exists: the deployed check (verify-live.mjs) proves the live stack,
// but comparing against local dev used to be a manual dance — start `next dev`
// on a port, hope it survives, warm the lazily-compiled routes, run the check,
// then clean up orphaned processes. This driver does all of it:
//
//   1. Boots `npm run dev -- --port <port>` as its own process group.
//   2. Waits for HTTP on the root route (cold compile can take a while).
//   3. Warms the lazily-compiled routes (the /api/cook + /api/agent APIs, and
//      the /login PAGE the [2c] popup proof drives) so their on-demand
//      compilation happens BEFORE verify:live's request budgets start.
//   4. Runs the real check: node scripts/verify-live.mjs --app http://localhost:<port>
//      (same seed → guided flow → safety gate → timer → pantry confirm →
//      Gemini turn → cleanup as the deployed check — same .env.local backend).
//   5. ALWAYS tears down: kills the whole process group (npm + next + workers)
//      on every exit path — the tail below, the boot-failure early exit, and
//      the SIGINT/SIGTERM handlers — so no run can leak a listener. Exit code
//      mirrors verify-live (0 = PASS, 1 = FAIL).
//
// Usage:
//   npm run verify:live:local                          # port 3100
//   VERIFY_LOCAL_PORT=3105 npm run verify:live:local   # override the port
//
// Notes:
//   - Local dev shares the SAME .env.local backend as production (same
//     Firestore project + Gemini key), so writes are real but cleaned up.
//   - `next dev` regenerates .next/ (gitignored) — re-run `npm run build`
//     before a deploy if you care about a warm local production build.
// ============================================================================

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = Number(process.env.VERIFY_LOCAL_PORT ?? 3100);
const BASE = `http://localhost:${PORT}`;

const ok = (m) => console.log(`  ✓ ${m}`);
const note = (m) => console.log(`  - ${m}`);
const fail = (m) => { console.log(`  ✗ FAIL: ${m}`); process.exitCode = 1; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Boot the dev server as its own process group ─────────────────────────
console.log(`\n=== verify:live:local — booting dev server on :${PORT} ===`);
const dev = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
  cwd: resolve(import.meta.dirname, '..'),
  detached: true,        // own process group → we can kill npm + next + workers
  stdio: 'inherit',
  env: { ...process.env },
});
const group = -dev.pid;  // negative pid = the process group

// ── Signal handlers: an interrupted run must never orphan the dev group ─────
// The dev server is spawned detached into its OWN process group, so Ctrl+C
// (SIGINT to this script's group) never reaches it. Without handlers an
// interrupted run — especially during the up-to-180s boot wait — exits before
// the teardown below and leaks `next dev` + workers holding the port. Each
// handler mirrors the normal teardown (SIGTERM, short grace, SIGKILL) and
// exits with the conventional 128+signum code (130 for SIGINT, 143 for
// SIGTERM).
let teardownPromise = null;
const teardownDevGroup = async () => {
  if (teardownPromise) return teardownPromise; // second signal awaits the in-flight teardown
  teardownPromise = (async () => {
    try { process.kill(group, 'SIGTERM'); } catch { /* already gone */ }
    await sleep(1_500);                 // let npm/next shut down gracefully
    try { process.kill(group, 'SIGKILL'); } catch { /* gone */ }
  })();
  return teardownPromise;
};
process.on('SIGINT', async () => {
  console.log('\n  - received SIGINT; tearing down the dev server group');
  await teardownDevGroup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  console.log('\n  - received SIGTERM; tearing down the dev server group');
  await teardownDevGroup();
  process.exit(143);
});

// ── 2. Wait for the server to answer HTTP ───────────────────────────────────
async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) return false; // server died before booting
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(4_000) });
      if (res.status >= 200 && res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(2_000);
  }
  return false;
}
const up = await waitForServer();
if (!up) {
  fail(`dev server never answered on ${BASE} within 180s`);
  if (dev.exitCode !== null) {
    note(`dev process exited early with code ${dev.exitCode} — is port ${PORT} already in use?`);
  }
  try { process.kill(group, 'SIGTERM'); } catch { /* already gone */ }
  process.exit(process.exitCode ?? 1);
}
ok(`dev server answering on ${BASE}`);

// ── 3. Warm the lazily-compiled API routes ──────────────────────────────────
async function warmRoute(path, method = 'POST') {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      body: method === 'POST' ? JSON.stringify({}) : undefined,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000), // first compile can be slow
    });
    note(`warmed ${path} → HTTP ${res.status} (401 = auth-gated, as expected)`);
  } catch (e) {
    note(`warm ${path} failed (${e instanceof Error ? e.message : e}) — continuing`);
  }
}
await warmRoute('/api/cook');
await warmRoute('/api/agent');
// The [2c] stage spawns headless Chrome to click /login's real button, so the
// page's on-demand compile must finish here — inside the driver's polling
// window is a race, not a warm start.
async function warmPage(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) });
    note(`warmed ${path} → HTTP ${res.status}`);
  } catch (e) {
    note(`warm ${path} failed (${e instanceof Error ? e.message : e}) — continuing`);
  }
}
await warmPage('/login');
ok('routes and /login page compiled');

// ── 4. Run the real check against the local server ──────────────────────────
// The local run gets its OWN probe namespace (`verify-local-`, disjoint from
// the deployed CI run's `verify-live-`) so a concurrent CI run's sweep can
// never touch the local seed even transiently — the two share the production
// Firestore and owner uid, but never the same prefix.
console.log(`\n=== verify:live against ${BASE} ===`);
const rc = await new Promise((resolveChild) => {
  const child = spawn(process.execPath, ['scripts/verify-live.mjs', '--app', BASE, '--probe-prefix', 'verify-local-'], {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  });
  child.on('exit', (code) => resolveChild(code ?? 1));
});

// ── 5. Teardown (always runs) ───────────────────────────────────────────────
try { process.kill(group, 'SIGTERM'); } catch { /* already gone */ }
await sleep(1_500);
try { process.kill(group, 'SIGKILL'); } catch { /* gone */ }
console.log(`\n=== teardown: dev server stopped (exit ${dev.exitCode ?? 'killed'}) ===`);

if (rc === 0) ok(`verify:live:local PASS against ${BASE}`);
else fail(`verify:live failed with exit ${rc}`);
process.exit(process.exitCode ?? rc);
