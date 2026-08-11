#!/usr/bin/env node
// ============================================================================
// scripts/verify-live.mjs — end-to-end verification of the DEPLOYED app.
//
// Proves the live stack (Vercel + Gemini + shared Firestore) works end to end:
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
//      its own probe. A driver exit without RESULT: PASS fails the gate.
//   5. One agent turn through /api/agent: a deterministic pantry command
//      (proves tools + persistence live) and a free-form turn (proves the
//      Gemini provider answers — SKIP, not fail, when GOOGLE_AI_API_KEY is
//      absent locally).
//   6. GUARANTEED cleanup: the whole flow runs inside try/finally and
//      SIGINT/SIGTERM/unhandledRejection/uncaughtException handlers, so the
//      seeded recipe, starter probe (recipe + session), session, events,
//      timers, and pantry item are removed on EVERY exit path — success,
//      failure, signal, or crash. A killed run is still caught by the next
//      run's pre-run sweep.
//
// Usage:
//   npm run verify:live                       # → https://cook-with-freebuff.vercel.app
//   npm run verify:live -- --app http://localhost:3000
//   VERIFY_BASE_URL=... node scripts/verify-live.mjs
//
// Exit code 0 = PASS, 1 = FAIL. Requires .env.local with the Firebase admin
// credentials + web API key + APP_OWNER_UID (see .env.example).
// ============================================================================

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

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
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff.vercel.app').replace(/\/$/, '');
const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures += 1; console.log(`  ✗ FAIL: ${m}`); };
const skip = (m) => console.log(`  - SKIP: ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Safe pretty-print for fail messages — a non-JSON body (e.g. a Vercel
// protection 401 page) must print as `null`, never crash the verifier.
const j = (v) => JSON.stringify(v ?? null).slice(0, 160);
const fetchJson = async (url, init) => {
  // The default 30s budget covers every ordinary call; callers that drive
  // Gemini generation (create_recipe) pass a longer timeoutMs — cold
  // serverless generation can exceed 30s and a fetch abort would fail the
  // gate on a transient, not a regression.
  const timeoutMs = typeof init?.timeoutMs === 'number' ? init.timeoutMs : 30_000;
  const { timeoutMs: _drop, ...rest } = init ?? {};
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
};

// ── Runtime state for cleanup (defined before any early exit can use it) ────
let sid = null;
let pantryItemId = null;
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
    console.log('  ↳ seeded recipe, starter probe (recipe + session), events, timers, and pantry probe removed');
  } catch {
    console.log('  ↳ cleanup best-effort (some docs may remain)');
  }
}

// ── Pre-run sweep: never let a killed run's leftovers hijack the owner ──────
// Every session this script ever creates carries a recipeId seeded with the
// `verify-live-` prefix (see step 2), so leftover ACTIVE/PAUSED sessions with
// that prefix are unambiguous probe artifacts — archiving them can never touch
// a real cooking session. Orphaned probe recipes (no probe session left) are
// deleted outright; they are pure throwaway seed data.
async function sweepStaleProbes() {
  if (!db) return { archived: 0, deleted: 0 };
  const [sessionSnap, recipeSnap] = await Promise.all([
    db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get(),
    db.collection('recipes').where('userId', '==', OWNER_UID).get(),
  ]);

  const probeSessions = sessionSnap.docs.filter((d) => {
    const s = d.data();
    return (
      typeof s.recipeId === 'string' &&
      s.recipeId.startsWith('verify-live-') &&
      (s.status === 'ACTIVE' || s.status === 'PAUSED')
    );
  });

  let archived = 0;
  for (const d of probeSessions) {
    await d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() });
    archived += 1;
  }

  // Delete orphaned probe recipes: `verify-live-*` recipes that no probe
  // session references anymore (the current run seeds its own AFTER this
  // sweep, so nothing live is ever touched here).
  const liveProbeRecipeIds = new Set(probeSessions.map((d) => d.data().recipeId));
  const deletes = recipeSnap.docs
    .filter((d) => typeof d.id === 'string' && d.id.startsWith('verify-live-') && !liveProbeRecipeIds.has(d.id))
    .map((d) => d.ref.delete());
  await Promise.allSettled(deletes);

  if (archived > 0 || deletes.length > 0) {
    console.log(`  ↳ pre-run sweep: archived ${archived} stale probe session(s), deleted ${deletes.length} orphaned probe recipe(s)`);
  }
  return { archived, deleted: deletes.length };
}

// ── Admin init ──────────────────────────────────────────────────────────────
if (!API_KEY) { console.error('✗ FAIL: NEXT_PUBLIC_FIREBASE_API_KEY is required'); process.exit(1); }
if (!OWNER_UID) { console.error('✗ FAIL: APP_OWNER_UID is required (the owner Firebase Auth uid)'); process.exit(1); }
if (!SA_JSON) { console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT (inline JSON) is required'); process.exit(1); }

let sa;
try {
  // Parse RAW — the env value is already JSON-escaped; unescaping before
  // parse would corrupt embedded \n sequences ("Bad control character").
  sa = JSON.parse(SA_JSON);
} catch {
  console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  process.exit(1);
}

const apps = getApps();
const app = apps[0] ?? initializeApp({
  credential: cert({
    projectId: sa.project_id,
    clientEmail: sa.client_email,
    privateKey: sa.private_key.replace(/\\n/g, '\n'), // same as lib/server/admin.ts
  }),
});
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
try {
  // Pre-run sweep FIRST — before seeding anything of our own.
  await sweepStaleProbes();

  // ── 1. Seed an owner recipe ─────────────────────────────────────────────
  const t = Date.now();
  seededRecipeId = `verify-live-${t}`;
  const recipe = {
    id: seededRecipeId,
    userId: OWNER_UID,
    title: 'Verify Live Chicken Rice',
    description: 'One-pan dinner used by npm run verify:live',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 15,
    totalMinutes: 20,
    ingredients: [
      { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false },
      { id: 'i2', name: 'rice', quantity: 1, unit: 'cup', optional: false },
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
  console.log(`\n[2] Minting owner ID token (custom token → identitytoolkit)`);
  const customToken = await getAuth(app).createCustomToken(OWNER_UID);
  const exchange = await fetchJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const idToken = exchange.body?.idToken;
  if (!idToken) {
    console.error(`✗ FAIL: could not exchange owner token (${exchange.status}: ${JSON.stringify(exchange.body).slice(0, 200)})`);
    runExit = 1;
    throw new Error('abort — token exchange failed');
  }
  ok('owner ID token minted');
  const AUTH = { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' };

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
    fail(`create_recipe → ${starterCreated.status} ${j(starterCreated.body?.error ?? starterCreated.body)}`);
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
        starterRecipeId = `verify-live-starter-${t}`;
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
  const driver = spawnSync('node', ['scripts/drive-starter-prefs.mjs', '--app', APP, '--out', driverOut], {
    encoding: 'utf8',
    timeout: 300_000, // Gemini generation + Chrome launch on cold serverless
    env: process.env,
  });
  const driverLog = `${driver.stdout ?? ''}\n${driver.stderr ?? ''}`;
  if (driver.status === 0 && /RESULT: PASS/.test(driverLog)) {
    ok('UI starter driver → RESULT: PASS (ready card prefs + constraints view)');
  } else if (driver.error?.code === 'ETIMEDOUT') {
    fail('UI starter driver timed out after 300s');
  } else {
    const tail = driverLog.split('\n').filter(Boolean).slice(-6).join('\n');
    fail(`UI starter driver → exit ${driver.status ?? 'crash'}${driver.error ? ` (${driver.error.message})` : ''}. Tail: ${tail}`);
  }

  // The [4] pantry flow rides on an ACTIVE session — every agent turn carries
  // `sessionId: sid`. The settle above deleted the probe sessions so the UI
  // driver saw the clean starter; re-establish `sid` by launching the seeded
  // recipe (still in Firestore) fresh, so the pantry turns attach to a real,
  // current session.
  const relaunch = await cook('launch', { recipeId: seededRecipeId });
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
  if (sid) {
    try {
      const sessionSnap = await db.collection('cooking_sessions').doc(sid).get();
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
  console.error(`\nRESULT: ${runExit === 0 && failures === 0 ? 'PASS' : `FAIL (${runExit !== 0 ? 'crash' : failures})`}`);
  await cleanup();
}
process.exit(runExit === 0 && failures === 0 ? 0 : 1);
