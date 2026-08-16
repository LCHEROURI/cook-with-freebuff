#!/usr/bin/env node
// ============================================================================
// Repeatable driver: prove the preference-rich starter prompt on the DEPLOYED
// app, with a REAL owner session (same scaffolding as drive-cook-screen.mjs).
//
//   1. Loads .env.local, mints a real owner ID token (SA-signed custom token
//      exchanged via identitytoolkit), launches headless Chrome + CDP, and
//      injects the owner session into Firebase auth persistence.
//   2. Loads /cook, confirms the clean starter.
//   3. Types a preference-rich prompt — "chicken, rice for 4, no peanuts,
//      vegetarian" — and clicks ✨ Create my recipe.
//   4. Waits for the validated-recipe card and asserts the parsed preferences
//      surfaced on it: "· 4 servings · vegetarian · no peanuts" (servings via
//      the "for 4" matcher, "no peanuts" via the allergen gate, "vegetarian"
//      as a standalone diet term). This is the copy that shows the user what
//      was understood BEFORE they tap Start cooking.
//   5. Screenshots the ready-card (element clip) + the full page.
//   6. Best-effort cleanup: the created probe recipe is renamed to a
//      `verify-live-`-compatible id and deleted, so the owner's "Your recipes"
//      list stays exactly as it was (0 new rows, account clean).
//
// Usage: node scripts/drive-starter-prefs.mjs [--out /tmp/cook-prefs-proof]
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
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app').replace(/\/$/, '');
const OUT = flag('--out', '/tmp/cook-prefs-proof');
// Probe namespace: verify:live passes its own derived prefix so the local
// run's starter probe never lands in the CI run's `verify-live-` namespace
// (and vice versa). The sweep-compatible rename below carries this prefix, so
// a KILLED run's leftover is still caught by the matching sweep.
const PROBE_PREFIX = flag('--probe-prefix', 'verify-live-starter-prefs-');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9473;
const USER_DATA_DIR = `/tmp/cook-prefs-chrome-${process.pid}-${Date.now()}`;

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const PROMPT = 'chicken, rice for 4, no peanuts, vegetarian';

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
ok(`owner idToken minted for ${tokenPayload.sub}`);

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
const pageText = () => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 2000) || ''`);
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  note(`screenshot: ${name}.png`);
};

// ── 3. Inject the owner session, load /cook, confirm the starter ────────────
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

let text = await pageText();
let sawEmpty = text.includes('Create my recipe');
for (let i = 0; i < 15 && !sawEmpty; i++) {
  await sleep(1000);
  text = await pageText();
  sawEmpty = text.includes('Create my recipe');
}
if (sawEmpty) ok('starter shown (the recipe-creation entry)');
else fail(`/cook did not show the starter. Page text: ${text.slice(0, 250)}`);

// ── 4. Preference-rich prompt → create → parsed ready-card ─────────────────
console.log(`\n[4] Preference-rich prompt: “${PROMPT}” → create → parsed ready-card`);
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
const readyState = () =>
  evaluate(`(() => {
    // The ready card is uniquely identified by its Start-cooking button's
    // aria-label — its closest('div') IS the starterReady card, whose text
    // holds the title + parsed preferences (never a "Your recipes" row). The
    // button carries data-recipe-id so cleanup can delete EXACTLY the recipe
    // this run created (never a newer concurrent run's recipe by heuristic).
    const btn = document.querySelector('button[aria-label="Start cooking the created recipe"]');
    if (!btn) return { ready: false, cardText: '', error: '' };
    const cardText = btn.closest('div')?.innerText?.replace(/\\s+/g, ' ').trim() ?? '';
    const error = document.querySelector('[role="alert"]')?.innerText?.replace(/\\s+/g, ' ').trim() || '';
    return { ready: true, cardText, error, recipeId: btn.getAttribute('data-recipe-id') ?? '' };
  })()`);

const typedStarter = await typeStarter(PROMPT);
if (typedStarter === 'typed') ok(`typed “${PROMPT}” into the starter input`);
else fail(`starter input not found (${typedStarter})`);
const clickedCreate = await clickStarterButton('Create my recipe');
if (clickedCreate === 'clicked') ok('clicked “✨ Create my recipe”');
else fail(`create button not found (${clickedCreate})`);

let st = await readyState();
for (let i = 0; i < 120 && !st.ready && !st.error; i++) {
  await sleep(1000);
  st = await readyState();
}
if (st.ready) {
  ok('recipe created + validated → “▶ Start cooking” card shown');
  const expected = ['4 servings', 'vegetarian', 'no peanuts'];
  for (const phrase of expected) {
    st.cardText.includes(phrase)
      ? ok(`ready-card shows “${phrase}” (parsed preference)`)
      : fail(`ready-card missing “${phrase}”. Card: ${st.cardText.slice(0, 200)}`);
  }
  // The joined string must render in order, like the UI builds it.
  st.cardText.includes('4 servings · vegetarian · no peanuts')
    ? ok('ready-card renders the joined preference line “4 servings · vegetarian · no peanuts”')
    : note(`joined line differs (still individually verified): ${st.cardText.slice(0, 200)}`);
  await screenshot('01-ready-card-full');
  // Element-clipped screenshot of the ready card itself (crisp paper sheet).
  await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Start cooking the created recipe"]');
    const card = btn?.closest('div') ?? null;
    if (card) card.scrollIntoView({ block: 'center' });
    return !!card;
  })()`);
  await sleep(400);
  const clip = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Start cooking the created recipe"]');
    const card = btn?.closest('div');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const pad = 24;
    return {
      x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
      width: Math.min(r.width + pad * 2, 1440 - Math.max(0, r.x - pad)),
      height: Math.min(r.height + pad * 2, 1400 - Math.max(0, r.y - pad)),
      scale: 2,
    };
  })()`);
  if (clip) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
    writeFileSync(`${OUT}/02-ready-card-closeup.png`, Buffer.from(data, 'base64'));
    note(`screenshot: 02-ready-card-closeup.png (element clip, ${Math.round(clip.width)}×${Math.round(clip.height)})`);
  } else {
    note('could not element-clip the ready card (fell back to full page)');
  }

  // ── 4b. Expand the “Generation constraints applied” details view ──────
  // The transparency view: clicking the summary expands the list of applied
  // constraints (servings, diet, allergens avoided) before Start cooking.
  console.log('\n[4b] Expanding the constraint details view');
  const expanded = await evaluate(`(() => {
    const summary = [...document.querySelectorAll('summary')]
      .find((s) => s.textContent.includes('Generation constraints applied'));
    if (!summary) return 'no-summary';
    summary.click();
    return 'expanded';
  })()`);
  if (expanded === 'expanded') ok('details expanded (clicked the summary)');
  else fail(`constraint summary not found (${expanded})`);
  await sleep(400);
  const rowsText = await evaluate(`(() => {
    const d = [...document.querySelectorAll('details')]
      .find((x) => x.querySelector('summary')?.textContent.includes('Generation constraints applied'));
    return d?.innerText?.replace(/\\s+/g, ' ').trim() ?? '';
  })()`);
  for (const phrase of ['Servings: 4', 'Diet: vegetarian', 'Allergens avoided: no peanuts']) {
    rowsText.includes(phrase)
      ? ok(`constraint list shows “${phrase}”`)
      : fail(`constraint list missing “${phrase}”. Rows: ${rowsText.slice(0, 200)}`);
  }
  await evaluate(`(() => {
    const d = [...document.querySelectorAll('details')]
      .find((x) => x.querySelector('summary')?.textContent.includes('Generation constraints applied'));
    if (d) d.scrollIntoView({ block: 'center' });
    return !!d;
  })()`);
  await sleep(400);
  const dClip = await evaluate(`(() => {
    const d = [...document.querySelectorAll('details')]
      .find((x) => x.querySelector('summary')?.textContent.includes('Generation constraints applied'));
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const pad = 20;
    return {
      x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
      width: Math.min(r.width + pad * 2, 1440 - Math.max(0, r.x - pad)),
      height: Math.min(r.height + pad * 2, 1400 - Math.max(0, r.y - pad)),
      scale: 2,
    };
  })()`);
  if (dClip) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: dClip });
    writeFileSync(`${OUT}/03-constraints-details-open.png`, Buffer.from(data, 'base64'));
    note(`screenshot: 03-constraints-details-open.png (element clip, ${Math.round(dClip.width)}×${Math.round(dClip.height)})`);
  } else {
    note('could not element-clip the details view');
  }
} else if (st.error) {
  fail(`starter showed an error: ${st.error.slice(0, 160)}`);
} else {
  fail('no result after 120s (create_recipe did not return)');
}

// ── 5. Cleanup: rename the probe recipe to a sweep-compatible id + delete ──
console.log(`\n[5] Cleanup: sweep the created probe recipe`);
const db = getAdminDb();
if (st.ready) {
  try {
    // Delete EXACTLY the recipe this run created, identified by the
    // data-recipe-id the ready card exposes — never "the owner's newest
    // updatedAt row", which could be a concurrent CI run's seed and would be
    // deleted out from under it.
    const createdId = st.recipeId;
    if (!createdId) {
      note('ready card did not expose the created recipe id — nothing to sweep (a killed run is backstopped by the pre-run sweep)');
    } else {
      const createdSnap = await db.collection('recipes').doc(createdId).get();
      if (!createdSnap.exists) {
        note(`created recipe ${createdId} already gone — nothing to sweep`);
      } else {
        // First copy under a sweep-compatible id (so a KILLED run's probe is
        // still caught by the matching pre-run sweep), then delete BOTH the
        // original doc and the renamed copy — a normal run must leave the
        // owner's list exactly as it found it.
        const probeId = `${PROBE_PREFIX}${Date.now()}`;
        await db.collection('recipes').doc(probeId).set({ ...createdSnap.data(), id: probeId, updatedAt: Date.now() });
        await db.collection('recipes').doc(createdId).delete();
        await db.collection('recipes').doc(probeId).delete();
        ok(`probe recipe “${createdSnap.data().title ?? createdId}” swept (renamed → deleted → copy deleted, id ${probeId})`);
      }
    }
  } catch (e) {
    note(`cleanup best-effort: ${e.message} — verify:live's pre-run sweep archives any leftover probe`);
  }
} else {
  note('no ready card → nothing to sweep');
}

ws.close(); chrome.kill(); dropProfile();
console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
