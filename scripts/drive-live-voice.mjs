#!/usr/bin/env node
// ============================================================================
// Repeatable driver: prove the REAL Gemini Live voice surface on the DEPLOYED
// /cook screen with a REAL owner session — BOTH mics:
//
//   PHASE A — starter DICTATION mic (the recipe starter, no active session).
//     Feeds REAL speech audio (macOS say → 16 kHz PCM WAV) through the fake
//     media device, taps "Speak your ingredients", and asserts the tool-free
//     session transcribes it: ephemeral token minted, constrained WebSocket,
//     setupComplete, the sent setup frame carries NO tools (the model cannot
//     act on a spoken prompt before review), and the FINAL transcription
//     fills the starter input.
//
//   PHASE B — active-screen Live mic (after launching a probe recipe).
//     Taps the mic with a silence fake-device (no unsolicited speech), asserts
//     the handshake + LISTENING state, streams mic audio, then drives two
//     text turns through the SAME live conversation and asserts the spoken
//     replies (outputTranscription) render in the Kitchen Agent box + the
//     scrollable transcript log.
//
// Probe hygiene: the seeded recipe uses the `verify-live-voice-` prefix
// (inside verify:live's `verify-live-` sweep namespace), cleanup runs on EVERY
// exit path, and the pre-run sweep backstops a hard-killed run — a killed run
// can NEVER leave a stale ACTIVE session that hijacks the owner's /cook.
//
// Usage: node scripts/drive-live-voice.mjs [--out /tmp/live-voice-drive]
//        node scripts/drive-live-voice.mjs --phase-c-only   # two-burst phase only
//        Cross-platform: macOS synthesizes FRESH speech via say/afconvert when
//        available; anywhere else (e.g. the Linux CI runner) it falls back to
//        the committed fixture scripts/fixtures/dictation-speech.wav — REAL
//        recorded speech, so Gemini's inputAudioTranscription transcribes
//        actual words on every platform.
// ============================================================================

import { spawn, execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { evaluateVoiceBlob } from './voice-blob-verdict.mjs';

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
const OUT = flag('--out', '/tmp/live-voice-drive');
// Run ONLY the two-burst phase (used to measure its pass rate across repeated
// runs — Phase A and B are skipped, and the owner session is injected fresh).
const PHASE_C_ONLY = process.argv.includes('--phase-c-only');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SPEECH_WAV = '/tmp/live-voice-speech.wav';
const SILENCE_WAV = '/tmp/live-voice-silence.wav';
const PROBE_PREFIX = 'verify-live-voice-';
const SPOKEN_PROMPT = 'chicken, rice and onion, for four people';

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

const getAdminDb = () => {
  const apps = getApps();
  const adminApp = apps[0] ?? initializeApp({
    credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key.replace(/\\n/g, '\n') }),
  });
  return getFirestore(adminApp);
};

// ── Guaranteed cleanup on every exit path ───────────────────────────────────
const probeSids = new Set();
let seededRecipeId = null;
let cleanupRan = false;
async function cleanup() {
  if (cleanupRan) return;
  cleanupRan = true;
  try {
    const db = getAdminDb();
    for (const sid of probeSids) {
      try {
        const events = await db.collection('cooking_session_events').where('sessionId', '==', sid).get();
        await Promise.allSettled(events.docs.map((d) => d.ref.delete()));
        await db.collection('cooking_sessions').doc(sid).delete();
        console.log(`  ↳ cleanup: probe session ${sid.slice(0, 8)}… deleted (+ ${events.size} events)`);
      } catch (e) {
        note(`cleanup session ${sid.slice(0, 8)}… best-effort: ${e.message}`);
      }
    }
    if (seededRecipeId) {
      try {
        await db.collection('recipes').doc(seededRecipeId).delete();
        console.log(`  ↳ cleanup: probe recipe ${seededRecipeId} deleted`);
      } catch (e) {
        note(`cleanup recipe best-effort: ${e.message}`);
      }
    }
  } catch { /* best-effort */ }
}
const exitWithCleanup = async (code, reason) => {
  if (!cleanupRan) {
    try { await cleanup(); } catch { /* best-effort */ }
  }
  console.error(reason);
  process.exit(code);
};
process.on('SIGINT', () => void exitWithCleanup(130, 'drive-live-voice interrupted (SIGINT) — cleanup ran'));
process.on('SIGTERM', () => void exitWithCleanup(143, 'drive-live-voice terminated (SIGTERM) — cleanup ran'));
process.on('SIGHUP', () => void exitWithCleanup(129, 'drive-live-voice hung up (SIGHUP) — cleanup ran'));
process.on('unhandledRejection', (e) => {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  console.error(`✗ FAIL: unhandled rejection — ${msg}`);
  void exitWithCleanup(1, 'drive-live-voice crashed — cleanup ran');
});
process.on('uncaughtException', (e) => {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  console.error(`✗ FAIL: uncaught exception — ${msg}`);
  void exitWithCleanup(1, 'drive-live-voice crashed — cleanup ran');
});

