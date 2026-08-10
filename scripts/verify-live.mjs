#!/usr/bin/env node
// ============================================================================
// scripts/verify-live.mjs — end-to-end verification of the DEPLOYED app.
//
// Proves the live stack (Vercel + Gemini + shared Firestore) works end to end:
//   1. Loads env (process.env first, then .env.local — plain KEY=VALUE lines,
//      surrounding quotes stripped).
//   2. Seeds an owner-scoped recipe directly into Firestore via the admin SDK
//      (rules are not the point here — the app's read path is).
//   3. Mints a REAL owner ID token: admin createCustomToken(APP_OWNER_UID)
//      exchanged through identitytoolkit signInWithCustomToken.
//   4. Drives the deployed /api/cook with that token:
//        launch → first prep action → done → safety-note step →
//        done → SAFETY_WARNING gate surfaced → done (acknowledge) →
//        timer auto-start on the first cooking step.
//   5. One agent turn through /api/agent: a deterministic pantry command
//      (proves tools + persistence live) and a free-form turn (proves the
//      Gemini provider answers — SKIP, not fail, when GOOGLE_AI_API_KEY is
//      absent locally).
//   6. Awaitable cleanup: deletes the seeded recipe, the created session,
//      its events + timers, and the pantry item the agent turn added.
//
// Usage:
//   npm run verify:live                       # → https://cook-with-freebuff.vercel.app
//   npm run verify:live -- --app http://localhost:3000
//   VERIFY_BASE_URL=... node scripts/verify-live.mjs
//
// Exit code 0 = PASS, 1 = FAIL. Requires .env.local with the Firebase admin
// credentials + web API key + APP_OWNER_UID (see .env.example).
// ============================================================================

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
const fetchJson = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
};

// ── Runtime state for cleanup (defined before any early exit can use it) ────
let sid = null;
let pantryItemId = null;
let seededRecipeId = null;
let cleanupRan = false;

async function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  if (!db) return;
  const deletes = [];
  if (seededRecipeId) deletes.push(db.collection('recipes').doc(seededRecipeId).delete());
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
  try {
    await Promise.allSettled(deletes);
    console.log('  ↳ seeded recipe, session, events, timers, and pantry probe removed');
  } catch {
    console.log('  ↳ cleanup best-effort (some docs may remain)');
  }
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

// ── 1. Seed an owner recipe ─────────────────────────────────────────────────
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

// ── 2. Mint a real owner ID token ───────────────────────────────────────────
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
  await cleanup();
  process.exit(1);
}
ok('owner ID token minted');
const AUTH = { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' };

// ── 3. Guided flow through the deployed /api/cook ───────────────────────────
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
  fail(`expected SAFETY_WARNING gate, got ${gated.status} ${JSON.stringify(gated.body?.data).slice(0, 160)}`);
}

// Acknowledging the gate advances; the first cooking step auto-starts a timer.
const ack = await cook('done', { sessionId: sid });
if (ack.status === 200 && ack.body?.data?.phase === 'WAITING_FOR_TIMER' && ack.body?.data?.timerStarted) {
  ok(`gate acknowledged → timer auto-started (“${ack.body.data.timerStarted.label}”)`);
} else {
  fail(`expected WAITING_FOR_TIMER + timer, got ${ack.status} ${JSON.stringify(ack.body?.data).slice(0, 160)}`);
}

// ── 4. Agent turns through the deployed /api/agent ──────────────────────────
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

// ── 5. Result + cleanup (awaited) ───────────────────────────────────────────
console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
await cleanup();
process.exit(failures === 0 ? 0 : 1);
