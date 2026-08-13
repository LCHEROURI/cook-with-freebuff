#!/usr/bin/env node
// ============================================================================
// Repeatable driver: prove the /recipes "My Recipes" page on the DEPLOYED app
// with a REAL owner session (same scaffolding as drive-starter-prefs.mjs).
//
//   1. Loads .env.local, mints a real owner ID token, launches headless Chrome
//      + CDP, and injects the owner session into Firebase auth persistence.
//   2. Loads /recipes and confirms the saved-recipe cards render (owner has
//      20+ recipes).
//   3. Screenshots the unfiltered list (search box + protein chips visible).
//   4. Clicks the first protein chip and screenshots the filtered list,
//      asserting the live count line flips to "N of M recipes".
//   5. Resets to "All", types a search term (a substring of a real recipe
//      title), and screenshots the narrowed result.
//
// Usage: node scripts/drive-recipes-page.mjs [--out /tmp/recipes-proof]
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
const OUT = flag('--out', '/tmp/recipes-proof');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9474;
const USER_DATA_DIR = `/tmp/recipes-chrome-${process.pid}-${Date.now()}`;

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
ok(`owner idToken minted for ${tokenPayload.sub}`);

// ── 2. Launch headless Chrome + CDP ─────────────────────────────────────────
console.log(`\n[2] Launching headless Chrome (CDP :${PORT})`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1440,1600',
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
const pageText = () => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 2500) || ''`);
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  note(`screenshot: ${name}.png`);
};

// ── 3. Inject the owner session, load /recipes ──────────────────────────────
// NOTE: navigate to /recipes first to establish the origin (so indexedDB /
// localStorage are writable), inject the session, then navigate AGAIN. A plain
// reload would land on /login (the first load redirects there with no session).
console.log(`\n[3] Injecting owner session → loading ${APP}/recipes`);
await send('Page.navigate', { url: `${APP}/recipes` });
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
  })();
  localStorage.setItem(key, JSON.stringify(record.value));
  return 'injected';
})()`);
await send('Page.navigate', { url: `${APP}/recipes` });
await sleep(4500);

// Confirm we actually landed on /recipes (not redirected to /cook or /login).
const currentUrl = await evaluate(`location.pathname`);
if (currentUrl === '/recipes') ok(`landed on ${currentUrl}`);
else fail(`expected /recipes but landed on ${currentUrl} (session redirect?)`);

// Wait for the recipe cards to load (the live count line + at least one card).
const countLine = () => evaluate(`document.querySelector('[aria-live="polite"]')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`);
const cardCount = () => evaluate(`document.querySelectorAll('button[aria-label^="Start cooking "]').length`);
const chips = () => evaluate(`[...document.querySelectorAll('nav[aria-label="Filter by protein"] button')].map((b) => b.textContent.trim())`);

let count = await countLine();
let cards = await cardCount();
for (let i = 0; i < 20 && cards === 0; i++) {
  await sleep(1000);
  count = await countLine();
  cards = await cardCount();
}
if (cards > 0) {
  ok(`recipe cards rendered (${cards} cards, count line: “${count}”)`);
} else {
  fail(`/recipes did not show any recipe cards. Page text: ${(await pageText()).slice(0, 300)}`);
}

await screenshot('01-recipes-all');

// ── 4. Click the first protein chip and assert the filter narrows ──────────
console.log('\n[4] Filtering by the first protein chip');
const chipLabels = await chips();
const firstChip = chipLabels.find((c) => c !== 'All');
if (!firstChip) {
  fail('no protein chips rendered to filter by');
} else {
  const clicked = await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="Filter by protein"]');
    const btn = [...nav.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(firstChip)});
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  if (clicked === 'clicked') ok(`clicked “${firstChip}” chip`);
  else fail(`could not click “${firstChip}” chip (${clicked})`);

  await sleep(700);
  const filteredCount = await countLine();
  const filteredCards = await cardCount();
  const narrowed = /^\d+ of \d+ recipes$/.test(filteredCount) && filteredCards > 0 && filteredCards < cards;
  if (narrowed) ok(`list narrowed: “${filteredCount}” (${filteredCards} cards, was ${cards})`);
  else fail(`filter did not narrow the list. Count: “${filteredCount}”, cards ${filteredCards} (was ${cards})`);

  await screenshot('02-recipes-filtered');

  // ── 5. Reset, then search ────────────────────────────────────────────────
  console.log('\n[5] Searching by title substring');
  await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="Filter by protein"]');
    const all = [...nav.querySelectorAll('button')].find((b) => b.textContent.trim() === 'All');
    all?.click();
    return 'reset';
  })()`);
  await sleep(500);

  const searchTerm = await evaluate(`(() => {
    const first = document.querySelector('button[aria-label^="Start cooking "]');
    const name = first?.closest('li')?.querySelector('p')?.innerText ?? '';
    const title = name.split('\\n')[0].trim();
    return title.split(' ').slice(0, 2).join(' ');
  })()`);
  if (!searchTerm) {
    fail('could not derive a search term from the first card title');
  } else {
    const typed = await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search recipes"]');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(searchTerm)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    if (typed === 'typed') ok(`typed “${searchTerm}” into the search box`);
    else fail(`search input not found (${typed})`);

    await sleep(700);
    const searchCount = await countLine();
    const searchCards = await cardCount();
    if (searchCards > 0 && /^\d+( of \d+ recipes)?$/.test(searchCount)) {
      ok(`search narrowed to: “${searchCount}” (${searchCards} cards)`);
    } else {
      fail(`search returned nothing unexpected. Count: “${searchCount}”, cards ${searchCards}`);
    }
    await screenshot('03-recipes-search');
  }
}

ws.close(); chrome.kill(); dropProfile();
console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
