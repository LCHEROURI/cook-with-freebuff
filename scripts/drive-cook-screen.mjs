#!/usr/bin/env node
// ============================================================================
// Repeatable driver: drive the DEPLOYED /cook screen with a REAL owner session.
//
//   1. Loads .env.local (plain KEY=VALUE, quotes stripped).
//   2. Mints a real owner ID token: SA-signed custom token (APP_OWNER_UID)
//      exchanged through identitytoolkit signInWithCustomToken — the exact
//      session mechanism verify-live uses.
//   3. Launches headless Chrome + CDP, injects the owner session into the
//      browser's Firebase auth persistence (IndexedDB + localStorage,
//      firebase:authUser:<apiKey>:[DEFAULT] — same injection verify-reports-
//      pdf-flow.mjs uses), then loads /cook.
//   4. Confirms the CLEAN EMPTY STATE (the recipe-creation starter) and
//      screenshots it.
//   5. Starter-flow proof: types "chicken thighs, rice" into the /cook
//      starter (the fixed empty state), clicks ✨ Create my recipe, waits for
//      the validated-recipe card, clicks ▶ Start cooking, and confirms the
//      guided screen takes over — the flow that used to dead-end.
//   6. Launches a fresh recipe session end to end: POST /api/cook launch with
//      recipe-chicken-rice (the real owner recipe in Firestore), reloads
//      /cook, confirms the screen shows the active PREP_GUIDANCE step 1, and
//      screenshots it.
//   7. Question-fix proof: TYPES "what is one good tip for seasoning chicken"
//      into the /cook input (the exact utterance that got swallowed as a fake
//      ingredient) and asserts the Kitchen Agent answers from the free-form
//      provider — the final reply, never the "Thinking…" placeholder.
//   8. No-session regression surface: the same question via /api/agent with NO
//      sessionId must be answered WITHOUT starting a session (the original
//      stuck session was created by this exact path).
//   9. Control: a no-session brain-dump ("I have two cups of flour and one
//      onion") must STILL auto-start a COLLECTING_INGREDIENTS session and
//      persist the items — read back from Firestore: flour/onion present,
//      question text absent everywhere.
//   10. Best-effort cleanup: deletes all probe sessions (the same guarantee
//      verify-live now has — never leave stale ACTIVE sessions).
//
// Usage: node scripts/drive-cook-screen.mjs [--out /tmp/cook-drive]
// ============================================================================

import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── Env loading (process.env wins; .env.local fills gaps) ───────────────────
function loadEnv() {
  try {
    const text = readFileSync(resolvePath(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env.local */ }
}
loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff.vercel.app').replace(/\/$/, '');
const OUT = flag('--out', '/tmp/cook-drive');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9471;
const USER_DATA_DIR = `/tmp/cook-drive-chrome-${process.pid}-${Date.now()}`;

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures += 1; console.log(`  ✗ FAIL: ${m}`); };
const note = (m) => console.log(`  - ${m}`);

if (!API_KEY) { console.error('✗ FAIL: NEXT_PUBLIC_FIREBASE_API_KEY required'); process.exit(1); }
if (!OWNER_UID) { console.error('✗ FAIL: APP_OWNER_UID required'); process.exit(1); }
if (!SA_JSON) { console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT required'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// ── 1. Mint a REAL owner session ────────────────────────────────────────────
console.log(`\n[1] Minting owner session (${OWNER_UID.slice(0, 10)}…) via SA-signed custom token`);
const sa = JSON.parse(SA_JSON);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = b64url(JSON.stringify({
  iss: sa.client_email, sub: sa.client_email,
  aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  iat: now, exp: now + 3600, uid: OWNER_UID,
}));
const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
const customToken = `${header}.${claims}.${sig}`;
const exchange = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
).then((r) => r.json());
if (!exchange.idToken || !exchange.refreshToken) {
  console.error(`✗ FAIL: signInWithCustomToken failed (${JSON.stringify(exchange).slice(0, 200)})`);
  process.exit(1);
}
const tokenPayload = JSON.parse(Buffer.from(exchange.idToken.split('.')[1], 'base64url').toString());
const expiresAt = Date.now() + parseInt(exchange.expiresIn, 10) * 1000;
ok(`owner idToken minted for ${tokenPayload.sub} (${tokenPayload.email ?? 'owner'})`);
const AUTH = { authorization: `Bearer ${exchange.idToken}`, 'content-type': 'application/json' };

// Admin SDK handle (reused by the ingredient read-back and the cleanup).
const getAdminDb = () => {
  const apps = getApps();
  const adminApp = apps[0] ?? initializeApp({
    credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key.replace(/\\n/g, '\n') }),
  });
  return getFirestore(adminApp);
};