// ── Pre-run sweep: never let a killed run's leftovers hijack the owner ──────
async function sweepStaleProbes() {
  const db = getAdminDb();
  const [sessionSnap, recipeSnap] = await Promise.all([
    db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get(),
    db.collection('recipes').where('userId', '==', OWNER_UID).get(),
  ]);
  const probeSessions = sessionSnap.docs.filter((d) => {
    const s = d.data();
    return (
      typeof s.recipeId === 'string' &&
      s.recipeId.startsWith(PROBE_PREFIX) &&
      (s.status === 'ACTIVE' || s.status === 'PAUSED')
    );
  });
  let archived = 0;
  for (const d of probeSessions) {
    await d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() });
    archived += 1;
  }
  const liveProbeRecipeIds = new Set(probeSessions.map((d) => d.data().recipeId));
  const deletes = recipeSnap.docs
    .filter((d) => typeof d.id === 'string' && d.id.startsWith(PROBE_PREFIX) && !liveProbeRecipeIds.has(d.id))
    .map((d) => d.ref.delete());
  await Promise.allSettled(deletes);
  if (archived > 0 || deletes.length > 0) {
    console.log(`  ↳ pre-run sweep: archived ${archived} stale probe session(s), deleted ${deletes.length} orphaned probe recipe(s)`);
  }
}

// ── Fake audio files ────────────────────────────────────────────────────────
// Speech: REAL synthesized voice (macOS say → 16 kHz mono PCM WAV) — Gemini's
// inputAudioTranscription must hear and transcribe it for the dictation stage.
// Silence: a 2s zero WAV so the ACTIVE screen's mic capture streams no speech
// (the spoken replies there are driven by the typed text turns).
function makeSilenceWav(path, seconds = 2, rate = 16000) {
  const numSamples = Math.floor(rate * seconds);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  writeFileSync(path, buf);
}
console.log(`\n[1b] Generating fake audio: speech (“${SPOKEN_PROMPT}”) + silence`);
let speechSynthesized = false;
if (process.env.LIVE_VOICE_USE_FIXTURE !== '1') {
  try {
    // macOS: synthesize FRESH speech so the dictation stage hears today's voice.
    execFileSync('say', ['-o', '/tmp/live-voice-speech.aiff', SPOKEN_PROMPT], { stdio: 'ignore' });
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', '/tmp/live-voice-speech.aiff', SPEECH_WAV], { stdio: 'ignore' });
    speechSynthesized = true;
    ok('speech audio synthesized fresh (macOS say → 16 kHz PCM WAV)');
  } catch {
    // fall through to the fixture
  }
}
if (!speechSynthesized) {
  // Linux (CI runner) has no `say` — use the committed fixture: the SAME real
  // recorded speech, so the transcription path is platform-independent.
  copyFileSync(fileURLToPath(new URL('./fixtures/dictation-speech.wav', import.meta.url)), SPEECH_WAV);
  note(`using the committed speech fixture (${readFileSync(SPEECH_WAV).length}b)`);
}
makeSilenceWav(SILENCE_WAV);

// The dictation stage needs a real end-of-utterance: Chrome loops the fake
// capture file, so a speech-only WAV streams continuous audio and the
// client's flush-on-silence never fires (no 1.2s of trailing silence) — the
// transcription never lands. Rebuild the speech WAV with ~3s of silence
// appended so the mic hears "say the prompt, then stop", like a real user.
function appendSilenceTail(wavPath, seconds = 3) {
  const buf = readFileSync(wavPath);
  const rate = buf.readUInt32LE(24);
  // Data chunk: skip the 44-byte header (pcm16 mono — what say/afconvert and
  // the fixture both produce).
  const pcm = buf.subarray(44);
  const numSamples = Math.floor(rate * seconds);
  const pcmWithSilence = Buffer.concat([pcm, Buffer.alloc(numSamples * 2)]);
  const dataSize = pcmWithSilence.length;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  pcmWithSilence.copy(out, 44);
  writeFileSync(wavPath, out);
}
appendSilenceTail(SPEECH_WAV);
existsSync(SPEECH_WAV) && existsSync(SILENCE_WAV)
  ? ok(`speech+silence WAV (${readFileSync(SPEECH_WAV).length}b) + silence WAV ready`)
  : (console.error('✗ FAIL: fake audio files were not produced'), process.exit(1));

