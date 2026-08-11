#!/usr/bin/env node
// ============================================================================
// Repeatable axe accessibility audit of the DEPLOYED app.
//
//   1. Loads .env.local (plain KEY=VALUE, quotes stripped).
//   2. Mints a real owner ID token (SA-signed custom token → exchange) and
//      injects the owner session so the auth-gated routes (/cook, /kitchen)
//      are audited in their signed-in state.
//   3. On every route it injects axe-core (from node_modules) into the LOADED
//      document and runs axe.run() on /, /cook, /kitchen — in light mode, or
//      dark mode with --dark (CDP media emulation, the app's own palette).
//   4. Prints every violation (rule, impact, failing nodes) and exits:
//        exit 0 — no violations
//        exit 1 — at least one violation (any impact) or an audit error
//
// Usage: node scripts/audit-a11y.mjs [--app URL] [--dark]
// ============================================================================

import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
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
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff.vercel.app').replace(/\/$/, '');
const DARK = args.includes('--dark');
const ROUTES = ['/', '/cook', '/kitchen'];
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9481;
const USER_DATA_DIR = `/tmp/audit-a11y-chrome-${process.pid}-${Date.now()}`;

const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const AXE_SOURCE = readFileSync(resolvePath(process.cwd(), 'node_modules/axe-core/axe.min.js'), 'utf8');

let violations = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { violations += 1; console.log(`  ✗ ${m}`); };
const note = (m) => console.log(`  - ${m}`);

if (!API_KEY || !OWNER_UID || !SA_JSON) {
  console.error('✗ FAIL: NEXT_PUBLIC_FIREBASE_API_KEY / APP_OWNER_UID / FIREBASE_SERVICE_ACCOUNT required');
  process.exit(1);
}

// ── 1. Mint a REAL owner session ────────────────────────────────────────────
console.log('\n[1] Minting owner session (' + OWNER_UID.slice(0, 10) + '…) via SA-signed custom token');
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
const exchange = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `${header}.${claims}.${sig}`, returnSecureToken: true }) },
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
  '--unsafely-treat-insecure-origin-as-secure=http://localhost:3105',
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
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    throw new Error(`page exception: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`.slice(0, 300));
  }
  return result?.value;
};
const pageText = () => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 600) || ''`);
const navigateAndWait = async (path, expectText) => {
  await send('Page.navigate', { url: `${APP}${path}` });
  await sleep(4500);
  let text = await pageText();
  for (let i = 0; i < 15 && !text.includes(expectText); i++) {
    await sleep(1000);
    text = await pageText();
  }
  return text;
};

// ── 3. Color scheme + owner session ─────────────────────────────────────────
console.log(`\n[3] Preparing (${DARK ? 'dark' : 'light'} mode)`);
if (DARK) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
}

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
ok('owner session injected');

// ── 4. Audit each route ─────────────────────────────────────────────────────
const EXPECT = { '/': 'Start cooking', '/cook': 'Cook With Me', '/kitchen': 'My Kitchen' };
const results = [];
for (const route of ROUTES) {
  console.log(`\n[4] axe audit — ${APP}${route} (${DARK ? 'dark' : 'light'})`);
  const text = await navigateAndWait(route, EXPECT[route]);
  if (!text.includes(EXPECT[route])) {
    fail(`route did not render expected content (“${EXPECT[route]}”). Page: ${text.slice(0, 200)}`);
    results.push({ route, error: 'route did not render' });
    continue;
  }
  // Inject axe into THIS loaded document, then verify it took.
  await evaluate(AXE_SOURCE);
  const axeType = await evaluate('typeof axe');
  if (axeType !== 'object') {
    fail(`axe did not load on ${route} (typeof axe = ${axeType})`);
    results.push({ route, error: 'axe failed to load' });
    continue;
  }
  const report = await evaluate(`(async () => {
    const r = await axe.run(document, { resultTypes: ['violations', 'incomplete'] });
    return JSON.stringify({
      violations: r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n) => ({
          target: n.target.join(' '),
          summary: (n.failureSummary || '').split('\\n')[0].slice(0, 220),
        })),
      })),
      incomplete: r.incomplete.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\\n')[0].slice(0, 220) })) })),
    });
  })()`);
  const parsed = JSON.parse(report);
  results.push({ route, ...parsed });
  if (parsed.violations.length === 0) {
    ok('no axe violations');
  }
  for (const v of parsed.violations) {
    fail(`[${v.impact}] ${v.id} — ${v.help}`);
    for (const n of v.nodes) {
      note(`   node: ${n.target} — ${n.summary}`);
    }
    note(`   fix: ${v.helpUrl}`);
  }
  if (parsed.incomplete.length > 0) {
    for (const v of parsed.incomplete) {
      note(`   needs review: [${v.impact}] ${v.id}`);
      for (const n of v.nodes) {
        note(`     node: ${n.target} — ${n.summary}`);
      }
    }
  }
}

// ── 5. Summary ──────────────────────────────────────────────────────────────
let total = 0;
for (const r of results) total += r.violations?.length ?? 0;
console.log(`\n=== AXE AUDIT SUMMARY (${DARK ? 'dark' : 'light'}, ${APP}) ===`);
for (const r of results) {
  console.log(`  ${r.route} — ${r.violations?.length ?? (r.error ? 1 : 0)} violation(s)${r.incomplete?.length ? `, ${r.incomplete.length} needs-review` : ''}${r.error ? ` (${r.error})` : ''}`);
}
console.log(`TOTAL: ${total} violation(s) across ${ROUTES.length} routes`);
dropProfile();
killChrome();
console.log(`\nAUDIT RESULT: ${total === 0 ? 'PASS' : 'FAIL'} (${total} violations)`);
process.exit(total === 0 ? 0 : 1);
