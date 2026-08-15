#!/usr/bin/env node
// ============================================================================
// scripts/drive-login-popup.mjs — prove the DEPLOYED login page's OAuth popup.
//
// The one config regression that bit the App Hosting migration: the canonical
// hostname fell out of Firebase Auth's authorized domains, so every sign-in
// dead-ended with "Sign-in is blocked" and none of the API-only stages caught
// it (they mint tokens server-side and never touch the client popup). This
// driver closes that gap by driving the REAL /login page in a FRESH headless
// Chrome profile and proving the "Continue with Google" click opens the OAuth
// popup (the SDK's origin check passed) instead of throwing
// auth/unauthorized-domain.
//
//   1. Loads env (process.env wins; .env.local fills gaps).
//   2. Launches headless Chrome with a fresh user-data dir + CDP (so no cached
//      SDK origin rejection can hide a real config failure).
//   3. Loads /login, asserts the button renders with NO pre-existing
//      "Sign-in is blocked" banner.
//   4. Clicks "Continue with Google" with a GENUINE CDP mouse click (a real
//      mousePressed/mouseReleased pair, never a synthetic programmatic click),
//      then watches Target discovery for the popup target to navigate to a
//      Google auth URL (the firebaseapp.com auth handler is the first hop
//      before accounts.google.com).
//   5. Asserts the main page still shows NO "Sign-in is blocked" banner, so a
//      genuinely-authorized domain is proven end to end.
//
// Usage: node scripts/drive-login-popup.mjs [--app URL] [--out /tmp/login]
// Exit 0 + "RESULT: PASS" = popup opened, no domain error; 1 = FAIL.
// ============================================================================

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ── Env loading (process.env wins; .env.local fills the gaps) ───────────────
function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {
    // No .env.local — rely on process.env (CI passes vars directly).
  }
}
loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const APP = (flag('--app', process.env.VERIFY_BASE_URL) ?? 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app').replace(/\/$/, '');
const OUT = flag('--out', '/tmp/cook-login-popup');
// Resolve a Chrome/Chromium binary for headless driving. CI sets CHROME_PATH
// (browser-actions/setup-chrome threads it into the step), but a local run on
// any OS has to find the browser without hand-editing the script. The order:
// an explicit CHROME_PATH first (always honoured, even if the file is missing,
// so the spawn's error names the real path), then a per-OS search of the usual
// install locations. Edge is a Chromium binary, so it is the Windows fallback.
function resolveChrome() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      home ? `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` : null,
    );
  } else if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      localAppData ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` : null,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const CHROME = resolveChrome();
const PORT = 9479;
const USER_DATA_DIR = `/tmp/cook-login-chrome-${process.pid}-${Date.now()}`;

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { failures += 1; console.log(`  ✗ FAIL: ${m}`); };
const note = (m) => console.log(`  - ${m}`);
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1440,1400',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, 'about:blank',
], { stdio: 'ignore' });
chrome.on('error', (err) => {
  console.error(`✗ FAIL: could not launch Chrome at ${CHROME}: ${err.message}`);
  process.exit(1);
});
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
const seenTargets = new Set();
const popupUrls = [];
let mainTargetId = null;

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: r, reject: j } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
  } else if (m.method === 'Target.targetCreated') {
    const t = m.params?.targetInfo;
    if (t && t.type === 'page' && !seenTargets.has(t.targetId)) {
      seenTargets.add(t.targetId);
      if (!mainTargetId) mainTargetId = t.targetId;
      else {
        popupUrls.push({ targetId: t.targetId, url: t.url, openerId: t.openerId ?? null });
        note(`popup target created: ${t.url || '(about:blank)'}`);
      }
    }
  } else if (m.method === 'Target.targetInfoChanged') {
    const t = m.params?.targetInfo;
    if (t && t.type === 'page' && t.targetId !== mainTargetId) {
      const rec = popupUrls.find((p) => p.targetId === t.targetId);
      if (rec) rec.url = t.url;
      note(`popup target navigated: ${t.url}`);
    }
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
const pageText = () => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 800) || ''`);
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  note(`screenshot: ${name}.png`);
};

// Discover targets so the OAuth popup is visible.
await send('Target.setDiscoverTargets', { discover: true });

// ── Load the deployed login page (fresh profile, no cached origin rejection) ─
console.log(`\n[1] Loading ${APP}/login`);
await send('Page.navigate', { url: `${APP}/login` });

// Poll for the button instead of a fixed sleep: a cold /login compile (local
// mode warms /api/cook + /api/agent but not /login) or a slow first paint can
// exceed any fixed delay, and a premature check would false-fail the gate.
let text = await pageText();
let hasButton = text.includes('Continue with Google');
for (let i = 0; i < 40 && !hasButton; i++) {
  await sleep(500);
  text = await pageText();
  hasButton = text.includes('Continue with Google');
}
const hasBanner = text.includes('Sign-in is blocked');
if (hasButton) ok('login page rendered the "Continue with Google" button');
else fail(`login page did not show the button. Page text: ${text.slice(0, 200)}`);
if (!hasBanner) ok('no "Sign-in is blocked" banner before clicking (fresh profile)');
else fail('banner already present before any click');
await screenshot('01-login-before-click');

// ── Click the real button with a genuine CDP mouse click ─────────────────────
console.log(`\n[2] Clicking "Continue with Google"`);
const btnInfo = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Continue with Google'));
  if (!b) return null;
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
if (!btnInfo) { fail('button not found for click'); }
else {
  await sleep(400);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
  note(`dispatched click at (${btnInfo.x}, ${btnInfo.y})`);
}

// ── Watch for the popup (and for the error banner on the main page) ──────────
console.log(`\n[3] Watching for the OAuth popup (up to 15s)`);
let popupSawGoogle = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const targets = await send('Target.getTargets').catch(() => ({ targetInfos: [] }));
  for (const t of targets.targetInfos ?? []) {
    if (t.type !== 'page' || t.targetId === mainTargetId) continue;
    if (!seenTargets.has(t.targetId)) {
      seenTargets.add(t.targetId);
      popupUrls.push({ targetId: t.targetId, url: t.url, openerId: null });
      note(`popup target discovered: ${t.url || '(about:blank)'}`);
    }
  }
  popupSawGoogle = popupUrls.some((p) => /accounts\.google\.com|\.google\.com|firebaseapp\.com|googleapis\.com/i.test(p.url ?? ''));
  if (popupSawGoogle) break;
}

const textAfter = await pageText();
const bannerAfter = textAfter.includes('Sign-in is blocked');

console.log(`\n[4] Verdict`);
if (popupSawGoogle) {
  const googleUrl = popupUrls.find((p) => /google|firebaseapp/i.test(p.url ?? ''))?.url;
  ok(`OAuth popup opened and navigated to a Google auth URL (${googleUrl?.slice(0, 90)}…)`);
} else {
  fail(`no Google OAuth popup observed. Popups seen: ${popupUrls.map((p) => p.url || '(blank)').join(', ') || 'none'}`);
}
if (!bannerAfter) ok('no "Sign-in is blocked" banner after clicking (domain check passed)');
else fail(`banner appeared after click: "${textAfter.slice(0, 200)}"`);
await screenshot('02-login-after-click');

killChrome();
dropProfile();
console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
