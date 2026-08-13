#!/usr/bin/env node
// ============================================================================
// Repeatable driver: capture the universal-UI-skin on the DEPLOYED app.
//
//   1. Loads .env.local (plain KEY=VALUE, quotes stripped).
//   2. Mints a real owner ID token (SA-signed custom token → exchange).
//   3. Launches headless Chrome + CDP, injects the owner session into
//      Firebase auth persistence, then loads the app.
//   4. Screenshots three screens in order:
//        /         — landing (signed-in CTA row: Start cooking + My kitchen)
//        /kitchen  — the inspect-and-change kitchen surface
//        /cook     — the starter (recipe creation entry)
//   5. Exits 0 with RESULT: PASS (visual capture only — no assertions beyond
//      the owner being signed in and each route rendering its heading).
//
//   --dark: force prefers-color-scheme: dark via CDP media emulation BEFORE
//   any navigation, so the app's own dark palette renders (it is NOT the
//   browser's auto-darkening). The default out dir becomes /tmp/cook-ui-skin-dark
//   so light and dark captures never overwrite each other.
//
// Usage: node scripts/drive-ui-skin.mjs [--out /tmp/cook-ui-skin] [--app URL] [--dark]
// ============================================================================

import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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
const DARK = args.includes('--dark');
const OUT = flag('--out', DARK ? '/tmp/cook-ui-skin-dark' : '/tmp/cook-ui-skin');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9474;
const USER_DATA_DIR = `/tmp/cook-ui-skin-chrome-${process.pid}-${Date.now()}`;

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

// ── 3. Force the color scheme (dark via CDP emulation) + inject session ─────
if (DARK) {
  console.log('\n[3] Forcing prefers-color-scheme: dark via CDP media emulation');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  const matched = await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`);
  if (matched === true) ok('the emulated page sees prefers-color-scheme: dark');
  else fail(`dark emulation did not apply (matchMedia returned ${matched})`);
}

console.log(`\n[4] Injecting owner session → loading ${APP}/`);
await send('Page.navigate', { url: `${APP}/` });
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

// ── 4. Capture the three screens ────────────────────────────────────────────
console.log(`\n[5] Capturing screens (${DARK ? 'dark' : 'light'} mode)`);
let text = await pageText();
let sawCta = text.includes('Start cooking');
for (let i = 0; i < 15 && !sawCta; i++) {
  await sleep(1000);
  text = await pageText();
  sawCta = text.includes('Start cooking');
}
if (sawCta) ok('home page shows the signed-in CTA (Start cooking + My kitchen)');
else fail(`home page did not show the CTA. Page text: ${text.slice(0, 250)}`);
await screenshot('01-home');

console.log('\n[6] /kitchen');
await send('Page.navigate', { url: `${APP}/kitchen` });
await sleep(4000);
text = await pageText();
let sawKitchen = text.includes('My Kitchen');
for (let i = 0; i < 15 && !sawKitchen; i++) {
  await sleep(1000);
  text = await pageText();
  sawKitchen = text.includes('My Kitchen');
}
if (sawKitchen) ok('/kitchen renders the kitchen surface');
else fail(`/kitchen did not render. Page text: ${text.slice(0, 250)}`);
await screenshot('02-kitchen');

console.log('\n[7] /cook');
await send('Page.navigate', { url: `${APP}/cook` });
await sleep(4000);
text = await pageText();
let sawCook = text.includes('Cook With Me');
for (let i = 0; i < 15 && !sawCook; i++) {
  await sleep(1000);
  text = await pageText();
  sawCook = text.includes('Cook With Me');
}
if (sawCook) ok('/cook renders the starter');
else fail(`/cook did not render. Page text: ${text.slice(0, 250)}`);
await screenshot('03-cook');

// ── 5. Teardown ─────────────────────────────────────────────────────────────
dropProfile();
killChrome();
console.log(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