// ── 2. Launch headless Chrome + CDP ─────────────────────────────────────────
console.log(`\n[2] Launching headless Chrome (CDP :${PORT})`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1440,1400',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, 'about:blank',
], { stdio: 'ignore' });
const killChrome = () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } };
const dropProfile = () => { try { rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } };
process.on('exit', killChrome);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killChrome(); dropProfile(); process.exit(130); });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* starting */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('✗ FAIL: Chrome DevTools did not come up.'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: r, reject: j } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
  }
};
const send = (method, params = {}) => new Promise((r, j) => {
  const id = ++msgId; pending.set(id, { resolve: r, reject: j });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result?.value;
};
const pageText = () => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 1200) || ''`);
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  note(`screenshot: ${name}.png`);
};

// ── 3. Inject the owner session, load /cook, confirm CLEAN EMPTY STATE ──────
console.log(`\n[3] Injecting owner session → loading ${APP}/cook`);
await send('Page.navigate', { url: `${APP}/cook` });
await sleep(4000);

const authUser = {
  uid: tokenPayload.sub,
  email: tokenPayload.email ?? 'cherouri@gmail.com',
  emailVerified: true,
  displayName: tokenPayload.name ?? '',
  isAnonymous: false,
  photoURL: '',
  providerData: [{
    providerId: 'google.com', uid: tokenPayload.sub,
    displayName: tokenPayload.name ?? '', email: tokenPayload.email ?? 'cherouri@gmail.com', photoURL: '',
  }],
  stsTokenManager: { refreshToken: exchange.refreshToken, accessToken: exchange.idToken, expirationTime: expiresAt },
  createdAt: String(Date.now() - 86400000),
  lastLoginAt: String(Date.now()),
  apiKey: API_KEY,
  appName: '[DEFAULT]',
};
const authUserKey = `firebase:authUser:${API_KEY}:[DEFAULT]`;
await evaluate(`(async () => {
  const key = ${JSON.stringify(authUserKey)};
  const record = { fbase_key: key, value: ${JSON.stringify(JSON.stringify(authUser))} };
  record.value = JSON.parse(record.value);
  await new Promise((resolvePromise, reject) => {
    const req = indexedDB.open('firebaseLocalStorageDb', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' }); };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('firebaseLocalStorage', 'readwrite');
      const store = tx.objectStore('firebaseLocalStorage');
      store.put(record);
      tx.oncomplete = () => { db.close(); resolvePromise('ok'); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  localStorage.setItem(key, JSON.stringify(record.value));
  return 'injected';
})()`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);

// The empty state: signed in as the owner with NO active session (we reset
// all 8 stale sessions earlier; the pre-run sweep keeps them gone). The
// starter's "✨ Create my recipe" button is the empty-state signal — the
// reframed copy no longer leads with "No active cooking session…".
let text = await pageText();
let sawEmpty = text.includes('Create my recipe');
for (let i = 0; i < 15 && !sawEmpty; i++) {
  await sleep(1000);
  text = await pageText();
  sawEmpty = text.includes('Create my recipe');
}
if (sawEmpty) {
  ok('starter shown (the recipe-creation entry — no dead end)');
} else {
  fail(`/cook did not show the starter. Page text: ${text.slice(0, 250)}`);
}
await screenshot('01-cook-empty-state');

// ── 5. Starter-flow proof: the empty state is no longer a dead end ──────────
// The fix under test: type what you have → create_recipe (generate + validate)
// → "▶ Start cooking" → the guided screen takes over. Before the fix this
// screen only offered "Back to start".
console.log(`\n[5] Starter-flow proof: “chicken thighs, rice” → create → start cooking`);
let starterSid = null;
const typeStarter = (value) =>
  evaluate(`(() => {
    const input = document.querySelector('input[aria-label="What do you have to cook with?"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
const clickStarterButton = (label) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)}));
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
const starterState = () =>
  evaluate(`(() => ({
    ready: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start cooking')),
    error: document.querySelector('[role="alert"]')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
  }))()`);

const typedStarter = await typeStarter('chicken thighs, rice');
if (typedStarter === 'typed') ok('typed “chicken thighs, rice” into the starter input');
else fail(`starter input not found (${typedStarter})`);
const clickedCreate = await clickStarterButton('Create my recipe');
if (clickedCreate === 'clicked') ok('clicked “✨ Create my recipe”');
else fail(`create button not found (${clickedCreate})`);

// Gemini generation + validation can take a while on cold serverless.
let st = await starterState();
for (let i = 0; i < 120 && !st.ready && !st.error; i++) {
  await sleep(1000);
  st = await starterState();
}
if (st.ready) {
  ok('recipe created + validated → “▶ Start cooking” card shown');
} else if (st.error) {
  fail(`starter showed an error: ${st.error.slice(0, 160)}`);
} else {
  fail('no result after 120s (create_recipe did not return)');
}
await screenshot('04-starter-recipe-ready');

// Launch through the UI: Start cooking → cook.launch → CookScreen takes over.
if (st.ready) {
  const clickedStart = await clickStarterButton('Start cooking');
  if (clickedStart === 'clicked') ok('clicked “▶ Start cooking”');
  else fail(`start-cooking button not found (${clickedStart})`);
  let cookText = await pageText();
  // The guided screen is the CookScreen: "Start over" (and the step controls)
  // only render there — the starter has no such button. (The voice input's
  // placeholder text is NOT part of innerText, so it cannot be the signal.)
  let sawGuided = cookText.includes('Start over') && !cookText.includes('Create my recipe');
  for (let i = 0; i < 30 && !sawGuided; i++) {
    await sleep(1000);
    cookText = await pageText();
    sawGuided = cookText.includes('Start over') && !cookText.includes('Create my recipe');
  }
  if (sawGuided) {
    ok('Start cooking launched the guided screen (not a dead end)');
    await screenshot('05-starter-cooking');
  } else {
    fail(`guided screen did not appear after Start cooking. Page text: ${cookText.slice(0, 250)}`);
  }
  try {
    const statusRes = await fetch(`${APP}/api/cook`, { headers: AUTH }).then((r) => r.json());
    starterSid = statusRes.data?.sessionId ?? null;
    starterSid
      ? ok(`starter session created: ${starterSid.slice(0, 8)}… (${statusRes.data?.phase ?? '?'})`)
      : note('could not resolve the starter session id for cleanup');
  } catch (e) {
    note(`starter session lookup best-effort: ${e.message}`);
  }
}

// ── 6. Launch a fresh recipe session end to end ─────────────────────────────
console.log(`\n[6] Launching a fresh recipe session (recipe-chicken-rice) via /api/cook`);
const launch = await fetch(`${APP}/api/cook`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ action: 'launch', recipeId: 'recipe-chicken-rice' }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let sid = null;
if (launch.status === 200 && launch.body?.success && launch.body?.data?.sessionId) {
  sid = launch.body.data.sessionId;
  ok(`launch → ${launch.body.data.phase} step ${launch.body.data.stepNumber} (session ${sid.slice(0, 8)}…)`);
  launch.body.data.phase === 'PREP_GUIDANCE' && launch.body.data.stepNumber === 1
    ? ok('fresh session starts at prep step 1')
    : fail(`expected PREP_GUIDANCE step 1, got ${launch.body.data.phase} step ${launch.body.data.stepNumber}`);
} else {
  fail(`launch → ${launch.status} ${JSON.stringify(launch.body ?? '').slice(0, 200)}`);
}

// Reload /cook — the screen must now show the ACTIVE session, not the empty state.
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
text = await pageText();
let sawActive = text.includes('Chicken Rice') && !text.includes('Create my recipe');
for (let i = 0; i < 15 && !sawActive; i++) {
  await sleep(1000);
  text = await pageText();
  sawActive = text.includes('Chicken Rice') && !text.includes('Create my recipe');
}
if (sawActive) {
  ok('active session shown on /cook: “Chicken Rice” + step instruction');
} else {
  fail(`/cook did not show the active session. Page text: ${text.slice(0, 300)}`);
}
await screenshot('02-cook-active-session');

// ── 6b. Mic surface: real microphone → speech-to-text with the typed fallback ──
// The mic button must exist on the active screen. In headless Chrome the Web
// Speech API is unavailable, so it renders disabled with the explanation — the
// important contract is that the mic surface exists AND the typed path (input +
// Send) remains fully intact (voice-first never means voice-only).
const micSurface = await evaluate(`(() => {
  const mic = document.querySelector('button[aria-label="Speak a command"], button[aria-label="Stop listening"]');
  const input = document.querySelector('input[aria-label="Speak or type a command"]');
  const send = document.querySelector('button[type="submit"]');
  return {
    mic: !!mic,
    micDisabled: mic ? mic.disabled : null,
    fallbackTitle: mic ? (mic.title || '') : '',
    input: !!input,
    send: !!send,
  };
})()`);
if (micSurface.mic && micSurface.input && micSurface.send) {
  ok(`mic surface renders (${micSurface.micDisabled ? 'disabled in headless — typed fallback intact' : 'enabled'})`);
} else {
  fail(`mic surface incomplete: ${JSON.stringify(micSurface)}`);
}

// ── 7. Question-fix proof: type the question into the /cook input ───────────
// The exact utterance that got swallowed as a fake ingredient before the fix:
// "what is ONE good tip for seasoning chicken" — the number-word "one" used to
// trip the quantity gate and save the whole sentence as a single ingredient.
// The fix's question gate must send it to the free-form provider (Gemini)
// instead. Typed into the real input on the active-session screen.
console.log(`\n[7] Question-fix proof: typing “what is one good tip for seasoning chicken” into /cook`);
const QUESTION = 'what is one good tip for seasoning chicken';
const typeIntoInput = async (value) =>
  evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Speak or type a command"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
const clickSend = () =>
  evaluate(`(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
// The agent's reply box is the LAST [role="status"] element — the FIRST is the
// header VoiceIndicator ("Thinking…" while the model works). Only return text
// once a SECOND status element (the reply box) has rendered a final answer, so
// the placeholder can never be mistaken for a reply.
const replyText = () =>
  evaluate(`(() => {
    const els = document.querySelectorAll('[role="status"]');
    if (els.length < 2) return '';
    const t = els[els.length - 1]?.innerText?.replace(/\\s+/g, ' ').trim() || '';
    return /^(Listening|Thinking|Speaking|Offline|Error)…?$/.test(t) ? '' : t;
  })()`);

const typed = await typeIntoInput(QUESTION);
if (typed === 'typed') ok('typed the question into the /cook input');
else fail(`could not find the /cook input (${typed})`);
const clicked = await clickSend();
if (clicked === 'clicked') ok('clicked Send');
else fail(`could not find the Send button (${clicked})`);

// Poll for the FINAL Kitchen Agent reply (Gemini can take a while on cold
// serverless — the VoiceIndicator stays "Thinking…" until it lands).
let reply = await replyText();
for (let i = 0; i < 90 && !reply; i++) {
  await sleep(1000);
  reply = await replyText();
}
const notModelPath =
  reply.startsWith('I heard:') || // ingredient extraction, not the model
  reply.startsWith('Here is what I can do') || // HELP fallback (no provider)
  reply.startsWith('Sorry,') || // honest-failure path
  reply.startsWith('I had trouble'); // provider error path
if (reply && !notModelPath) {
  ok(`Kitchen Agent answered the question (NOT swallowed): “${reply.slice(0, 80)}”`);
} else if (reply) {
  fail(`question did NOT reach the free-form provider — swallowed as: “${reply.slice(0, 120)}”`);
} else {
  fail('no Kitchen Agent reply appeared after 90s');
}
await screenshot('03-cook-question-answered');

// ── 8. No-session regression surface: the question must NOT start a session ──
// The original stuck session was created by the question path itself: with no
// session, a swallowed question auto-started a COLLECTING_INGREDIENTS session
// (start_cooking_session) and saved itself as an ingredient. After the fix the
// no-session question must be answered WITHOUT creating anything.
console.log(`\n[8] No-session question: same utterance via /api/agent with NO sessionId`);
const db = getAdminDb();
const ownerSessionCount = async () =>
  (await db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get()).size;
const sessionsBeforeQuestion = await ownerSessionCount();
const noSessionTurn = await fetch(`${APP}/api/agent`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ utterance: QUESTION }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const noSessionReply = noSessionTurn.body?.response ?? '';
const noSessionNotModel =
  noSessionReply.startsWith('I heard:') ||
  noSessionReply.startsWith('Here is what I can do') ||
  noSessionReply.startsWith('Sorry,') ||
  noSessionReply.startsWith('I had trouble');
if (noSessionTurn.status === 200 && noSessionReply && !noSessionNotModel) {
  ok(`no-session question answered: “${noSessionReply.slice(0, 80)}”`);
} else {
  fail(`no-session question → ${noSessionTurn.status} ${JSON.stringify(noSessionTurn.body).slice(0, 200)}`);
}
const sessionsAfterQuestion = await ownerSessionCount();
sessionsAfterQuestion === sessionsBeforeQuestion
  ? ok(`no session created by the question (${sessionsBeforeQuestion} → ${sessionsAfterQuestion})`)
  : fail(`question created a session (${sessionsBeforeQuestion} → ${sessionsAfterQuestion}) — swallowing regression`);

// ── 9. Control: a real brain-dump must STILL extract and auto-start ─────────
// The mirror image: "I have two cups of flour and one onion" with no session
// MUST auto-start a COLLECTING_INGREDIENTS session and persist the items —
// proving the fix narrowed the gate to questions only, nothing else.
console.log(`\n[9] Control: “I have two cups of flour and one onion” → must still extract + auto-start`);
const control = await fetch(`${APP}/api/agent`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ utterance: 'I have two cups of flour and one onion' }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const controlReply = control.body?.response ?? '';
const startedTool = control.body?.toolCalls?.find((c) => c.tool === 'start_cooking_session');
const controlSid = startedTool?.result?.data?.sessionId ?? null;
if (
  control.status === 200 &&
  controlReply.startsWith('I heard:') &&
  /flour/.test(controlReply) &&
  /onion/.test(controlReply) &&
  controlSid
) {
  ok(`brain-dump still extracts: “${controlReply.slice(0, 80)}”`);
  ok(`auto-started session ${controlSid.slice(0, 8)}… (start_cooking_session)`);
} else {
  fail(`control brain-dump → ${control.status} ${JSON.stringify(control.body).slice(0, 220)}`);
}

// Firestore read-back on the CONTROL session: COLLECTING_INGREDIENTS phase,
// flour/onion persisted, the question text ABSENT.
if (controlSid) {
  try {
    const sessionSnap = await db.collection('cooking_sessions').doc(controlSid).get();
    const data = sessionSnap.data() ?? {};
    data.currentPhase === 'COLLECTING_INGREDIENTS'
      ? ok('control session is in COLLECTING_INGREDIENTS (the phase the bug bit)')
      : fail(`control session phase is ${data.currentPhase} (expected COLLECTING_INGREDIENTS)`);
    const names = (data.availableIngredients ?? []).map((i) => i.name.toLowerCase());
    names.some((n) => n.includes('flour'))
      ? ok('“flour” persisted as an ingredient (control wrote it)')
      : fail(`flour missing from session ingredients (${JSON.stringify(names).slice(0, 160)})`);
    names.some((n) => n.includes('onion'))
      ? ok('“onion” persisted as an ingredient (control wrote it)')
      : fail('onion missing from session ingredients');
    !names.some((n) => n.includes('tip for seasoning') || n.includes('what is one good'))
      ? ok('question text NOT in any session ingredients — nothing swallowed')
      : fail(`question text WAS swallowed as an ingredient (${JSON.stringify(names).slice(0, 160)})`);
  } catch (e) {
    fail(`could not read control session back: ${e.message}`);
  }
  // Show the collecting screen live (the UI state the bug used to corrupt).
  await send('Page.reload', { ignoreCache: true });
  await sleep(3500);
  const ctext = await pageText();
  ctext.includes('Tell me what ingredients you have')
    ? ok('/cook shows the collecting screen for the control session')
    : note(`collecting screen text: ${ctext.slice(0, 200)}`);
  await screenshot('06-cook-collecting-control');
}

// ── 10. Cleanup the control session (same guarantee verify-live has) ────────
console.log(`\n[10] Cleanup control session`);
if (controlSid) {
  try {
    const events = await db.collection('cooking_session_events').where('sessionId', '==', controlSid).get();
    const deletes = events.docs.map((d) => d.ref.delete());
    deletes.push(db.collection('cooking_sessions').doc(controlSid).delete());
    await Promise.allSettled(deletes);
    ok(`control session deleted (+ ${events.size} events)`);
  } catch (e) {
    note(`control cleanup best-effort: ${e.message} — the pre-run sweep in verify:live will archive any leftover probe`);
  }
}

// ── 10. Cleanup the launched + starter sessions (same guarantee verify-live has) ──
console.log(`\n[10] Cleanup launched + starter sessions`);
for (const probe of [sid, starterSid].filter(Boolean)) {
  try {
    const events = await db.collection('cooking_session_events').where('sessionId', '==', probe).get();
    const deletes = events.docs.map((d) => d.ref.delete());
    deletes.push(db.collection('cooking_sessions').doc(probe).delete());
    await Promise.allSettled(deletes);
    ok(`probe session ${probe.slice(0, 8)}… deleted (+ ${events.size} events)`);
  } catch (e) {
    note(`cleanup best-effort: ${e.message} — the pre-run sweep in verify:live will archive any leftover probe`);
  }
}
ok('the owner account stays clean');

ws.close(); chrome.kill(); dropProfile();
console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