// ── Browser harness: one headless Chrome per phase, fresh profile ───────────
function launchChrome(fakeAudioWav, port) {
  const USER_DATA_DIR = `/tmp/live-voice-chrome-${process.pid}-${port}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--window-size=1440,1400',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${fakeAudioWav}`,
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`, `--user-data-dir=${USER_DATA_DIR}`, 'about:blank',
  ], { stdio: 'ignore' });
  const kill = () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } };
  const dropProfile = () => { try { rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } };
  return { chrome, kill, dropProfile, USER_DATA_DIR };
}
async function connectCdp(port) {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* starting */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome DevTools did not come up');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const networkEvents = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: r, reject: j } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
    } else if (m.method && m.method.startsWith('Network.')) {
      networkEvents.push(m);
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
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
    note(`screenshot: ${name}.png`);
  };
  await send('Network.enable');
  return { ws, send, evaluate, screenshot, networkEvents };
}
// CDP may deliver WS frames base64 — decode first so matching never depends on
// the transport encoding.
function framePayload(payloadData) {
  if (typeof payloadData !== 'string') return '';
  if (/^[A-Za-z0-9+/=\s]+$/.test(payloadData) && payloadData.length > 16) {
    try {
      const d = Buffer.from(payloadData, 'base64').toString('utf8');
      if (d.includes('{') && d.includes('}')) return d;
    } catch { /* not base64 JSON */ }
  }
  return payloadData;
}
const receivedFrames = (n) => n
  .filter((e) => e.method === 'Network.webSocketFrameReceived')
  .map((e) => framePayload(e.params.response?.payloadData));
const sentFrames = (n) => n
  .filter((e) => e.method === 'Network.webSocketFrameSent')
  .map((e) => framePayload(e.params.response?.payloadData));
const sawReceived = (n, needle) => receivedFrames(n).some((f) => f.includes(needle));
const wsUrlObserved = (n) => {
  const ev = n.find((e) => e.method === 'Network.webSocketCreated');
  return ev ? ev.params.url : null;
};
const tokenPosted = (n) =>
  n.some((e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/voice/token'));

// Capture the copy-voice-details blob — the exact artifact the deployed
// button produces — by patching navigator.clipboard.writeText and clicking
// the button (reading the clipboard back needs document focus, which a
// headless tab lacks). Returns the blob text, or a marker when the button is
// missing / nothing was captured.
async function captureVoiceDetailsBlob(cdp, evaluate) {
  try {
    await cdp.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin: APP,
    });
  } catch { /* older protocol — the page may still read the clipboard */ }
  return evaluate(`(async () => {
    const btn = document.querySelector('button[aria-label="Copy voice session details"]');
    if (!btn) return 'NO_COPY_BUTTON (not listening / no error visible)';
    let captured = null;
    try {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { captured = t; return orig(t).catch(() => undefined); };
    } catch { /* clipboard unavailable — click still runs the handler */ }
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return captured ?? 'BLob_CAPTURE_MISS';
  })()`);
}

// ── Session injection (same IndexedDB/localStorage recipe as the other drivers) ──
const AUTH_USER = {
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
const AUTH_USER_KEY = `firebase:authUser:${API_KEY}:[DEFAULT]`;
async function injectSession(evaluate) {
  await evaluate(`(async () => {
    const key = ${JSON.stringify(AUTH_USER_KEY)};
    const record = { fbase_key: key, value: ${JSON.stringify(JSON.stringify(AUTH_USER))} };
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
}
const pageText = (evaluate) => evaluate(`document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 1000) || ''`);

// Shared page-text state (set by whichever phase runs; Phase C reads it).
let text = '';

// Shared across phases: Phase A mints (and sets) it first; Phase B re-arms the
// watch and reassigns it. Declared here at module top level because Phase A's
// `if (!PHASE_C_ONLY)` block scopes `let` — a block-local declaration throws
// `minted is not defined` in Phase B (seen live: every full verify:live [3e]
// run crashed at the active-screen mic stage).
let minted;

// ── PHASE A: starter DICTATION mic ──────────────────────────────────────────
if (!PHASE_C_ONLY) {
console.log(`\n=== PHASE A — starter dictation mic (speech fake-audio) ===`);
const a = launchChrome(SPEECH_WAV, 9473);
let cdp;
try {
  cdp = await connectCdp(9473);
} catch (e) {
  console.error(`✗ FAIL: ${e.message}`); a.kill(); a.dropProfile(); process.exit(1);
}
const { evaluate: evA, networkEvents: netA, screenshot: shotA } = cdp;
await cdp.send('Page.navigate', { url: `${APP}/cook` });
await sleep(4000);
await injectSession(evA);
await cdp.send('Page.reload', { ignoreCache: true });
await sleep(3500);

text = await pageText(evA);
let sawStarter = text.includes('Create my recipe');
for (let i = 0; i < 20 && !sawStarter; i++) {
  await sleep(1000);
  text = await pageText(evA);
  sawStarter = text.includes('Create my recipe');
}
sawStarter ? ok('recipe starter shown (signed in, no active session)') : fail(`starter not shown. Page text: ${text.slice(0, 250)}`);
await shotA('01-starter-empty');

const micPre = await evA(`(() => {
  const mic = document.querySelector('button[aria-label="Speak your ingredients"]');
  return { mic: !!mic, disabled: mic ? mic.disabled : null };
})()`);
if (micPre.mic && !micPre.disabled) ok('dictation mic renders enabled (Gemini Live available)');
else fail(`dictation mic precondition not met: ${JSON.stringify(micPre)}`);

const starterState = () =>
  evA(`(() => {
    const input = document.querySelector('input[aria-label="What do you have to cook with?"]');
    const mic = document.querySelector('button[aria-label="Stop listening"], button[aria-label="Speak your ingredients"]');
    const error = [...document.querySelectorAll('[role="alert"]')].map((el) => el.innerText.trim()).find((t) => t.length > 0) || '';
    return { prompt: input ? input.value : '', listening: !!mic && mic.getAttribute('aria-pressed') === 'true', error };
  })()`);
const tappedA = await evA(`(() => {
  const mic = document.querySelector('button[aria-label="Speak your ingredients"]');
  if (!mic) return 'no-mic';
  mic.click();
  return 'tapped';
})()`);
tappedA === 'tapped' ? ok('dictation mic tapped') : fail(`dictation mic not found (${tappedA})`);
netA.length = 0; // watch only the dictation session's traffic

minted = tokenPosted(netA);
for (let i = 0; i < 30 && !minted; i++) { await sleep(500); minted = tokenPosted(netA); }
minted ? ok('ephemeral token minted (POST /api/voice/token)') : note('token POST not observed');
let wsUrlA = wsUrlObserved(netA);
for (let i = 0; i < 30 && !wsUrlA; i++) { await sleep(500); wsUrlA = wsUrlObserved(netA); }
wsUrlA && wsUrlA.includes('BidiGenerateContentConstrained') && wsUrlA.includes('access_token=')
  ? ok('Live WebSocket connected: BidiGenerateContentConstrained?access_token=…')
  : fail(`no constrained Live WebSocket observed (${(wsUrlA ?? '').slice(0, 90)})`);
let setupA = sawReceived(netA, 'setupComplete');
for (let i = 0; i < 30 && !setupA; i++) { await sleep(500); setupA = sawReceived(netA, 'setupComplete'); }
setupA ? ok('server acknowledged setup (setupComplete frame received)') : fail('no setupComplete frame from the server');

// TOOL-FREE contract: the setup frame the browser sent must carry no tools.
const setupFrames = sentFrames(netA).filter((f) => f.includes('"setup"'));
const toolFree = setupFrames.length > 0 && setupFrames.every((f) => !f.includes('functionDeclarations') && !f.includes('"tools"'));
toolFree
  ? ok(`tool-free dictation setup (${setupFrames.length} setup frame(s), no tools declared)`)
  : fail(`dictation setup is NOT tool-free: ${JSON.stringify(setupFrames.map((f) => f.slice(0, 120))).slice(0, 300)}`);

const tapTimeA = Date.now();
let stA = await starterState();
let filledAt = null;
for (let i = 0; i < 60 && !stA.prompt; i++) {
  await sleep(1000);
  stA = await starterState();
  if (stA.prompt) filledAt = Date.now();
}
if (stA.prompt) {
  const elapsed = Math.round(((filledAt ?? Date.now()) - tapTimeA) / 1000);
  ok(`spoken prompt filled the input in ${elapsed}s: “${stA.prompt}”`);
} else {
  const frames = sentFrames(netA).filter((f) => f.includes('realtimeInput') && f.includes('"audio"')).length;
  const inTranscriptions = receivedFrames(netA).filter((f) => f.includes('inputTranscription'));
  const inText = inTranscriptions
    .map((f) => { try { return JSON.parse(f).serverContent?.inputTranscription?.text ?? ''; } catch { return ''; } })
    .filter((t) => t.trim().length > 0);
  console.log(`  - wire evidence: audio frames sent=${frames}, inputTranscription frames=${inTranscriptions.length}, transcribed=${JSON.stringify(inText.slice(-3))}`);
  const errMsg = stA.error || (frames === 0 ? 'NO mic audio reached Gemini' : inText.length === 0 ? 'Gemini received audio but produced NO transcription' : 'transcription arrived but the UI did not fill');
  fail(`dictation did not fill the input after 60s — ${errMsg}`);
}
await shotA('02-dictation-prompt-filled');
a.kill(); a.dropProfile(); try { cdp.ws.close(); } catch { /* socket already gone */ }
}

// ── PHASE B: active-screen Live mic ─────────────────────────────────────────
let b = null;
let cdpB = null;
if (!PHASE_C_ONLY) {
console.log(`\n=== PHASE B — active-screen Live mic (silence fake-audio) ===`);
b = launchChrome(SILENCE_WAV, 9474);
try {
  cdpB = await connectCdp(9474);
} catch (e) {
  console.error(`✗ FAIL: ${e.message}`); b.kill(); b.dropProfile(); process.exit(1);
}
const { evaluate: evB, networkEvents: netB, screenshot: shotB } = cdpB;
await cdpB.send('Page.navigate', { url: `${APP}/cook` });
await sleep(4000);
await injectSession(evB);
await cdpB.send('Page.reload', { ignoreCache: true });
await sleep(3500);

text = await pageText(evB);
let sawOwner = text.includes('Create my recipe') || text.includes('Start over');
for (let i = 0; i < 15 && !sawOwner; i++) {
  await sleep(1000);
  text = await pageText(evB);
  sawOwner = text.includes('Create my recipe') || text.includes('Start over');
}
sawOwner ? ok('signed in as the owner on /cook') : fail(`owner session did not land. Page text: ${text.slice(0, 250)}`);

console.log(`\n[3b] Seeding probe recipe + launching a fresh session via /api/cook`);
await sweepStaleProbes();
const t = Date.now();
seededRecipeId = `${PROBE_PREFIX}${t}`;
await getAdminDb().collection('recipes').doc(seededRecipeId).set({
  id: seededRecipeId,
  userId: OWNER_UID,
  title: 'Verify Live Voice Chicken Rice',
  description: 'One-pan dinner used by drive-live-voice.mjs',
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
  source: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const launch = await fetch(`${APP}/api/cook`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ action: 'launch', recipeId: seededRecipeId }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let sid = null;
if (launch.status === 200 && launch.body?.success && launch.body?.data?.sessionId) {
  sid = launch.body.data.sessionId;
  probeSids.add(sid);
  ok(`launch → ${launch.body.data.phase} step ${launch.body.data.stepNumber} (session ${sid.slice(0, 8)}…)`);
  launch.body.data.phase === 'PREP_GUIDANCE' && launch.body.data.stepNumber === 1
    ? ok('fresh session starts at prep step 1')
    : fail(`expected PREP_GUIDANCE step 1, got ${launch.body.data.phase} step ${launch.body.data.stepNumber}`);
} else {
  fail(`launch → ${launch.status} ${JSON.stringify(launch.body ?? '').slice(0, 200)}`);
}

await cdpB.send('Page.reload', { ignoreCache: true });
await sleep(3500);
text = await pageText(evB);
// Gate on the ACTIVE screen's own signal — the "Speak a command" mic — not
// the probe recipe title, which also appears in the starter's "Your recipes"
// list (a reload that lands on the starter would false-pass on the title and
// then find no active-screen mic).
let sawActive = await evB(`!!document.querySelector('button[aria-label="Speak a command"]')`);
for (let i = 0; i < 15 && !sawActive; i++) {
  await sleep(1000);
  sawActive = await evB(`!!document.querySelector('button[aria-label="Speak a command"]')`);
}
sawActive ? ok('active guided screen shown on /cook (active-screen mic present)') : fail(`active screen not shown. Page text: ${text.slice(0, 300)}`);

const micPreB = await evB(`(() => {
  const mic = document.querySelector('button[aria-label="Speak a command"]');
  return { mic: !!mic, disabled: mic ? mic.disabled : null };
})()`);
if (micPreB.mic && !micPreB.disabled) ok('active-screen mic renders enabled (Web Audio available)');
else {
  fail(`active mic precondition not met: ${JSON.stringify(micPreB)}`);
  console.log(`  - DIAG: buttons=${JSON.stringify(await evB("([...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean))"))}`);
  console.log(`  - DIAG: voiceIndicator=${JSON.stringify(await evB("document.querySelector('.voice-indicator')?.getAttribute('data-status') ?? null"))}`);
  console.log(`  - DIAG: text=${JSON.stringify((await pageText(evB)).slice(0, 220))}`);
}

console.log(`\n[4] Tapping the active-screen mic (Gemini Live)`);
netB.length = 0;
const tappedB = await evB(`(() => {
  const mic = document.querySelector('button[aria-label="Speak a command"]');
  if (!mic) return 'no-mic';
  mic.click();
  return 'tapped';
})()`);
tappedB === 'tapped' ? ok('mic tapped') : fail(`mic not found (${tappedB})`);

minted = tokenPosted(netB);
for (let i = 0; i < 30 && !minted; i++) { await sleep(1000); minted = tokenPosted(netB); }
minted ? ok('ephemeral token minted — browser POSTed /api/voice/token') : fail('no client-side POST /api/voice/token observed (token was not minted)');
let wsUrlB = wsUrlObserved(netB);
for (let i = 0; i < 30 && !wsUrlB; i++) { await sleep(1000); wsUrlB = wsUrlObserved(netB); }
wsUrlB && wsUrlB.includes('BidiGenerateContentConstrained') && wsUrlB.includes('access_token=')
  ? ok('Live WebSocket connected: BidiGenerateContentConstrained?access_token=…')
  : fail(`WS connected but wrong endpoint: ${(wsUrlB ?? '').slice(0, 140)}`);
let setupB = sawReceived(netB, 'setupComplete');
for (let i = 0; i < 30 && !setupB; i++) { await sleep(1000); setupB = sawReceived(netB, 'setupComplete'); }
setupB ? ok('server acknowledged setup (setupComplete frame received)') : fail('no setupComplete frame from the server');

const liveUi = () =>
  evB(`(() => {
    const mic = document.querySelector('button[aria-label="Stop listening"]');
    const indicator = document.querySelector('.voice-indicator[data-status="LISTENING"]');
    const statusLine = [...document.querySelectorAll('[role="status"]')].find((el) => el.innerText.includes('🎙'));
    return {
      pressed: mic ? mic.getAttribute('aria-pressed') : null,
      indicator: indicator ? indicator.innerText.trim() : null,
      statusLine: statusLine ? statusLine.innerText.replace(/\\s+/g, ' ').trim() : null,
    };
  })()`);
let ui = await liveUi();
for (let i = 0; i < 30 && !(ui.pressed === 'true' && ui.indicator); i++) { await sleep(1000); ui = await liveUi(); }
if (ui.pressed === 'true' && ui.indicator === 'Listening…') ok('LISTENING state: mic aria-pressed, VoiceIndicator “Listening…”');
else fail(`LISTENING state missing: ${JSON.stringify(ui)}`);
(ui.statusLine ?? '').includes('Listening')
  ? ok(`🎙 status line: “${ui.statusLine}”`)
  : note(`status line: ${JSON.stringify(ui.statusLine)}`);
await sleep(2500);
const frames = sentFrames(netB).filter((f) => f.includes('realtimeInput') && f.includes('"audio"')).length;
frames > 0
  ? ok(`mic audio streaming to Gemini (${frames} realtimeInput audio frames sent)`)
  : note('no realtimeInput audio frames observed (headless audio graph silent — the session stays live; the replies are driven by the text turns)');
await shotB('03-mic-live-listening');

console.log(`\n[5] Sending two questions into the live session → spoken replies render`);
const typeAndSend = async (value) => {
  const typedQ = await evB(`(() => {
    const input = document.querySelector('input[aria-label="Speak or type a command"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  if (typedQ !== 'typed') return typedQ;
  await evB(`(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  return 'sent';
};
const replyBox = () =>
  evB(`(() => {
    const els = [...document.querySelectorAll('[role="status"]')];
    const box = els.find((el) => el.innerText.toUpperCase().includes('KITCHEN AGENT'));
    return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
const transcriptLog = () =>
  evB(`(() => {
    const log = document.querySelector('[role="log"][aria-label="Conversation transcript"]');
    return log ? log.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
const waitingForReply = () =>
  evB(`(() => {
    const ind = document.querySelector('.voice-indicator');
    return ind ? ind.getAttribute('data-status') : '';
  })()`);

const Q1 = 'What is one good tip for this step?';
const Q2 = 'Should I season the chicken now?';
const sendTurn = async (q, label) => {
  const res = await typeAndSend(q);
  res === 'sent' ? ok(`${label}: sent “${q}”`) : fail(`${label}: input not found (${res})`);
  let reply = await replyBox();
  for (let i = 0; i < 90 && !reply; i++) { await sleep(1000); reply = await replyBox(); }
  if (reply && reply !== 'KITCHEN AGENT') ok(`${label}: spoken reply rendered — “${reply.slice(0, 110)}”`);
  else fail(`${label}: no Kitchen Agent reply after 90s (got: ${JSON.stringify((reply || '').slice(0, 80))})`);
  for (let i = 0; i < 60; i++) {
    if ((await waitingForReply()) === 'LISTENING') break;
    await sleep(1000);
  }
  return reply;
};
await sendTurn(Q1, 'turn 1');
await sendTurn(Q2, 'turn 2');

const logText = await transcriptLog();
if (logText) {
  const hasQ1 = logText.includes('one good tip');
  const hasQ2 = logText.includes('season the chicken');
  const agentMentions = (logText.toUpperCase().match(/KITCHEN AGENT/g) ?? []).length;
  hasQ1 && hasQ2
    ? ok(`transcript log shows both utterances (“You …”) — ${agentMentions} Kitchen Agent rows`)
    : fail(`transcript log missing utterances: Q1=${hasQ1} Q2=${hasQ2} log: ${JSON.stringify(logText.slice(0, 200))}`);
  agentMentions >= 2
    ? ok('transcript log shows both spoken replies (re-readable history)')
    : fail(`transcript log has only ${agentMentions} Kitchen Agent row(s) — expected 2`);
} else {
  logText === ''
    ? fail('transcript log did not render (expected 2 turns)')
    : note(`transcript log state: ${JSON.stringify(logText.slice(0, 120))}`);
}

const otFrames = receivedFrames(netB).filter((f) => f.includes('outputTranscription'));
const otWithText = otFrames.filter((f) => {
  try { const p = JSON.parse(f); return (p?.serverContent?.outputTranscription?.text ?? '').trim().length > 0; } catch { return false; }
});
otFrames.length > 0
  ? ok(`model spoken-reply transcription received on the wire (${otFrames.length} outputTranscription frames, ${otWithText.length} with text)`)
  : note('no outputTranscription frame observed (reply may have been text-only this run)');
receivedFrames(netB).some((f) => f.includes('turnComplete'))
  ? ok('server signalled turnComplete for the replies')
  : note('no turnComplete frame observed');
await shotB('04-live-spoken-replies');
}

// ── PHASE C: continuous voice — TWO spoken bursts through the active mic ────
// The user's actual complaint: "mic drops after the first phrase". The active
// mic is fed the SPEECH+silence WAV (loops: speech → 3s silence → speech → …)
// so the flush-on-silence fires once per burst. The wire must show TWO input
// transcriptions — the second only appears if the flush re-arms after the
// first turn (the one-shot-flush bug would stop at exactly one).
console.log(`\n=== PHASE C — continuous voice: two spoken bursts through the active mic ===`);
const c = launchChrome(SPEECH_WAV, 9475);
let cdpC;
try {
  cdpC = await connectCdp(9475);
} catch (e) {
  console.error(`✗ FAIL: ${e.message}`); c.kill(); c.dropProfile(); process.exit(1);
}
const { evaluate: evC, networkEvents: netC } = cdpC;
await cdpC.send('Page.navigate', { url: `${APP}/cook` });
await sleep(4000);
await injectSession(evC);
await cdpC.send('Page.reload', { ignoreCache: true });
await sleep(3500);

text = await pageText(evC);
let sawOwnerC = text.includes('Create my recipe') || text.includes('Start over');
for (let i = 0; i < 15 && !sawOwnerC; i++) {
  await sleep(1000);
  text = await pageText(evC);
  sawOwnerC = text.includes('Create my recipe') || text.includes('Start over');
}
sawOwnerC ? ok('signed in as the owner on /cook') : fail(`owner session did not land. Page text: ${text.slice(0, 250)}`);

// Seed + launch a fresh probe session (Phase B's was cleaned up).
const t2 = Date.now();
seededRecipeId = `${PROBE_PREFIX}${t2}`;
await getAdminDb().collection('recipes').doc(seededRecipeId).set({
  id: seededRecipeId,
  userId: OWNER_UID,
  title: 'Verify Live Voice Chicken Rice',
  description: 'One-pan dinner used by drive-live-voice.mjs',
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
  source: 'probe',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const launchC = await fetch(`${APP}/api/cook`, {
  method: 'POST', headers: AUTH,
  body: JSON.stringify({ action: 'launch', recipeId: seededRecipeId }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
if (launchC.status === 200 && launchC.body?.success && launchC.body?.data?.sessionId) {
  probeSids.add(launchC.body.data.sessionId);
  ok(`launch → ${launchC.body.data.phase} step ${launchC.body.data.stepNumber} (session ${launchC.body.data.sessionId.slice(0, 8)}…)`);
} else {
  fail(`launch → ${launchC.status} ${JSON.stringify(launchC.body ?? '').slice(0, 200)}`);
}
await cdpC.send('Page.reload', { ignoreCache: true });
await sleep(3500);
let micC = await evC(`!!document.querySelector('button[aria-label="Speak a command"]')`);
for (let i = 0; i < 15 && !micC; i++) {
  await sleep(1000);
  micC = await evC(`!!document.querySelector('button[aria-label="Speak a command"]')`);
}
micC ? ok('active guided screen shown (active-screen mic present)') : fail('active screen not shown in Phase C');

console.log(`\n[C] Tapping the active-screen mic with speech fake-audio — waiting for TWO input transcriptions`);
netC.length = 0;
const tappedC = await evC(`(() => {
  const mic = document.querySelector('button[aria-label="Speak a command"]');
  if (!mic) return 'no-mic';
  mic.click();
  return 'tapped';
})()`);
tappedC === 'tapped' ? ok('mic tapped') : fail(`mic not found (${tappedC})`);
let wsUrlC = wsUrlObserved(netC);
for (let i = 0; i < 30 && !wsUrlC; i++) { await sleep(1000); wsUrlC = wsUrlObserved(netC); }
wsUrlC && wsUrlC.includes('BidiGenerateContentConstrained')
  ? ok('Live WebSocket connected')
  : fail(`WS not observed: ${(wsUrlC ?? '').slice(0, 90)}`);
let setupC = sawReceived(netC, 'setupComplete');
for (let i = 0; i < 30 && !setupC; i++) { await sleep(1000); setupC = sawReceived(netC, 'setupComplete'); }
setupC ? ok('server acknowledged setup (setupComplete)') : fail('no setupComplete frame');

// The speech WAV loops ~5.7s per cycle; each burst + 1.2s silence flush yields
// one inputTranscription. Two bursts ≈ 2 transcriptions within ~45s.
const transcriptions = () =>
  receivedFrames(netC)
    .filter((f) => f.includes('inputTranscription'))
    .map((f) => {
      try { return JSON.parse(f).serverContent?.inputTranscription?.text ?? ''; } catch { return ''; }
    })
    .filter((t) => t.trim().length > 0);
let got2 = false;
let seen = [];
for (let i = 0; i < 90 && !got2; i++) {
  await sleep(1000);
  seen = transcriptions();
  got2 = seen.length >= 2;
}
if (got2) {
  ok(`TWO spoken bursts transcribed through the active mic — “${seen[0]}” / “${seen[1]}”`);
  // A passing run must ALSO prove the mic is not stuck: the "first burst then
  // dead" signature is playback IDLE with a stuck non-empty queue, which the
  // diagnostics blob reports as stuckQueueSince !== 0. If a future regression
  // ever leaves the mic muted behind a stuck queue (even one that still
  // yielded two bursts), this assertion fails the harness instead of passing
  // silently. Retry the capture briefly in case the copy button was in a
  // transient state between turns.
  let blob = await captureVoiceDetailsBlob(cdpC, evC);
  for (let i = 0; i < 5 && (blob.startsWith('NO_COPY_BUTTON') || blob.startsWith('BLob_CAPTURE_MISS')); i++) {
    await sleep(1000);
    blob = await captureVoiceDetailsBlob(cdpC, evC);
  }
  if (blob.startsWith('NO_COPY_BUTTON') || blob.startsWith('BLob_CAPTURE_MISS')) {
    fail(`passing run but the diagnostics blob was not capturable (${blob}) — cannot prove the mic is not stuck`);
  } else {
    // The parse + stuck decision is shared (scripts/voice-blob-verdict.mjs),
    // where the unit tests INJECT a stuckQueueSince > 0 blob and prove the
    // verdict fires — this branch must stay a thin caller so the tested
    // logic can never drift from what the driver runs.
    const verdict = evaluateVoiceBlob(blob);
    if (verdict.stuck) {
      fail(`passing run but the blob reports a stuck queue (stuckQueueSince=${verdict.stuckSince}, stuckQueueMs=${verdict.stuckMs}) — blob + screenshot saved`);
      try { writeFileSync(`${OUT}/phase-c-pass-blob.json`, blob); note('suspicious blob saved: phase-c-pass-blob.json'); } catch { /* non-fatal */ }
      try { await cdpC.screenshot('phase-c-pass-blob'); note('screenshot: phase-c-pass-blob.png'); } catch { /* non-fatal */ }
    } else {
      ok(`diagnostics blob clean — stuckQueueSince=0${typeof verdict.stuckMs === 'number' ? `, stuckQueueMs=${verdict.stuckMs}` : ''} (no stall)`);
    }
  }
} else {
  fail(`only ${seen.length} transcription(s) after 90s: ${JSON.stringify(seen.slice(-3))}`);
  // The drop just happened — capture the copy-voice-details blob live (the
  // exact artifact the deployed button produces) plus a screenshot.
  const blob = await captureVoiceDetailsBlob(cdpC, evC);
  console.log('\n=== copy-voice-details blob captured at the drop ===');
  console.log(blob);
  try { writeFileSync(`${OUT}/phase-c-drop-blob.json`, blob); note(`blob saved: phase-c-drop-blob.json`); } catch { /* non-fatal */ }
  try { await cdpC.screenshot('phase-c-drop'); note('screenshot: phase-c-drop.png'); } catch { /* non-fatal */ }
}
c.kill(); c.dropProfile(); try { cdpC.ws.close(); } catch { /* socket already gone */ }

// ── 6. Cleanup (idempotent; the handlers above also run it) ─────────────────
console.log(`\n[6] Cleanup probe session + recipe`);
if (!PHASE_C_ONLY) {
  b.kill(); b.dropProfile(); try { cdpB.ws.close(); } catch { /* socket already gone */ }
}
await cleanup();
ok('the owner account stays clean');

console.error(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
