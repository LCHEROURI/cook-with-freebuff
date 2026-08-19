#!/usr/bin/env node
// ============================================================================
// scripts/verify-live.mjs — end-to-end verification of the DEPLOYED app.
//
// Proves the live stack (Firebase App Hosting + Gemini + shared Firestore)
// works end to end:
//   1. Loads env (process.env first, then .env.local — plain KEY=VALUE lines,
//      surrounding quotes stripped).
//   1b. PRE-RUN SWEEP: archives leftover probe sessions (recipeId starting
//      with `verify-live-` — the exact prefix this script seeds) and deletes
//      their orphaned recipes, so a run killed mid-flight (CI timeout, crash,
//      SIGTERM) can NEVER leave a stale ACTIVE session that hijacks the
//      owner's /cook screen. The next run cleans the previous one's leftovers
//      before doing anything else.
//   2. Seeds an owner-scoped recipe directly into Firestore via the admin SDK
//      (rules are not the point here — the app's read path is).
//   3. Mints a REAL owner ID token: admin createCustomToken(APP_OWNER_UID)
//      exchanged through identitytoolkit signInWithCustomToken.
//   4. Drives the deployed /api/cook with that token:
//        launch → first prep action → done → safety-note step →
//        done → SAFETY_WARNING gate surfaced → done (acknowledge) →
//        timer auto-start on the first cooking step.
//   4b. STARTER-FLOW PROOF: the /cook "start from scratch" chain against the
//      deployed route — create_recipe (real Gemini generation through the
//      deployed create_recipe action) → validation must pass → the created
//      recipe must persist owner-stamped → rename the probe to a
//      `verify-live-starter-` id (its model slug would not match the sweep's
//      discriminator) → launch it → must land in PREP_GUIDANCE step 1 (the
//      one-tap "Start cooking" path). This is the CI gate that proves
//      create → validate → start-cooking after every deploy.
//   4c. UI STARTER PROOF: first settles the owner to the true empty state
//      (deletes the probe sessions [3] and [3b] just launched — a fresh /cook
//      load would otherwise show the CookScreen, not the starter), then
//      spawns the committed driver scripts/drive-starter-prefs.mjs against the
//      SAME deployed APP: headless Chrome types a preference-rich prompt into
//      the real /cook input, clicks Create my recipe, asserts the ready card
//      shows the parsed constraints ("4 servings · vegetarian · no peanuts"),
//      expands the "Generation constraints applied" details view, and sweeps
//      its own probe. A driver exit without RESULT: PASS fails the gate, and
//      verify:live itself asserts the driver's log contains the summary-click
//      and the three expanded-row markers (the driver is not a black box — a
//      future edit dropping the row assertions fails even on exit 0).
//   5. Agent turns through /api/agent: the deterministic pantry lifecycle
//      (add → confirm → query → remove → follow-up, with Firestore read-back;
//      no model dependency, so it also runs in emulator / --guided-only mode
//      and feeds the emulator-compare diff) and a free-form turn (proves the
//      Gemini provider answers — SKIP, not fail, when GOOGLE_AI_API_KEY is
//      absent locally). After the agent turns: a substitution proof through
//      /api/cook (request → SUBSTITUTION_REQUIRED → apply → recipe rewritten,
//      persisted, revalidated, exact step resumed) and a grocery list proof
//      through /api/agent (add → dedupe → list → remove, with Firestore
//      read-back at every step). Plus a vision scan proof through
//      /api/vision/scan (deterministic 400 on a missing image + a structured
//      200 on a generated label image — the route contract, never specific
//      contents).
//   6. GUARANTEED cleanup: the whole flow runs inside try/finally and
//      SIGINT/SIGTERM/unhandledRejection/uncaughtException handlers, so the
//      seeded recipe, starter probe (recipe + session), session, events,
//      timers, pantry item, and grocery item are removed on EVERY exit path —
//      success, failure, signal, or crash. A killed run is still caught by
//      the next run's pre-run sweep.
//
// Usage:
//   npm run verify:live                       # → https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app
//   npm run verify:live -- --app http://localhost:3000
//   VERIFY_BASE_URL=... node scripts/verify-live.mjs
//   npm run verify:live:emulator              # guided flow + pantry turns vs the LOCAL emulators
//   npm run verify:live -- --guided-only       # deployed guided flow [1]–[3] only
//   npm run verify:live -- --require-app-check-enforced
//                                             # FAIL unless the deployed server 403s an unattested request
//
// Exit code 0 = PASS, 1 = FAIL. Requires .env.local with the Firebase admin
// credentials + web API key + APP_OWNER_UID + NEXT_PUBLIC_FIREBASE_APP_ID
// (see .env.example) — except in
// `--emulator` mode (set by verify-live-emulator.mjs), which is self-contained:
// it needs only FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST and runs
// the deterministic guided flow ([1]–[3]) against the local emulators.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getAppCheck } from 'firebase-admin/app-check';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { classifyVerifyVerdict } from './verify-live-classify.mjs';

// ── Env loading (process.env wins; .env.local fills the gaps) ───────────────
function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch {
    // No .env.local — rely on process.env (CI passes vars directly).
  }
}
loadEnv();

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app').replace(/\/$/, '');
// Emulator mode: run the deterministic guided flow against the LOCAL
// Firestore + Auth emulators instead of production. Enabled via the
// `--emulator` flag or VERIFY_EMULATOR=1 (set by verify-live-emulator.mjs).
const EMULATOR = process.argv.includes('--emulator') || process.env.VERIFY_EMULATOR === '1';
// Guided-flow-only mode: stop after the deterministic guided flow [1]–[3],
// skipping the production-only stages (starter/Gemini, Chrome drivers, agent
// turns). Used by verify-live-compare-emulator.mjs so the deployed reference
// leg is fast and only emits the shared guided-flow steps.
const GUIDED_ONLY = process.argv.includes('--guided-only');
// Probe namespace. The post-deploy verify:live CI job keeps the default
// `verify-live-`; the local dev run (verify-live-local.mjs) passes
// `--probe-prefix verify-local-` so its seed and sweep live in a DISJOINT
// namespace — a concurrent CI run's `verify-live-` sweep can never touch the
// local run's in-flight seed, even transiently. Child drivers derive their
// own prefix from this (e.g. `${PROBE_PREFIX}voice-`) so they stay isolated
// too.
const PROBE_PREFIX = flag('--probe-prefix', 'verify-live-');
// Strict App Check mode: the deployed server MUST be enforcing App Check — an
// unattested request has to come back 403 APP_CHECK_FAILED. Set in CI once
// APP_CHECK_ENFORCED=1 is live, so the post-deploy gate proves enforcement
// instead of silently tolerating monitor mode.
const REQUIRE_APP_CHECK_ENFORCED = process.argv.includes('--require-app-check-enforced') || process.env.REQUIRE_APP_CHECK_ENFORCED === '1';
const EMULATOR_PROJECT_ID = 'demo-cook-with-freebuff';
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
let API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
// The deployed web app id (same public value in apphosting.yaml). The driver
// attests to App Check with it via admin.appCheck().createToken() so the
// post-deploy gate keeps exercising the gated routes once enforcement is on.
const APP_ID = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
// A tiny generated label image ("APPLE" in black on white, 132x44 PNG) used
// by the [4d] vision scan proof. Encoded once with a pure-Node PNG encoder —
// no binary fixture in the repo, no runtime image code. The stage asserts the
// STRUCTURED contract (a 200 whose data.ingredients is a well-formed array),
// never the specific contents, so what the model sees is not load-bearing.
const VISION_FIXTURE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIQAAAAsCAIAAAAraYdzAAABPUlEQVR4nO2RMRLDMAzD8v9Pt2NPg+/oCorZlJwTiCauV2KT63SB5JPIMEpkGCUyjBIZRokMo0SGUSQZl5DOv6c4ytupPlI36jBV+k6O8naqj9SNOkyVvpOjvJ3qI3WjDlOl7+Qob6f6SN2o0qvvf52zy28xqWNuI0aG0YiRYTRiZBiNGBlGI0aG0YiRYTTiY2XspsOh+iic7yZj+xQmdWx1mCo9wVEGmu5TmNSx1WGq9ARHGWi6T2FSx1aHqdITHGWg6T6FSZVefT/x+CdxCpM6Fhn9RMZhTmFSxyKjn8g4zClM6lhk9BMZhzmFSR2LjH7+WsZuJjiFST1eKa1wqD4KpzMixSlM6vFKaYVD9VE4nREpTmFSj1dKKxyqj8LpjEhxCrPzsIRNZBglMowSGUaJDKNEhlEiwyiRYZQ3guRtfJKasiAAAAAASUVORK5CYII=';

let failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures.push(m); console.log(`  ✗ FAIL: ${m}`); };
const skip = (m) => console.log(`  - SKIP: ${m}`);
const note = (m) => console.log(`  - ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Safe pretty-print for fail messages — a non-JSON body (e.g. a proxy error
// page) must print as `null`, never crash the verifier.
const j = (v) => JSON.stringify(v ?? null).slice(0, 160);
// Long slice for non-root failure bodies (substitute/apply_substitution/vision
// scan): enough of the body to debug the failure without unbounded log lines.
const jLong = (v) => JSON.stringify(v ?? null).slice(0, 800);
// FULL, untruncated serialization for the [3b] create_recipe root. The Gemini
// credits signature is what verify-live-classify matches, and its offset is not
// bounded by any SDK contract — a longer model id or a deeper error body can
// push it past jLong()'s 800-char cut and hide the cause again (the exact
// failure mode j()'s 160-char slice once caused). The root is therefore never
// sliced.
const jFull = (v) => JSON.stringify(v ?? null);
// Socket-level errors that mean the request was never delivered: undici
// reports these when it tries to REUSE a keep-alive socket the peer has
// already closed (the Chrome driver stages block this process in spawnSync
// for minutes, and `next dev` closes the idle socket meanwhile). A retry gets
// a FRESH connection. Timeouts/aborts are deliberately ABSENT — by then the
// server may have accepted the request, and repeating a mutating POST would
// duplicate it — so they always rethrow. The allowlist holds only the codes
// observed in the field (ECONNRESET, ECONNREFUSED, EPIPE); other undici codes
// (ECONNABORTED, UND_ERR_SOCKET, UND_ERR_CONNECT) were never seen and stay
// out until a real failure shows one.
const STALE_SOCKET_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE'];
const fetchJson = async (url, init) => {
  // The default 30s budget covers every ordinary call; callers that drive
  // Gemini generation (create_recipe) pass a longer timeoutMs — cold
  // serverless generation can exceed 30s and a fetch abort would fail the
  // gate on a transient, not a regression.
  const timeoutMs = typeof init?.timeoutMs === 'number' ? init.timeoutMs : 30_000;
  const retryOnConnectError = init?.retryOnConnectError === true;
  const { timeoutMs: _drop, retryOnConnectError: _drop2, ...rest } = init ?? {};
  const attempt = () => fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  let res;
  try {
    res = await attempt();
  } catch (e) {
    const cause = e?.cause?.code ?? '';
    // Retry is OPT-IN and only for a provably-undelivered request on a stale
    // socket. A timeout/abort rethrows: the server may have processed it, and
    // the caller (e.g. launch/done/create_recipe) is not idempotent. HTTP
    // errors never throw here, so the retry cannot mask a real status.
    if (!retryOnConnectError || !STALE_SOCKET_CODES.includes(cause)) throw e;
    console.warn(
      `  - fetch ${url} failed (${e instanceof Error ? e.message : String(e)}${cause ? `, ${cause}` : ''}) — retrying once on a fresh connection`,
    );
    res = await attempt();
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
};

// ── Runtime state for cleanup (defined before any early exit can use it) ────
let sid = null;
let pantryItemId = null;
let groceryItemId = null;
let seededRecipeId = null;
// Starter-flow probe artifacts: the recipe created via the deployed
// create_recipe action (renamed to a sweep-compatible `verify-live-` id) and
// the session launched from it — both must be removed on EVERY exit path.
let starterRecipeId = null;
let starterSid = null;
let cleanupRan = false;

async function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  if (!db) return;
  const deletes = [];
  if (seededRecipeId) deletes.push(db.collection('recipes').doc(seededRecipeId).delete());
  if (starterRecipeId) deletes.push(db.collection('recipes').doc(starterRecipeId).delete());
  if (pantryItemId) deletes.push(db.collection('pantry_items').doc(pantryItemId).delete());
  if (groceryItemId) deletes.push(db.collection('grocery_list').doc(groceryItemId).delete());
  if (sid) {
    deletes.push(db.collection('cooking_sessions').doc(sid).delete());
    const [events, timers] = await Promise.all([
      db.collection('cooking_session_events').where('sessionId', '==', sid).get(),
      db.collection('timers').where('sessionId', '==', sid).get(),
    ]);
    events.forEach((d) => deletes.push(d.ref.delete()));
    timers.forEach((d) => deletes.push(d.ref.delete()));
  }
  if (starterSid) {
    deletes.push(db.collection('cooking_sessions').doc(starterSid).delete());
    const [events, timers] = await Promise.all([
      db.collection('cooking_session_events').where('sessionId', '==', starterSid).get(),
      db.collection('timers').where('sessionId', '==', starterSid).get(),
    ]);
    events.forEach((d) => deletes.push(d.ref.delete()));
    timers.forEach((d) => deletes.push(d.ref.delete()));
  }
  try {
    await Promise.allSettled(deletes);
    console.log('  ↳ seeded recipe, starter probe (recipe + session), events, timers, pantry probe, and grocery probe removed');
  } catch {
    console.log('  ↳ cleanup best-effort (some docs may remain)');
  }
}

// ── Pre-run sweep: never let a killed run's leftovers hijack the owner ──────
// Every session this script ever creates carries a recipeId seeded with the
// PROBE_PREFIX (see step 2), so leftover ACTIVE/PAUSED sessions with that
// prefix are unambiguous probe artifacts — archiving them can never touch
// a real cooking session. Orphaned probe recipes (no probe session left) are
// deleted outright; they are pure throwaway seed data.
//
// CONCURRENCY GUARD: this run shares the owner uid and the production
// Firestore with the deployed verify:live CI job; both runs agree on the same
// prefix only when they use the SAME namespace (CI keeps `verify-live-`,
// verify:live:local passes `verify-local-`, so the two are disjoint and a
// concurrent CI sweep can never touch a local seed). Two same-namespace runs
// can still overlap (e.g. two CI deploys), and a run's seeded recipe is
// TRANSIENTLY orphaned between its [3c] settle (which deletes the probe
// session) and its [4] relaunch (which re-creates one) — a concurrent run's
// sweep would delete that still-in-flight seed, failing its [4] relaunch with
// RECIPE_NOT_FOUND. Two windows are guarded:
//   • seed → launch: the recipe exists but no session references it yet.
//     PROBE_GRACE_MS covers this from `updatedAt`/`createdAt` (seed time).
//   • [3c] → [4]: the session is deleted but the recipe is relaunched only
//     after the [3d]/[3e] drivers (up to ~25min). ORPHAN_GRACE_MS covers this
//     from `orphanedAt`, which the [3c] settle stamps at the orphaning
//     instant — measuring from seed time would expire mid-run.
// WHY THESE NUMBERS: 15 vs 30 match the two windows' worst cases. PROBE_GRACE_MS
// (15 min) only needs to outlast a seed→launch, which a live run does within
// minutes; it matches drive-live-voice.mjs's seed grace by convention (these
// are standalone scripts, no shared module for one constant). ORPHAN_GRACE_MS
// (30 min) must outlast the [3c]→[4] gap INCLUDING the minutes-long [3d]/[3e]
// Chrome driver stages (~25 min worst case), so it is deliberately longer.
const PROBE_GRACE_MS = 15 * 60 * 1000;
const ORPHAN_GRACE_MS = 30 * 60 * 1000;
async function sweepStaleProbes() {
  if (!db) return { archived: 0, deleted: 0 };
  const [sessionSnap, recipeSnap] = await Promise.all([
    db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get(),
    db.collection('recipes').where('userId', '==', OWNER_UID).get(),
  ]);

  const probeSessions = sessionSnap.docs.filter((d) => {
    const s = d.data();
    // A session is a probe if its recipeId carries the probe prefix OR a
    // driver stamped it (probePrefix). The stamp survives a later recipeId
    // replacement (the voice driver's collect-ingredients flow attaches a
    // model-slug recipe the prefix check alone cannot see). Namespace-scoped:
    // a `mic-regression-` stamp never matches this script's `verify-live-`
    // prefix, so a concurrent monitor run's in-flight session is untouched.
    //
    // start_cooking_session fallback shape: a turn arriving without a
    // recipeId makes the orchestrator start a BARE session (recipeId null),
    // which carries no prefix and no stamp — the stuck COLLECTING_INGREDIENTS
    // hijacker. Every other creation path attaches a recipeId, so on the
    // shared owner a bare session is unambiguously a fallback-created probe:
    // archive it HERE in the pre-run sweep instead of waiting for the 10-min
    // idle settle.
    const isProbe = (typeof s.recipeId === 'string' && s.recipeId.startsWith(PROBE_PREFIX)) ||
      (typeof s.probePrefix === 'string' && s.probePrefix.startsWith(PROBE_PREFIX)) ||
      (typeof s.recipeId !== 'string' || s.recipeId.length === 0);
    return isProbe && (s.status === 'ACTIVE' || s.status === 'PAUSED');
  });

  let archived = 0;
  for (const d of probeSessions) {
    await d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() });
    archived += 1;
  }

  // Delete orphaned probe recipes: `verify-live-*` recipes that no probe
  // session references anymore (the current run seeds its own AFTER this
  // sweep, so nothing live is ever touched here) AND that are older than the
  // grace period (a recently-seeded one belongs to a run still in flight).
  const liveProbeRecipeIds = new Set(probeSessions.map((d) => d.data().recipeId));
  const cutoff = Date.now() - PROBE_GRACE_MS;
  const orphanCutoff = Date.now() - ORPHAN_GRACE_MS;
  const deletes = recipeSnap.docs
    .filter((d) => {
      if (typeof d.id !== 'string' || !d.id.startsWith(PROBE_PREFIX)) return false;
      if (liveProbeRecipeIds.has(d.id)) return false;
      const data = d.data();
      // A live run's [3c] settle stamps `orphanedAt` when it deletes the
      // session; a concurrent sweep must not delete that recipe before the
      // [4] relaunch re-creates it. The grace is measured from the orphaning
      // instant (not seed time), so the [3d]/[3e] driver duration can't push
      // it past the window.
      const orphanedAt = data.orphanedAt;
      if (typeof orphanedAt === 'number' && orphanedAt > orphanCutoff) return false;
      const seededAt = data.updatedAt ?? data.createdAt ?? 0;
      return typeof seededAt === 'number' && seededAt < cutoff;
    })
    .map((d) => d.ref.delete());
  await Promise.allSettled(deletes);

  if (archived > 0 || deletes.length > 0) {
    console.log(`  ↳ pre-run sweep: archived ${archived} stale probe session(s), deleted ${deletes.length} orphaned probe recipe(s)`);
  }
  return { archived, deleted: deletes.length };
}

// ── Admin init ──────────────────────────────────────────────────────────────
if (EMULATOR) {
  // The auth emulator ignores the API key and the demo owner uid is arbitrary
  // (it only needs to be stable within a run). No service account is needed:
  // firebase-admin auto-routes Firestore + Auth to the local emulators via
  // FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST (see lib/server/admin.ts).
  if (!API_KEY) API_KEY = 'emulator-fake-api-key';
  if (!OWNER_UID) OWNER_UID = 'verify-live-emulator-owner';
} else {
  if (!API_KEY) { console.error('✗ FAIL: NEXT_PUBLIC_FIREBASE_API_KEY is required'); process.exit(1); }
  if (!OWNER_UID) { console.error('✗ FAIL: APP_OWNER_UID is required (the owner Firebase Auth uid)'); process.exit(1); }
  if (!SA_JSON) { console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT (inline JSON) is required'); process.exit(1); }
}

let app;
if (EMULATOR) {
  app = getApps()[0] ?? initializeApp({ projectId: EMULATOR_PROJECT_ID });
} else {
  let sa;
  try {
    // Parse RAW — the env value is already JSON-escaped; unescaping before
    // parse would corrupt embedded \n sequences ("Bad control character").
    sa = JSON.parse(SA_JSON);
  } catch {
    console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    process.exit(1);
  }
  app = getApps()[0] ?? initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'), // same as lib/server/admin.ts
    }),
  });
}
const db = getFirestore(app);

// ── Guaranteed cleanup on every exit path ───────────────────────────────────
// A bare `await cleanup()` at the end leaves the seeded recipe + session when
// the run dies early (throw, signal, unhandled rejection). Register handlers
// so a killed run still cleans up; the pre-run sweep above is the backstop
// for a run that cannot clean up at all (e.g. SIGKILL / hard CI timeout).
const exitWithCleanup = async (code, reason) => {
  if (!cleanupRan) {
    try { await cleanup(); } catch { /* best-effort */ }
  }
  console.error(reason);
  process.exit(code);
};
process.on('SIGINT', () => void exitWithCleanup(130, 'verify-live interrupted (SIGINT) — cleanup ran'));
process.on('SIGTERM', () => void exitWithCleanup(143, 'verify-live terminated (SIGTERM) — cleanup ran'));
process.on('unhandledRejection', (e) => {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  console.error(`✗ FAIL: unhandled rejection — ${msg}`);
  void exitWithCleanup(1, 'verify-live crashed — cleanup ran');
});
process.on('uncaughtException', (e) => {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  console.error(`✗ FAIL: uncaught exception — ${msg}`);
  void exitWithCleanup(1, 'verify-live crashed — cleanup ran');
});

// ── Main flow (try/finally so cleanup ALWAYS runs) ──────────────────────────
let runExit = 0;
// The final verdict (computed in `finally`; read by the exit line below).
let verdict = { kind: 'fail' };
try {
  // Pre-run sweep FIRST — before seeding anything of our own.
  await sweepStaleProbes();

  // ── 1. Seed an owner recipe ─────────────────────────────────────────────
  const t = Date.now();
  seededRecipeId = `${PROBE_PREFIX}${t}`;
  const recipe = {
    id: seededRecipeId,
    userId: OWNER_UID,
    title: 'Verify Live Chicken Rice',
    description: 'One-pan dinner used by npm run verify:live',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 15,
    totalMinutes: 20,
    // onion is referenced by the first prep step, so it must be listed for
    // the deterministic validation engine to pass; garlic is what the [4b]
    // substitution stage replaces, proving replace-throughout against a real
    // ingredient in the recipe.
    ingredients: [
      { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'i2', name: 'rice', quantity: 1, unit: 'cup', optional: false },
      { id: 'i3', name: 'onion', quantity: 1, unit: 'medium', optional: false },
      { id: 'i4', name: 'garlic', quantity: 2, unit: 'cloves', optional: false },
    ],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
      { id: 'p2', stepNumber: 2, instruction: 'Heat the oil on high', spokenInstruction: 'Heat the oil on high', estimatedSeconds: 60, ingredientsUsed: [], equipmentUsed: ['pan'], safetyNote: 'Hot oil — keep children away' },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil — keep children away'],
    generatedAt: t,
    updatedAt: t,
  };

  console.log(`\n[1] Seeding owner recipe → ${APP}`);
  await db.collection('recipes').doc(seededRecipeId).set(recipe);
  ok(`recipe ${seededRecipeId} seeded (owner ${OWNER_UID})`);

  // ── 2. Mint a real owner ID token ───────────────────────────────────────
  let idToken;
  let exchange;
  if (EMULATOR) {
    // The auth emulator signs its own tokens (there is no real service account
    // to mint a custom token from). Create the demo owner user (idempotent) and
    // exchange a password for an ID token through the emulator's local
    // identitytoolkit endpoint — the same verifier the app's resolveUserId
    // talks to via FIREBASE_AUTH_EMULATOR_HOST.
    console.log(`\n[2] Minting owner ID token (auth emulator signInWithPassword)`);
    const auth = getAuth(app);
    const OWNER_EMAIL = 'verify-live-owner@emulator.test';
    const OWNER_PASSWORD = 'verify-live-owner-password';
    try {
      await auth.createUser({ uid: OWNER_UID, email: OWNER_EMAIL, password: OWNER_PASSWORD });
      ok(`demo owner user created in the auth emulator (${OWNER_UID})`);
    } catch (e) {
      if (!/already/i.test(String(e?.message ?? e?.code ?? e))) throw e;
      note(`demo owner user already exists in the auth emulator — reusing`);
    }
    exchange = await fetchJson(
      `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, returnSecureToken: true }),
      },
    );
    idToken = exchange.body?.idToken;
  } else {
    console.log(`\n[2] Minting owner ID token (custom token → identitytoolkit)`);
    const customToken = await getAuth(app).createCustomToken(OWNER_UID);
    exchange = await fetchJson(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      },
    );
    idToken = exchange.body?.idToken;
  }
  if (!idToken) {
    console.error(`✗ FAIL: could not exchange owner token (${exchange?.status}: ${JSON.stringify(exchange?.body).slice(0, 200)})`);
    runExit = 1;
    throw new Error('abort — token exchange failed');
  }
  ok('owner ID token minted');

  // ── App Check attestation ────────────────────────────────────────────────
  // The deployed /api/cook + /api/agent are gated by Firebase App Check
  // (monitor mode today, enforced once APP_CHECK_ENFORCED=1). The driver
  // attests with admin.appCheck().createToken() — Firebase's supported CI
  // mechanism — so the post-deploy gate keeps reaching the tested flow after
  // enforcement, instead of 403ing before it. Attestation is best-effort:
  // until App Check is provisioned (API enabled + the service account holds
  // the App Check Admin role) the mint fails and the routes still pass in
  // monitor mode, so this is a note, not a failure — but once enforcement is
  // on, a missing token makes the routes themselves 403 and the run goes red.
  let appCheckToken = null;
  if (!EMULATOR) {
    if (!APP_ID) {
      note('NEXT_PUBLIC_FIREBASE_APP_ID not set — App Check attestation skipped (set it before enabling APP_CHECK_ENFORCED=1)');
    } else {
      try {
        const minted = await getAppCheck(app).createToken(APP_ID);
        appCheckToken = minted.token;
        ok('App Check token minted (admin.appCheck().createToken)');
      } catch (e) {
        note(`App Check token NOT minted — ${e instanceof Error ? e.message : String(e)} (enable the App Check API and grant the service account the App Check Admin role; routes still pass in monitor mode)`);
      }
    }
  }
  const AUTH = {
    authorization: `Bearer ${idToken}`,
    'content-type': 'application/json',
    ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
  };

  // ── 2a. App Check enforcement probe ─────────────────────────────────────
  // Prove the deployed server ENFORCES App Check, not just accepts it. A valid
  // owner request with NO App Check token must be rejected 403 APP_CHECK_FAILED
  // once enforcement is on (and pass in monitor mode). The happy-path flow
  // below attaches a token, so it would stay green even if enforcement were
  // silently disabled — this negative probe is what catches that regression.
  // `list_recipes` is a read-only action, so the probe writes nothing.
  if (!EMULATOR) {
    const noAppCheck = await fetchJson(`${APP}/api/cook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list_recipes' }),
    });
    const enforced = noAppCheck.status === 403 && noAppCheck.body?.error?.code === 'APP_CHECK_FAILED';
    if (enforced) {
      // note(), not ok(): the result is diagnostic, and a ✓ here would leak
      // into verify-live-compare's status-line diff (the local leg is monitor
      // mode), producing a false lifecycle divergence.
      note(`App Check enforced — unattested request rejected 403 (${noAppCheck.body.error.code})`);
      if (!appCheckToken) {
        fail('App Check is enforced but the driver minted no token — enable the App Check API, grant the service account the App Check Admin role, and set NEXT_PUBLIC_FIREBASE_APP_ID');
      }
    } else if (REQUIRE_APP_CHECK_ENFORCED) {
      fail(`App Check enforcement required but the deployed server accepted an unattested request (HTTP ${noAppCheck.status}) — set APP_CHECK_ENFORCED=1`);
    } else {
      note(`App Check in monitor mode — unattested request returned HTTP ${noAppCheck.status} (not blocked)`);
    }
  }

  // ── 2b. Model resolution proof ───────────────────────────────────────────
  // The five Gemini model names resolve server-side from Remote Config → env →
  // default (lib/ai/model-roles.ts + lib/server/model-config.ts). Read the
  // SAME published template the server resolves from, mirror the five-role
  // table (no TS import in this .mjs), log each role's resolution, and
  // hard-assert the one externally observable role: /api/voice/token returns
  // the live-voice model the server actually resolved. A resolver that
  // silently ignores Remote Config and falls back to the default now fails
  // the gate instead of passing unnoticed. Production-only: skip the emulator
  // leg and the --guided-only compare reference leg, whose transcript lines
  // would otherwise disturb the compare diff.
  if (!EMULATOR && !GUIDED_ONLY) {
    console.log(`\n[2b] Model resolution proof (Remote Config → /api/voice/token)`);
    const MODEL_ROLE_TABLE = [
      { role: 'generation', rcParam: 'recipe_generation_model', envVar: 'RECIPE_GENERATION_MODEL', defaultModel: 'gemini-3.7-flash' },
      { role: 'validation', rcParam: 'recipe_validation_model', envVar: 'RECIPE_VALIDATION_MODEL', defaultModel: 'gemini-3.7-flash' },
      { role: 'conversation', rcParam: 'conversation_model', envVar: 'CONVERSATION_MODEL', defaultModel: 'gemini-3.7-flash' },
      { role: 'vision', rcParam: 'vision_model', envVar: 'VISION_MODEL', defaultModel: 'gemini-3.7-flash' },
      { role: 'live-voice', rcParam: 'live_voice_model', envVar: 'LIVE_MODEL', defaultModel: 'gemini-3.1-flash-live-preview' },
    ];
    const rcParams = {};
    let rcError = null;
    try {
      const template = await getRemoteConfig(app).getTemplate();
      for (const [key, parameter] of Object.entries(template.parameters ?? {})) {
        const value = parameter?.defaultValue?.value;
        if (typeof value === 'string' && value) rcParams[key] = value;
      }
    } catch (e) {
      rcError = e;
    }
    if (rcError) {
      note(`Remote Config unreachable (${rcError instanceof Error ? rcError.message : String(rcError)}) — env/default fallback expected`);
    }
    for (const { role, rcParam, envVar, defaultModel } of MODEL_ROLE_TABLE) {
      const remote = rcParams[rcParam];
      const fromEnv = process.env[envVar];
      const model = remote ?? fromEnv ?? defaultModel;
      const source = remote ? 'remote-config' : fromEnv ? 'env' : 'default';
      note(`${role}: ${model} (${source})`);
    }
    // Hard-assert the one observable role via the deployed token route: the
    // model the route returned is the one the live-voice client connects with.
    const tokenProbe = await fetchJson(`${APP}/api/voice/token`, { method: 'POST', headers: AUTH });
    const returnedModel = tokenProbe.body?.data?.model;
    const rcLive = rcParams['live_voice_model'];
    if (typeof returnedModel !== 'string' || returnedModel.length === 0) {
      fail(`/api/voice/token returned no model (${j(tokenProbe.body)}) — the live-voice resolver is broken`);
    } else if (rcLive) {
      returnedModel === rcLive
        ? ok(`live-voice model matches Remote Config (${returnedModel})`)
        : fail(`live-voice model is ${returnedModel}, Remote Config says ${rcLive} — the resolver ignored Remote Config`);
    } else {
      note(`live-voice model from env/default fallback: ${returnedModel}`);
    }

    // ── 2b.2. model_source log smoke ─────────────────────────────────────
    // The template mirror above proves what Remote Config SAYS and the token
    // probe proves ONE role (live-voice) end to end. This smoke reads the
    // DEPLOYED server's own startup `model_source` log lines (emitted by
    // logModelResolutionSources() in lib/server/model-config.ts on every
    // boot) and hard-asserts that ALL FIVE roles resolved with
    // source=remote-config and the model the template declares. A boot that
    // silently fell back to env/default (RC unreachable at runtime, or a
    // deploy that raced a publish) fails here. Reads Cloud Logging via the
    // REST API with a SA-minted OAuth token scoped to logging.read (the
    // authorize-domain.mjs mint pattern). A log the SA cannot read (missing
    // roles/logging.viewer) is a distinct FAIL naming the IAM gap — never a
    // silent skip, so RC provisioning drift can never hide behind a skipped
    // check. Bounded retry: Cloud Logging ingestion can lag a boot's lines
    // by tens of seconds, so re-query until every role's entry lands.
    // The query is scoped to the deployed revision: each model_source line
    // carries the app's stamped commit (NEXT_PUBLIC_APP_COMMIT_SHA), and the
    // deploy job waited for THIS sha (GITHUB_SHA in CI), so the filter proves
    // the revision under test resolved from RC — a previous healthy boot's
    // lines in the 30-minute window can never stand in for a broken one.
    const LOG_SCOPE = 'https://www.googleapis.com/auth/logging.read';
    const saObj = JSON.parse(SA_JSON);
    const b64url = (buf) => Buffer.from(buf).toString('base64url');
    const jwtHdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const jwtNow = Math.floor(Date.now() / 1000);
    const jwtBody = b64url(JSON.stringify({
      iss: saObj.client_email,
      scope: LOG_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: jwtNow,
      exp: jwtNow + 3600,
    }));
    const jwtSig = b64url(createSign('sha256').update(`${jwtHdr}.${jwtBody}`).sign(saObj.private_key.replace(/\\n/g, '\n')));
    const mintRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtHdr}.${jwtBody}.${jwtSig}`,
    });
    const mintBody = await mintRes.json().catch(() => ({}));
    if (!mintRes.ok || !mintBody.access_token) {
      fail(`model_source smoke: OAuth mint failed (HTTP ${mintRes.status}) — ${j(mintBody).slice(0, 160)}`);
    }
    const LOG_WINDOW_MIN = 30;
    const windowStart = new Date(Date.now() - LOG_WINDOW_MIN * 60_000).toISOString();
    // GITHUB_SHA is set by Actions (the same sha wait-for-deploy-sha asserted
    // before this run); a manual local run has no sha, so the window-wide
    // filter still bounds the search there.
    const deployedSha = process.env.GITHUB_SHA ?? '';
    const LOG_FILTER = `jsonPayload.event="model_source" AND timestamp>="${windowStart}"`
      + (deployedSha ? ` AND jsonPayload.commit="${deployedSha}"` : '');
    let latestByRole = {};
    let logAttempts = 0;
    const MAX_LOG_ATTEMPTS = 6;
    while (logAttempts < MAX_LOG_ATTEMPTS) {
      const entriesRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
        method: 'POST',
        headers: { authorization: `Bearer ${mintBody.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceNames: [`projects/${saObj.project_id}`],
          filter: LOG_FILTER,
          orderBy: 'timestamp desc',
          pageSize: 50,
        }),
      });
      const entriesBody = await entriesRes.json().catch(() => ({}));
      if (!entriesRes.ok) {
        const permHint = entriesRes.status === 403
          ? ' — the deploy SA lacks Cloud Logging read (grant roles/logging.viewer); the smoke cannot run and RC drift would go unnoticed'
          : '';
        fail(`model_source smoke: Cloud Logging read failed (HTTP ${entriesRes.status}${permHint}) — ${j(entriesBody).slice(0, 200)}`);
      }
      latestByRole = {};
      for (const e of entriesBody.entries ?? []) {
        const p = e.jsonPayload ?? {};
        if (typeof p.role === 'string' && !(p.role in latestByRole)) latestByRole[p.role] = p;
      }
      const missing = MODEL_ROLE_TABLE.filter(({ role }) => !(role in latestByRole)).map(({ role }) => role);
      if (missing.length === 0) break;
      logAttempts += 1;
      if (logAttempts < MAX_LOG_ATTEMPTS) {
        note(`model_source smoke: waiting for log ingestion (missing ${missing.join(', ')})…`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    for (const { role, rcParam } of MODEL_ROLE_TABLE) {
      const entry = latestByRole[role];
      if (!entry) {
        // fail() records and continues (it does not throw), so guard the
        // deref below: a missing entry must report its own diagnostic, then
        // keep checking the remaining roles — never crash the verifier and
        // skip every stage after [2b].
        fail(`model_source smoke: no log entry for role ${role} in the last ${LOG_WINDOW_MIN} min — the deployed server never logged its model source`);
        continue;
      }
      if (entry.source !== 'remote-config') {
        fail(`model_source smoke: role ${role} resolved from ${entry.source} (${entry.model}) at runtime — Remote Config is NOT authoritative (the resolver fell back)`);
      }
      const rcModel = rcParams[rcParam];
      if (rcModel && entry.model !== rcModel) {
        fail(`model_source smoke: role ${role} runs ${entry.model} but Remote Config declares ${rcModel} — template and runtime drifted`);
      }
      ok(`model_source smoke: ${role} resolved from remote-config (${entry.model})`);
    }
  }

  // ── 2c. Login popup proof ──────────────────────────────────────────────
  // The /login page must open the Google consent popup (not throw
  // auth/unauthorized-domain) when "Continue with Google" is clicked from a
  // fresh profile. This is the config regression that bit once before: the
  // App Hosting hostname fell out of Firebase Auth's authorized domains and
  // every sign-in dead-ended, invisible to the API-only stages above (they
  // mint tokens server-side and never touch the client popup). The driver
  // spawns its own headless Chrome, clicks the real button, and proves the
  // popup reaches accounts.google.com (not just the transient firebaseapp.com
  // handler hop) with no blocked-domain message. Runs on the deployed AND
  // local legs (any real origin, headless Chrome), never on the emulator or
  // --guided-only compare reference, like [3d]/[3e].
  if (!EMULATOR && !GUIDED_ONLY) {
    console.log(`\n[2c] Login popup proof: Continue with Google opens the OAuth popup (${APP})`);
    const loginDriver = spawnSync('node', ['scripts/drive-login-popup.mjs', '--app', APP, '--out', `/tmp/verify-live-login-${t}`], {
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    });
    const loginLog = `${loginDriver.stdout ?? ''}\n${loginDriver.stderr ?? ''}`;
    if (loginDriver.status === 0 && /RESULT: PASS/.test(loginLog)) {
      ok('login popup driver → RESULT: PASS (OAuth popup opened, no domain error)');
    } else if (loginDriver.error?.code === 'ETIMEDOUT') {
      fail('login popup driver timed out after 120s');
    } else {
      const tail = loginLog.split('\n').filter(Boolean).slice(-6).join('\n');
      fail(`login popup driver → exit ${loginDriver.status ?? 'crash'}${loginDriver.error ? ` (${loginDriver.error.message})` : ''}. Tail: ${tail}`);
    }
    // Not a black box — verify:live must SEE the consent popup was reached
    // and no blocked-domain message appeared, not just a 0 exit. These markers
    // are the driver's own ok() lines, deterministic because the assertion is
    // fixed.
    for (const marker of [
      'Google consent popup reached',
      'no blocked-domain message after clicking',
    ]) {
      loginLog.includes(marker)
        ? ok(`login popup: ${marker}`)
        : fail(`login popup: missing “${marker}” in the driver log`);
    }
  }

  // ── 3. Guided flow through the deployed /api/cook ───────────────────────
  console.log(`\n[3] Driving guided cooking via ${APP}/api/cook`);
  const cook = (action, extra = {}) =>
    fetchJson(`${APP}/api/cook`, { method: 'POST', headers: AUTH, body: JSON.stringify({ action, ...extra }) });

  const launch = await cook('launch', { recipeId: seededRecipeId });
  if (launch.status !== 200 || !launch.body?.success) {
    fail(`launch → ${launch.status} ${JSON.stringify(launch.body?.error ?? launch.body).slice(0, 200)}`);
  } else {
    ok(`launch → ${launch.body.data.phase} (“${(launch.body.data.instruction ?? '').slice(0, 40)}”)`);
    sid = launch.body.data.sessionId;
    launch.body.data.phase === 'PREP_GUIDANCE' && launch.body.data.stepNumber === 1
      ? ok('starts at prep step 1')
      : fail(`expected PREP_GUIDANCE step 1, got ${launch.body.data.phase} step ${launch.body.data.stepNumber}`);
  }

  // Step 1 → step 2 (the safety-note step).
  const done1 = await cook('done', { sessionId: sid });
  done1.status === 200 && done1.body?.data?.stepNumber === 2
    ? ok('done → prep step 2')
    : fail(`done (step 1) → ${done1.status} ${JSON.stringify(done1.body?.error ?? done1.body?.data).slice(0, 160)}`);

  // "done" on the note-carrying step must surface the SAFETY_WARNING gate, not complete it.
  const gated = await cook('done', { sessionId: sid });
  if (gated.status === 200 && gated.body?.data?.phase === 'SAFETY_WARNING' && gated.body?.data?.safetyGate?.note) {
    ok(`safety gate surfaced: “${gated.body.data.safetyGate.note}” (step preserved at ${gated.body.data.stepNumber})`);
  } else {
    fail(`expected SAFETY_WARNING gate, got ${gated.status} ${j(gated.body?.data)}`);
  }

  // Acknowledging the gate advances; the first cooking step auto-starts a timer.
  const ack = await cook('done', { sessionId: sid });
  if (ack.status === 200 && ack.body?.data?.phase === 'WAITING_FOR_TIMER' && ack.body?.data?.timerStarted) {
    ok(`gate acknowledged → timer auto-started (“${ack.body.data.timerStarted.label}”)`);
  } else {
    fail(`expected WAITING_FOR_TIMER + timer, got ${ack.status} ${j(ack.body?.data)}`);
  }

  // ── 4. Pantry turns (deterministic — no model) ────────────────────────────
  // The K8 pantry lifecycle through /api/agent: add → confirm → query →
  // remove → follow-up, with Firestore read-back at every step. The command
  // router short-circuits before any provider call, so it runs WITHOUT a
  // Gemini key — which is exactly why BOTH the deployed and the emulator
  // stack can drive it, and why the emulator-compare shared-marker diff
  // covers it. Full mode calls this on the re-established [4] session;
  // emulator/--guided-only call it on the [3] session.
  async function runPantryTurns(sessionId) {
    const agent = (utterance) =>
      fetchJson(`${APP}/api/agent`, {
        method: 'POST', headers: AUTH,
        body: JSON.stringify({ utterance, sessionId }),
      });

    // Deterministic command: pantry persistence through the real tool layer.
    const pantryTurn = await agent('I always have olive oil');
    const pantryTool = pantryTurn.body?.toolCalls?.find((c) => c.tool === 'add_pantry_item');
    if (pantryTurn.status === 200 && pantryTool?.result?.success) {
      ok(`“I always have olive oil” → add_pantry_item succeeded live`);
      pantryItemId = pantryTool.result.data?.item?.id ?? null;
    } else {
      fail(`pantry agent turn → ${pantryTurn.status} ${JSON.stringify(pantryTurn.body).slice(0, 200)}`);
    }

    // K8 confirmation: "yes" must confirm the pending pantry item (CONFIRM chain →
    // confirm_pending_pantry_items), raise its confidence to 1, and clear the
    // session's pending list — the persisted state read back from Firestore.
    const confirmTurn = await agent('yes');
    const confirmTool = confirmTurn.body?.toolCalls?.find((c) => c.tool === 'confirm_pending_pantry_items');
    if (confirmTurn.status === 200 && confirmTool?.result?.success) {
      ok(`“yes” → confirm_pending_pantry_items succeeded live`);
      const confirmed = confirmTool.result.data?.confirmed ?? [];
      confirmed.some((c) => c.name === 'olive oil')
        ? ok(`pending pantry item “olive oil” confirmed`)
        : fail(`confirm_pending_pantry_items did not include olive oil (${JSON.stringify(confirmed).slice(0, 120)})`);
    } else {
      fail(`confirm turn → ${confirmTurn.status} ${JSON.stringify(confirmTurn.body).slice(0, 200)}`);
    }

    // Persisted-state proof: the session's pending list must be empty and the
    // pantry doc must carry full confidence (the confirm contract, read back).
    if (sessionId) {
      try {
        const sessionSnap = await db.collection('cooking_sessions').doc(sessionId).get();
        const pending = sessionSnap.data()?.pendingPantryItems ?? [];
        pending.length === 0
          ? ok('session pendingPantryItems cleared in Firestore')
          : fail(`pendingPantryItems still has ${pending.length} item(s) after confirm`);
      } catch (e) {
        fail(`could not read session pending state back: ${e.message}`);
      }
    }
    if (pantryItemId) {
      try {
        const itemSnap = await db.collection('pantry_items').doc(pantryItemId).get();
        const confidence = itemSnap.data()?.confidence;
        confidence === 1
          ? ok('pantry item confidence raised to 1 in Firestore')
          : fail(`pantry item confidence is ${confidence} (expected 1)`);
      } catch (e) {
        fail(`could not read pantry item back: ${e.message}`);
      }
    }

    // K8 pantry query: "what's in my pantry?" must route to the get_pantry tool
    // and list the just-confirmed item back (PANTRY_GET intent → tool → store).
    const queryTurn = await agent("what's in my pantry?");
    const queryTool = queryTurn.body?.toolCalls?.find((c) => c.tool === 'get_pantry');
    if (queryTurn.status === 200 && queryTool?.result?.success) {
      ok(`"what's in my pantry?" → get_pantry succeeded live`);
      const items = queryTool.result.data?.items ?? [];
      items.some((i) => i.name === 'olive oil')
        ? ok('pantry query lists the confirmed “olive oil” item')
        : fail(`get_pantry did not list olive oil (${JSON.stringify(items.map((i) => i.name).slice(0, 5)).slice(0, 160)})`);
    } else {
      fail(`pantry query turn → ${queryTurn.status} ${JSON.stringify(queryTurn.body).slice(0, 200)}`);
    }

    // K8 pantry remove: "remove olive oil from my pantry" must route to
    // remove_pantry_item (PANTRY_REMOVE intent, name resolution) — the item must
    // vanish from the store AND from the next query.
    const removeTurn = await agent('remove olive oil from my pantry');
    const removeTool = removeTurn.body?.toolCalls?.find((c) => c.tool === 'remove_pantry_item');
    if (removeTurn.status === 200 && removeTool?.result?.success) {
      ok('“remove olive oil from my pantry” → remove_pantry_item succeeded live');
    } else {
      fail(`pantry remove turn → ${removeTurn.status} ${JSON.stringify(removeTurn.body).slice(0, 200)}`);
    }
    if (pantryItemId) {
      try {
        const goneSnap = await db.collection('pantry_items').doc(pantryItemId).get();
        !goneSnap.exists
          ? ok('pantry item doc removed from Firestore')
          : fail(`pantry item ${pantryItemId} still exists after remove`);
      } catch (e) {
        fail(`could not read pantry item after remove: ${e.message}`);
      }
    }
    // Follow-up query proves the read path reflects the removal, not just the tool.
    const followUpTurn = await agent("what's in my pantry?");
    const followUpTool = followUpTurn.body?.toolCalls?.find((c) => c.tool === 'get_pantry');
    if (followUpTurn.status === 200 && followUpTool?.result?.success) {
      const items = followUpTool.result.data?.items ?? [];
      !items.some((i) => i.name === 'olive oil')
        ? ok('follow-up pantry query no longer lists “olive oil”')
        : fail(`get_pantry still lists olive oil after remove (${JSON.stringify(items.map((i) => i.name).slice(0, 5)).slice(0, 160)})`);
    } else {
      fail(`follow-up pantry query → ${followUpTurn.status} ${JSON.stringify(followUpTurn.body).slice(0, 200)}`);
    }
  }

  if (!EMULATOR && !GUIDED_ONLY) {
  // ── 3b. Starter-flow proof: create → validate → start cooking ────────────
  // The /cook starter is the missing start-from-scratch stage: the user says
  // what they have, the agent generates + validates a recipe, then "Start
  // cooking" launches it. This proves that whole chain against the DEPLOYED
  // app (real Gemini generation through the deployed route), not just the
  // seeded-recipe launch above. The created recipe gets renamed to a
  // `verify-live-`-prefixed id (its own model-generated slug id would not
  // match the pre-run sweep's discriminator), so a killed run's starter
  // probe is swept by the next run exactly like the seeded one.
  console.log(`\n[3b] Starter-flow proof: create_recipe → validate → start cooking (${APP}/api/cook)`);
  // Gemini generation on cold serverless can exceed the shared 30s helper's
  // budget — give the create call the same 120s the UI starter polls for.
  const cookLong = (action, extra = {}) =>
    fetchJson(`${APP}/api/cook`, { method: 'POST', headers: AUTH, body: JSON.stringify({ action, ...extra }), timeoutMs: 120_000 });
  const starterCreated = await cookLong('create_recipe', { prompt: 'I have chicken thighs and rice' });
  let createdRecipeId = null;
  if (starterCreated.status !== 200 || !starterCreated.body?.success) {
    fail(`create_recipe → ${starterCreated.status} ${jFull(starterCreated.body?.error ?? starterCreated.body)}`);
  } else {
    const { recipeId, title, validation } = starterCreated.body.data;
    createdRecipeId = recipeId;
    ok(`create_recipe → “${title}” (${recipeId})`);
    validation?.valid === true
      ? ok('created recipe validated (deterministic engine, no errors)')
      : fail(`created recipe NOT validated: ${j(validation)}`);
  }

  // Persistence proof: the created recipe must exist in Firestore with the
  // owner stamp (create_recipe persists via the recipe store, same as the
  // seeded one). If it is there, rename it to a sweep-compatible id before
  // launching — the launch below then exercises the EXACT persisted recipe.
  if (createdRecipeId) {
    try {
      const createdSnap = await db.collection('recipes').doc(createdRecipeId).get();
      if (!createdSnap.exists) {
        fail(`created recipe ${createdRecipeId} missing from Firestore (persistence broken?)`);
        createdRecipeId = null;
      } else if (createdSnap.data()?.userId !== OWNER_UID) {
        fail(`created recipe owner stamp is ${createdSnap.data()?.userId} (expected ${OWNER_UID})`);
        createdRecipeId = null;
      } else {
        ok(`created recipe persisted to Firestore, owner-stamped (${OWNER_UID})`);
        // Rename: copy under a `verify-live-starter-` id (inner id updated to
        // match) and drop the model-generated slug doc, so the pre-run sweep
        // and this script's cleanup both find the probe by the standard prefix.
        starterRecipeId = `${PROBE_PREFIX}starter-${t}`;
        const renamed = { ...createdSnap.data(), id: starterRecipeId, updatedAt: Date.now() };
        await db.collection('recipes').doc(starterRecipeId).set(renamed);
        await db.collection('recipes').doc(createdRecipeId).delete();
        ok(`probe recipe renamed to ${starterRecipeId} (sweep-compatible)`);
      }
    } catch (e) {
      fail(`could not read/rename created recipe: ${e.message}`);
      createdRecipeId = null;
    }
  }

  // Start cooking the created recipe: the one-tap "Start cooking" launch on
  // the persisted recipe must land in PREP_GUIDANCE step 1 (the guided flow
  // the seeded launch above already proves end to end).
  if (starterRecipeId) {
    const starterLaunch = await cook('launch', { recipeId: starterRecipeId });
    if (starterLaunch.status === 200 && starterLaunch.body?.success) {
      starterSid = starterLaunch.body.data.sessionId;
      const launchData = starterLaunch.body.data;
      launchData.phase === 'PREP_GUIDANCE' && launchData.stepNumber === 1
        ? ok(`created recipe launched → PREP_GUIDANCE step 1 (session ${starterSid.slice(0, 8)}…)`)
        : fail(`expected PREP_GUIDANCE step 1, got ${launchData.phase} step ${launchData.stepNumber}`);
    } else {
      fail(`launch of created recipe → ${starterLaunch.status} ${j(starterLaunch.body?.error ?? starterLaunch.body)}`);
    }
  }

  // ── 3c. UI starter proof: preference-rich ready card + constraints view ──
  // The [3b] stage just launched an ACTIVE session — a fresh /cook load would
  // show the CookScreen, not the starter. The UI driver must start from the
  // TRUE empty state, so settle the owner first: delete the seeded + starter
  // probe sessions (and their events) now; the final cleanup covers them
  // regardless, and the stage below never depends on them.
  console.log('\n[3c] Settling the owner to the clean starter (deleting probe sessions)');
  for (const probeSid of [sid, starterSid].filter(Boolean)) {
    try {
      const events = await db.collection('cooking_session_events').where('sessionId', '==', probeSid).get();
      const deletes = events.docs.map((d) => d.ref.delete());
      deletes.push(db.collection('cooking_sessions').doc(probeSid).delete());
      await Promise.allSettled(deletes);
      ok(`probe session ${probeSid.slice(0, 8)}… settled before the UI stage (+ ${events.size} events)`);
    } catch (e) {
      note(`settle best-effort: ${e.message} — the driver will fail loudly if the starter is not shown`);
    }
  }
  // Stamp the orphaning instant on the seeded recipe: its session was just
  // deleted above, and the [4] relaunch re-creates one only after the two
  // Chrome drivers. A concurrent run's sweep reads `orphanedAt` to measure
  // its grace from THIS point (not seed time), so it stays off-limits for the
  // full driver duration. Once relaunched, the live-session check protects
  // it anyway; the stale timestamp is irrelevant after that.
  if (seededRecipeId) {
    try {
      await db.collection('recipes').doc(seededRecipeId).update({ orphanedAt: Date.now() });
    } catch (e) {
      note(`orphanedAt stamp best-effort: ${e.message} — the relaunch still re-creates the session`);
    }
  }
  // Also neutralize ANY leftover session that can hijack the starter:
  //   (a) its recipe doc no longer exists (the sweep's `verify-live-`
  //       discriminator only sees prefixed probe recipes; a session launched
  //       from a UI-created MODEL-SLUG recipe carries the slug id and escapes
  //       it — seen live: a stale `simple-chicken-and-rice-basic` session
  //       auto-resumed and failed [3d] for two runs), or
  //   (b) it is stale — idle over 10 minutes. A real cooking session is
  //       minutes long and is actively touched between steps; anything idle
  //       that long on the SHARED DEV owner is a leftover probe (the slug
  //       session above was created by an earlier CI run and idle since). The
  //       stale rule also backstops a hard-killed run whose probe recipe was
  //       renamed/deleted but whose session escaped cleanup.
  // Archive (ABANDONED) — never delete — for stale sessions, preserving the
  // record; delete for recipe-gone sessions (their recipe is unrecoverable).
  //
  // Every write is CONDITIONAL, made inside a transaction that re-reads the
  // session and confirms it is STILL stale before touching it: a session the
  // shared owner resumed between our first read and this write must never be
  // archived under it. The version field is bumped like updateSession's
  // optimistic check, so a racing legitimate update surfaces as a conflict
  // instead of being silently clobbered.
  try {
    const leftover = await db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get();
    const idleCutoff = Date.now() - 10 * 60 * 1000;
    for (const d of leftover.docs) {
      const s = d.data();
      if (s.status !== 'ACTIVE' && s.status !== 'PAUSED') continue;
      const lastActivity = typeof s.lastActivityAt === 'number' ? s.lastActivityAt : 0;
      const stale = lastActivity > 0 && lastActivity < idleCutoff;
      if (!stale) continue;
      // Bare sessions (no recipeId — tool-free conversation sessions the
      // orchestrator creates via start_cooking_session when a turn arrives
      // without one) escape the pre-run sweep AND the recipe checks below: a
      // real cooking session ALWAYS carries a recipeId, so a bare ACTIVE one
      // that has been idle is a leftover hijacker — archive it the same way
      // as a stale probe (seen live: an idle bare session auto-resumed and
      // hid the starter on two consecutive runs).
      if (typeof s.recipeId !== 'string' || !s.recipeId) {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return;
          const cur = fresh.data();
          if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return;
          const curLast = typeof cur.lastActivityAt === 'number' ? cur.lastActivityAt : 0;
          if (curLast < idleCutoff) {
            tx.update(d.ref, {
              status: 'ABANDONED',
              lastActivityAt: Date.now(),
              version: (typeof cur.version === 'number' ? cur.version : 0) + 1,
            });
            ok(`stale bare session ${d.id.slice(0, 8)}… (no recipe, idle ${Math.round((Date.now() - lastActivity) / 60000)}m) archived before the UI stage`);
          }
        });
        continue;
      }
      const recipeSnap = await db.collection('recipes').doc(s.recipeId).get();
      if (recipeSnap.exists) {
        // Stale probe on a still-existing recipe — archive, keep the record.
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return;
          const cur = fresh.data();
          if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return;
          const curLast = typeof cur.lastActivityAt === 'number' ? cur.lastActivityAt : 0;
          if (curLast < idleCutoff) {
            tx.update(d.ref, {
              status: 'ABANDONED',
              lastActivityAt: Date.now(),
              version: (typeof cur.version === 'number' ? cur.version : 0) + 1,
            });
            ok(`stale session ${d.id.slice(0, 8)}… (recipe “${s.recipeId.slice(0, 30)}”, idle ${Math.round((Date.now() - lastActivity) / 60000)}m) archived before the UI stage`);
          }
        });
      } else {
        // Recipe gone — delete, but only while the session is STILL the same
        // stale one (a resumed session must never be deleted under the owner).
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return;
          const cur = fresh.data();
          if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return;
          const curLast = typeof cur.lastActivityAt === 'number' ? cur.lastActivityAt : 0;
          if (curLast >= idleCutoff) return;
          const events = await db.collection('cooking_session_events').where('sessionId', '==', d.id).get();
          for (const e of events.docs) tx.delete(e.ref);
          tx.delete(d.ref);
          ok(`orphan-recipe session ${d.id.slice(0, 8)}… (recipe “${s.recipeId.slice(0, 30)}” gone) settled (+ ${events.size} events)`);
        });
      }
    }
  } catch (e) {
    note(`leftover settle best-effort: ${e.message}`);
  }

  // ── 3c½. Pre-stage guard: the UI starter must see a CLEAN owner ────────────
  // The [3c] settle archives stale leftovers and deletes the tracked probe
  // sessions, but a FRESH ACTIVE/PAUSED session (a concurrent monitor/voice
  // run inside the 10-min idle window, or a leaked slug session) survives it
  // and would hijack /cook — the driver would then report the opaque "starter
  // input not found" instead of the real cause.
  //
  // SELF-HEAL: instead of failing outright on a blocker, archive it and retry
  // ONCE. A concurrent-run collision — a session left ACTIVE inside the
  // settle's 10-min idle window by a run that just ended (voice driver,
  // starter driver, or the weekly monitor) — then heals THIS run instead of
  // turning a healthy deploy red. The archive is transactional and
  // conditional: the session is re-read inside the transaction and only a
  // still-ACTIVE/PAUSED session is archived (a session its own run resumed
  // between our read and write is skipped, never double-fought), and the
  // version is bumped like updateSession's optimistic check so a racing
  // legitimate update surfaces as a conflict. The owner account is the shared
  // CI test account — every ACTIVE/PAUSED session there is a driver artifact,
  // and the [3c] settle already proved the only "real" alternative (a resumed
  // session) by refusing to touch fresh ones. Only a blocker that SURVIVES
  // the archive retry fails the run, named in the log.
  const describeBlocking = (d) => {
    const s = d.data();
    const idle = typeof s.lastActivityAt === 'number' ? `${Math.round((Date.now() - s.lastActivityAt) / 1000)}s idle` : 'idle unknown';
    const recipe = typeof s.recipeId === 'string' && s.recipeId ? s.recipeId.slice(0, 30) : 'no recipe';
    const phase = s.currentPhase ?? s.phase ?? '?';
    return `${d.id.slice(0, 8)}… (${phase}, ${recipe}, ${idle})`;
  };
  const findBlocking = async () => {
    const ownerSessions = await db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get();
    return ownerSessions.docs.filter((d) => {
      const s = d.data();
      return s.status === 'ACTIVE' || s.status === 'PAUSED';
    });
  };
  try {
    let blocking = await findBlocking();
    if (blocking.length === 0) {
      ok('no ACTIVE/PAUSED session before the UI starter (clean owner)');
    } else {
      const names = blocking.map(describeBlocking).join('; ');
      note(`owner has ${blocking.length} ACTIVE/PAUSED session(s) blocking the UI starter — archiving and retrying once: ${names}`);
      let archived = 0;
      for (const d of blocking) {
        const archivedOne = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return false;
          const cur = fresh.data();
          if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return false;
          tx.update(d.ref, {
            status: 'ABANDONED',
            lastActivityAt: Date.now(),
            version: (typeof cur.version === 'number' ? cur.version : 0) + 1,
          });
          return true;
        });
        if (archivedOne) archived += 1;
      }
      const remaining = await findBlocking();
      if (remaining.length === 0) {
        ok(`archived ${archived} blocking session(s) — retried, owner is clean before the UI starter`);
      } else {
        const survivors = remaining.map(describeBlocking).join('; ');
        fail(`owner still has ${remaining.length} ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: ${survivors}`);
      }
    }
  } catch (e) {
    fail(`could not verify a clean owner before the UI starter: ${e.message}`);
  }

  // ── 3d. UI starter proof: preference-rich ready card + constraints view ──
  // The API-level [3b] stage proves create → validate → launch over HTTP.
  // This stage drives the REAL /cook UI in headless Chrome — type the
  // preference-rich prompt → Create my recipe → ready card shows the parsed
  // constraints → expand the "Generation constraints applied" details view —
  // by spawning the committed driver against the same deployed APP. The
  // driver is self-contained: it mints its own owner session, asserts the
  // card + details rows, screenshots them, and sweeps its own probe recipe
  // (the owner list ends exactly as it started). Any driver exit without a
  // RESULT: PASS — crash, timeout, or assertion failure — fails the gate.
  console.log(`\n[3d] UI starter proof: preference-rich ready card + constraints view (${APP})`);
  const driverOut = `/tmp/verify-live-driver-${t}`;
  // Retry-once-after-30s (the portfolio's live-gate pattern): the [3b] API
  // generation ran seconds before this stage, and a second consecutive Gemini
  // call can stall on cold serverless (seen live: the first attempt timed out
  // at the driver's 120s create poll; the next attempt passed). A non-PASS
  // first attempt therefore waits 30s and retries ONCE before failing — a
  // deterministic regression fails both attempts, a transient stall passes.
  // (The driver self-caps at ~150s via its own 120s create poll, so two
  // attempts + 30s backoff fit comfortably inside the job budget.)
  const runDriver = (attempt) =>
    spawnSync('node', ['scripts/drive-starter-prefs.mjs', '--app', APP, '--probe-prefix', `${PROBE_PREFIX}starter-prefs-`, '--out', `${driverOut}-${attempt}`], {
      encoding: 'utf8',
      timeout: 300_000, // Gemini generation + Chrome launch on cold serverless
      env: process.env,
    });
  let driver = runDriver(1);
  let driverLog = `${driver.stdout ?? ''}\n${driver.stderr ?? ''}`;
  if (!(driver.status === 0 && /RESULT: PASS/.test(driverLog))) {
    note('first driver attempt did not pass — waiting 30s and retrying once (transient backoff)');
    await sleep(30_000);
    driver = runDriver(2);
    driverLog = `${driver.stdout ?? ''}\n${driver.stderr ?? ''}`;
  }
  if (driver.status === 0 && /RESULT: PASS/.test(driverLog)) {
    ok('UI starter driver → RESULT: PASS (ready card prefs + constraints view)');
  } else if (driver.error?.code === 'ETIMEDOUT') {
    fail('UI starter driver timed out after 300s (both attempts)');
  } else {
    const tail = driverLog.split('\n').filter(Boolean).slice(-6).join('\n');
    fail(`UI starter driver → exit ${driver.status ?? 'crash'}${driver.error ? ` (${driver.error.message})` : ''}. Tail: ${tail}`);
  }

  // The expanded constraints view is the transparency half of the gate.
  // The driver is not a black box: verify:live must SEE the driver click the
  // summary and render the three rows. A future driver edit that drops the
  // row assertions (but still exits 0 with RESULT: PASS) must fail HERE —
  // these markers are the driver's own ok() lines, deterministic because the
  // prompt and the extractRecipePreferences parser are fixed.
  for (const marker of [
    'details expanded (clicked the summary)',
    'constraint list shows “Servings: 4”',
    'constraint list shows “Diet: vegetarian”',
    'constraint list shows “Allergens avoided: no peanuts”',
  ]) {
    driverLog.includes(marker)
      ? ok(`constraints view: ${marker}`)
      : fail(`constraints view: missing “${marker}” in the driver log`);
  }

  // ── 3e. Live voice driver: starter DICTATION mic + active-screen mic ──────
  // The committed driver (scripts/drive-live-voice.mjs) proves the whole
  // first-party voice surface on the DEPLOYED app: it mints its own owner
  // session, taps the STARTER dictation mic with real synthesized speech and
  // asserts the tool-free session's final transcription fills the prompt,
  // then launches a probe session and proves the ACTIVE-screen mic handshake
  // + spoken replies render. It sweeps its own probes (the `verify-live-voice-`
  // prefix, inside this script's sweep namespace) and deletes them on every
  // exit path — the owner's data ends exactly as it started. Same
  // retry-once-after-30s backoff as [3d] for cold-serverless transients.
  console.log(`\n[3e] Live voice driver: dictation + active-screen mics (${APP})`);
  const runVoiceDriver = (attempt) =>
    spawnSync('node', ['scripts/drive-live-voice.mjs', '--app', APP, '--probe-prefix', `${PROBE_PREFIX}voice-`, '--out', `/tmp/verify-live-voice-${t}-${attempt}`], {
      encoding: 'utf8',
      timeout: 420_000, // two Chrome launches + two Gemini Live sessions
      env: process.env,
    });
  let voiceDriver = runVoiceDriver(1);
  let voiceLog = `${voiceDriver.stdout ?? ''}\n${voiceDriver.stderr ?? ''}`;
  if (!(voiceDriver.status === 0 && /RESULT: PASS/.test(voiceLog))) {
    note('voice driver first attempt did not pass — waiting 30s and retrying once (transient backoff)');
    await sleep(30_000);
    voiceDriver = runVoiceDriver(2);
    voiceLog = `${voiceDriver.stdout ?? ''}\n${voiceDriver.stderr ?? ''}`;
  }
  if (voiceDriver.status === 0 && /RESULT: PASS/.test(voiceLog)) {
    ok('live voice driver → RESULT: PASS (dictation + active-screen mics)');
  } else if (voiceDriver.error?.code === 'ETIMEDOUT') {
    fail('live voice driver timed out after 420s (both attempts)');
  } else {
    const tail = voiceLog.split('\n').filter(Boolean).slice(-6).join('\n');
    fail(`live voice driver → exit ${voiceDriver.status ?? 'crash'}${voiceDriver.error ? ` (${voiceDriver.error.message})` : ''}. Tail: ${tail}`);
  }

  // The driver is not a black box — verify:live must SEE the key contracts in
  // its log: the tool-free dictation setup, the transcription filling the
  // input, and the active-screen handshake + rendered replies. A future edit
  // that drops any of these (while still exiting 0 with RESULT: PASS) fails
  // HERE, at the gate that runs after every deploy.
  for (const marker of [
    'dictation mic tapped',
    'tool-free dictation setup',
    'spoken prompt filled the input',
    'LISTENING state: mic aria-pressed',
    'spoken reply rendered',
  ]) {
    voiceLog.includes(marker)
      ? ok(`voice driver: ${marker}`)
      : fail(`voice driver: missing “${marker}” in the driver log`);
  }

  // ── 3f. Voice Everywhere surface proof: kitchen transcription mics ────────
  // Spec 0004 adds a transcription mic to every kitchen input. This stage
  // spawns the committed driver (scripts/drive-kitchen.mjs) against the same
  // deployed APP to prove the pantry and dietary-profile mics actually render
  // with a REAL owner session — not just that the selectors exist in source.
  console.log(`\n[3f] Voice Everywhere kitchen mics (${APP})`);
  const kitchenDriver = spawnSync('node', ['scripts/drive-kitchen.mjs', '--app', APP, '--out', `/tmp/verify-live-kitchen-${t}`], {
    encoding: 'utf8',
    timeout: 180_000, // Chrome launch + owner session mint + /kitchen load
    env: process.env,
  });
  const kitchenLog = `${kitchenDriver.stdout ?? ''}\n${kitchenDriver.stderr ?? ''}`;
  if (kitchenDriver.status === 0 && /RESULT: PASS/.test(kitchenLog)) {
    ok('kitchen voice driver → RESULT: PASS (pantry + profile mics)');
  } else {
    const tail = kitchenLog.split('\n').filter(Boolean).slice(-6).join('\n');
    fail(`kitchen voice driver → exit ${kitchenDriver.status ?? 'crash'}${kitchenDriver.error ? ` (${kitchenDriver.error.message})` : ''}. Tail: ${tail}`);
  }
  for (const marker of [
    'pantry item name mic renders',
    'dietary profile allergies mic renders',
  ]) {
    kitchenLog.includes(marker)
      ? ok(`kitchen voice driver: ${marker}`)
      : fail(`kitchen voice driver: missing “${marker}” in the driver log`);
  }

  // The [4] pantry flow rides on an ACTIVE session — every agent turn carries
  // `sessionId: sid`. The settle above deleted the probe sessions so the UI
  // driver saw the clean starter; re-establish `sid` by launching the seeded
  // recipe (still in Firestore) fresh, so the pantry turns attach to a real,
  // current session.
  // The relaunch is the FIRST fetch after the minutes-long [3d]/[3e] Chrome
  // stages, so it is the one that hits the stale keep-alive socket. It opts
  // into the connection-error retry: `launch` on a `verify-live-` probe
  // recipe can only ever create a probe session, so a lost-response duplicate
  // (if the first delivery DID reach the server) is itself a `verify-live-`
  // probe session the next run's sweep archives — bounded, self-healing probe
  // data, never user data.
  const relaunch = await fetchJson(`${APP}/api/cook`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ action: 'launch', recipeId: seededRecipeId }),
    retryOnConnectError: true,
  });
  if (relaunch.status === 200 && relaunch.body?.success && relaunch.body?.data?.sessionId) {
    sid = relaunch.body.data.sessionId;
    ok(`fresh session ${sid.slice(0, 8)}… re-established for the agent turns`);
  } else {
    fail(`could not re-establish a session for the agent turns → ${relaunch.status} ${j(relaunch.body?.error ?? relaunch.body)}`);
  }

  // ── 4. Agent turns through the deployed /api/agent ──────────────────────
  console.log(`\n[4] Agent turns via ${APP}/api/agent`);
  const agent = (utterance) =>
    fetchJson(`${APP}/api/agent`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ utterance, sessionId: sid }),
    });

  // Deterministic pantry lifecycle via the shared runPantryTurns() (also
  // drives the emulator/guided-only legs — no model needed); the Gemini turn
  // below stays production-only.
  await runPantryTurns(sid);

  // Free-form turn: the Gemini provider must answer. A greeting is the clean
  // model-only path — food-phrase questions can be caught by the deterministic
  // ingredient extractor ("I heard: …") and never reach the model.
  if (process.env.GOOGLE_AI_API_KEY) {
    const modelTurn = await agent('Hi there!');
    const reply = modelTurn.body?.response ?? '';
    const notModelPath =
      reply.startsWith('Here is what I can do') || // HELP fallback (no provider)
      reply.startsWith('I heard:') || // ingredient extraction, not the model
      reply.startsWith('Sorry,'); // orchestrator honest-failure path
    if (modelTurn.status === 200 && reply.length > 0 && !notModelPath) {
      ok(`Gemini answered: “${reply.slice(0, 60)}…”`);
    } else {
      fail(`model turn → ${modelTurn.status} ${notModelPath ? 'did not reach the provider (extractor/fallback path)' : JSON.stringify(modelTurn.body).slice(0, 200)}`);
    }
  } else {
    skip('Gemini turn (GOOGLE_AI_API_KEY not set locally — provider check skipped, not failed)');
  }

  // ── 4b. Substitution proof (K7 Part A): request → apply → resume → persisted ──
  // The seeded recipe contains garlic (i4), so the full substitution contract
  // is exercised against the DEPLOYED route: the session enters
  // SUBSTITUTION_REQUIRED with honest candidates, applying the replacement
  // rewrites the recipe, persists it, revalidates, and resumes the EXACT step
  // the cook was on. Deterministic — no Gemini dependency.
  console.log(`\n[4b] Substitution proof: request → apply → resume exact step (${APP}/api/cook)`);
  const subReq = await cook('substitute', { sessionId: sid, unavailableIngredient: 'garlic' });
  const subCandidates = subReq.body?.data?.candidates ?? [];
  if (subReq.status === 200 && subReq.body?.success) {
    ok(`substitute → ${subReq.body.data.snapshot?.phase} (${subCandidates.map((c) => c.ingredient).join(', ') || 'no candidates'})`);
    subReq.body.data.snapshot?.phase === 'SUBSTITUTION_REQUIRED'
      ? ok('session entered SUBSTITUTION_REQUIRED')
      : fail(`expected SUBSTITUTION_REQUIRED, got ${j(subReq.body.data.snapshot?.phase)}`);
    subCandidates.some((c) => c.ingredient === 'garlic powder')
      ? ok('candidates include “garlic powder”')
      : fail(`candidates missing garlic powder (${JSON.stringify(subCandidates.map((c) => c.ingredient)).slice(0, 160)})`);
  } else {
    fail(`substitute → ${subReq.status} ${jLong(subReq.body?.error ?? subReq.body)}`);
  }
  const stepBeforeSub = subReq.body?.data?.snapshot?.stepNumber;

  const subApply = await cook('apply_substitution', { sessionId: sid, replacement: 'garlic powder' });
  if (subApply.status === 200 && subApply.body?.success) {
    const applied = subApply.body.data;
    ok(`apply_substitution → ${applied.from} → ${applied.to} (${applied.snapshot?.phase} step ${applied.snapshot?.stepNumber})`);
    applied.snapshot?.phase === 'PREP_GUIDANCE' && applied.snapshot?.stepNumber === stepBeforeSub
      ? ok(`resumed the exact step after substitution (${applied.snapshot.phase} step ${applied.snapshot.stepNumber})`)
      : fail(`expected resume to ${stepBeforeSub}, got ${applied.snapshot?.phase} step ${applied.snapshot?.stepNumber}`);
    applied.validation?.valid === true
      ? ok('replaced recipe revalidated (deterministic engine, no errors)')
      : fail(`replaced recipe NOT validated: ${j(applied.validation)}`);
  } else {
    fail(`apply_substitution → ${subApply.status} ${jLong(subApply.body?.error ?? subApply.body)}`);
  }

  // Persistence proof: the replaced recipe must be in Firestore — garlic
  // powder present, garlic gone (the apply contract, read back from the store).
  if (seededRecipeId) {
    try {
      const replacedSnap = await db.collection('recipes').doc(seededRecipeId).get();
      const names = (replacedSnap.data()?.ingredients ?? []).map((i) => i.name);
      names.includes('garlic powder') && !names.includes('garlic')
        ? ok('replaced recipe persisted to Firestore (garlic → garlic powder, no garlic)')
        : fail(`Firestore recipe ingredients after substitution: ${JSON.stringify(names).slice(0, 160)}`);
    } catch (e) {
      fail(`could not read replaced recipe back: ${e.message}`);
    }
  }

  // ── 4c. Grocery list proof (K10): add → dedupe → list → remove, persisted ──
  // The MANUAL grocery surface: add an open line, prove dedupe (an OPEN line
  // is never duplicated), prove the read path lists it, then remove it — with
  // Firestore read-back at every step, like the pantry turns above.
  console.log(`\n[4c] Grocery list proof: add → dedupe → list → remove (${APP}/api/agent)`);
  const groceryAdd = await agent('add milk to my grocery list');
  const addGroceryTool = groceryAdd.body?.toolCalls?.find((c) => c.tool === 'add_grocery_item');
  if (groceryAdd.status === 200 && addGroceryTool?.result?.success) {
    ok('“add milk to my grocery list” → add_grocery_item succeeded live');
    groceryItemId = addGroceryTool.result.data?.item?.id ?? null;
  } else {
    fail(`grocery add turn → ${groceryAdd.status} ${JSON.stringify(groceryAdd.body).slice(0, 200)}`);
  }

  // Dedupe contract: re-adding the same name must return the SAME open line.
  const groceryAdd2 = await agent('add milk to my grocery list');
  const addGroceryTool2 = groceryAdd2.body?.toolCalls?.find((c) => c.tool === 'add_grocery_item');
  if (groceryAdd2.status === 200 && addGroceryTool2?.result?.success) {
    addGroceryTool2.result.data?.item?.id === groceryItemId
      ? ok('dedupe: re-adding “milk” returned the same open line (no duplicate)')
      : fail(`dedupe broken: second add returned ${j(addGroceryTool2.result.data?.item)} (expected ${groceryItemId})`);
  } else {
    fail(`grocery dedupe turn → ${groceryAdd2.status} ${JSON.stringify(groceryAdd2.body).slice(0, 200)}`);
  }

  if (groceryItemId) {
    try {
      const itemSnap = await db.collection('grocery_list').doc(groceryItemId).get();
      const d = itemSnap.data();
      d && d.status === 'OPEN' && d.source === 'MANUAL' && d.name === 'milk'
        ? ok('grocery item persisted to Firestore (OPEN, MANUAL)')
        : fail(`grocery item state is ${j(d)}`);
    } catch (e) {
      fail(`could not read grocery item back: ${e.message}`);
    }
  }

  const groceryList = await agent("what's on my grocery list?");
  const listGroceryTool = groceryList.body?.toolCalls?.find((c) => c.tool === 'get_grocery_list');
  if (groceryList.status === 200 && listGroceryTool?.result?.success) {
    const items = listGroceryTool.result.data?.items ?? [];
    items.some((i) => i.name === 'milk')
      ? ok('grocery list query lists the added “milk” item')
      : fail(`get_grocery_list did not list milk (${JSON.stringify(items.map((i) => i.name).slice(0, 5)).slice(0, 160)})`);
  } else {
    fail(`grocery list turn → ${groceryList.status} ${JSON.stringify(groceryList.body).slice(0, 200)}`);
  }

  const groceryRemove = await agent('remove milk from my grocery list');
  const removeGroceryTool = groceryRemove.body?.toolCalls?.find((c) => c.tool === 'remove_grocery_item');
  if (groceryRemove.status === 200 && removeGroceryTool?.result?.success) {
    ok('“remove milk from my grocery list” → remove_grocery_item succeeded live');
  } else {
    fail(`grocery remove turn → ${groceryRemove.status} ${JSON.stringify(groceryRemove.body).slice(0, 200)}`);
  }
  if (groceryItemId) {
    try {
      const goneSnap = await db.collection('grocery_list').doc(groceryItemId).get();
      !goneSnap.exists
        ? ok('grocery item doc removed from Firestore')
        : fail(`grocery item ${groceryItemId} still exists after remove`);
    } catch (e) {
      fail(`could not read grocery item after remove: ${e.message}`);
    }
  }

  // ── 4d. Vision scan proof: input validation + structured result ──────────
  // /api/vision/scan (camera/upload → Gemini vision → structured ingredients)
  // is the last Gemini-quota surface the gate did not exercise. Deterministic
  // probe first (no model): an empty body must be rejected 400 MISSING_IMAGE.
  // Then the happy path with a generated label image — the gate asserts the
  // STRUCTURED contract (a 200 whose data.ingredients is an array of
  // well-formed items), never the specific contents, so model variance can
  // never flake the post-deploy gate.
  console.log(`\n[4d] Vision scan proof: validation + structured result (${APP}/api/vision/scan)`);
  const missingImage = await fetchJson(`${APP}/api/vision/scan`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({}),
  });
  missingImage.status === 400 && missingImage.body?.error?.code === 'MISSING_IMAGE'
    ? ok('empty body → 400 MISSING_IMAGE (input validation live)')
    : fail(`expected 400 MISSING_IMAGE, got ${missingImage.status} ${j(missingImage.body)}`);

  const scanRes = await fetchJson(`${APP}/api/vision/scan`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ image: VISION_FIXTURE_IMAGE }),
    timeoutMs: 60_000, // cold serverless boot + model latency
  });
  if (scanRes.status === 200 && scanRes.body?.success) {
    ok(`vision scan → 200 (${scanRes.body.data?.ingredients?.length ?? 0} recognized ingredient(s))`);
    const ingredients = scanRes.body.data?.ingredients;
    Array.isArray(ingredients)
      ? ok('scan result is a parsed ingredients array')
      : fail(`data.ingredients is not an array: ${j(scanRes.body.data)}`);
    const malformed = (ingredients ?? []).filter((i) => typeof i?.name !== 'string' || typeof i?.confidence !== 'number');
    malformed.length === 0
      ? ok('every recognized ingredient is well-formed (name + confidence)')
      : fail(`malformed ingredient(s): ${j(malformed)}`);
  } else {
    fail(`vision scan → ${scanRes.status} ${jLong(scanRes.body?.error ?? scanRes.body)}`);
  }

  } else {
    // Guided flow only: the deterministic [1]–[3] steps plus the pantry turns
    // (also deterministic — no model), the exact surface the emulator-compare
    // shared-marker diff covers. The remaining stages need a production-only
    // dependency — real Gemini generation ([3b]) and headless Chrome + Gemini
    // Live ([3d], [3e], [3f]) — so they are skipped (emulator mode, or
    // --guided-only).
    console.log(`\n[4] Pantry turns via ${APP}/api/agent (deterministic — no model)`);
    await runPantryTurns(sid);
    skip('starter flow, UI/voice drivers, Gemini turn, and the substitution/grocery/vision stages — guided flow only');
  }
} catch (e) {
  // Only report if the token-exchange abort path hasn't already (that path
  // sets runExit + throws with a specific message; everything else is a real
  // crash the signal handlers would also catch — but the try/finally cleanup
  // must still run, so swallow and let the RESULT line below reflect it).
  if (!(e instanceof Error && e.message === 'abort — token exchange failed')) {
    const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    console.error(`✗ FAIL: ${msg}`);
    runExit = 1;
  }
} finally {
  // ── 5. Result + cleanup (GUARANTEED on every path) ──────────────────────
  // A crash (runExit !== 0) is never external — only the ordinary failure
  // set is classified. The Gemini prepayment-credits block is EXTERNAL: the
  // deployed app is healthy, the billing is not, so the deploy check passes
  // with a distinct report instead of a misleading red.
  verdict = runExit === 0 ? classifyVerifyVerdict({ failures }) : { kind: 'fail' };
  if (verdict.kind === 'pass') {
    console.error(`\nRESULT: PASS`);
  } else if (verdict.kind === 'external') {
    console.error(
      `\n⚠ EXTERNAL: Gemini API prepayment credits are depleted (429) — recipe generation and its ` +
        `downstream stages cannot run. The deployed app itself is healthy; this is a billing issue, not a ` +
        `regression. Top up credits at https://ai.studio/projects, then re-run verify:live.`,
    );
    console.error(`RESULT: EXTERNAL (Gemini credits — deploy check passes)`);
  } else {
    console.error(`\nRESULT: FAIL (${runExit !== 0 ? 'crash' : failures.length})`);
  }
  // Propagate the SEMANTIC verdict to the CI recorder: exiting 0 on external
  // would otherwise make steps.verify.outcome == 'success' and the /status
  // page would claim full verification. GITHUB_ENV is set on Actions runners
  // only; locally this is a no-op.
  const recordVerdict = verdict.kind === 'pass' ? 'success' : verdict.kind === 'external' ? 'external' : 'failure';
  if (process.env.GITHUB_ENV) {
    writeFileSync(process.env.GITHUB_ENV, `VERIFY_LIVE_VERDICT=${recordVerdict}\n`, { flag: 'a' });
  }
  await cleanup();
}
process.exit(verdict.kind === 'fail' ? 1 : 0);
