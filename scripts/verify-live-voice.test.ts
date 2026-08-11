import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-voice.test.ts — lock verify-live's [3e] LIVE-VOICE gate.
//
// The first-party Gemini Live voice surface on /cook is proven after every
// deploy by the committed driver scripts/drive-live-voice.mjs, spawned by
// verify:live's [3e] stage. That stage covers BOTH mics:
//
//   PHASE A — starter DICTATION mic: real synthesized speech through the fake
//     media device, tapped "Speak your ingredients", tool-free setup frame,
//     and the final transcription FILLS the starter input.
//   PHASE B — active-screen Live mic: silence fake-device, token minted,
//     constrained WebSocket, LISTENING, then two text turns into the SAME live
//     conversation and the spoken replies render in the Kitchen Agent box +
//     transcript log.
//
// Same discipline as scripts/verify-live-starter.test.ts and
// scripts/verify-live-cleanup.test.ts: read the REAL scripts from disk (never
// a fixture) and assert the load-bearing pieces survive future edits:
//
//   1. The [3e] stage spawns the committed driver against the SAME deployed
//      APP with a 420s budget and requires `RESULT: PASS` (a driver exit
//      without it fails the gate).
//   2. Retry-once-after-30s backoff, mirroring [3d], so a cold-serverless
//      transient can't fail the gate.
//   3. verify:live is NOT a black box — it must see five contract markers in
//      the driver log, so an edit that drops the assertions while still
//      exiting 0 fails HERE at the post-deploy gate.
//   4. The driver sweeps its own probes (`verify-live-voice-`, inside
//      verify:live's sweep namespace) and cleans up on EVERY exit path — a
//      killed run can never leave a stale ACTIVE session that hijacks the
//      owner's /cook.
//   5. The dictation stage is genuinely TOOL-FREE on the wire and the active
//      stage proves the handshake + rendered replies.
// ============================================================================

const LIVE = readFileSync('scripts/verify-live.mjs', 'utf8');
const DRIVER = readFileSync('scripts/drive-live-voice.mjs', 'utf8');

describe('scripts/verify-live.mjs · live-voice gate [3e] (dictation + active-screen mics)', () => {
  it('spawns the committed voice driver against the same deployed APP and requires RESULT: PASS', () => {
    expect(LIVE).toContain("spawnSync('node', ['scripts/drive-live-voice.mjs', '--app', APP, '--out', `/tmp/verify-live-voice-${t}-${attempt}`], {");
    // Two Chrome launches + two Gemini Live sessions need a generous budget.
    expect(LIVE).toContain('timeout: 420_000');
    expect(LIVE).toContain('voiceDriver.status === 0 && /RESULT: PASS/.test(voiceLog)');
    expect(LIVE).toContain("ok('live voice driver → RESULT: PASS (dictation + active-screen mics)')");
    expect(LIVE).toContain("fail(`live voice driver → exit ${voiceDriver.status ?? 'crash'}");
    expect(LIVE).toContain('fail(\'live voice driver timed out after 420s (both attempts)\');');
  });

  it('retries the driver ONCE after a 30s backoff on a failed first attempt (transient stalls)', () => {
    // Same pattern as [3d]: a non-PASS first attempt waits 30s and retries
    // once before failing. A deterministic regression fails both attempts; a
    // cold-serverless transient passes on the retry.
    expect(LIVE).toContain('let voiceDriver = runVoiceDriver(1);');
    expect(LIVE).toContain("note('voice driver first attempt did not pass — waiting 30s and retrying once (transient backoff)')");
    expect(LIVE).toContain('await sleep(30_000);');
    expect(LIVE).toContain('voiceDriver = runVoiceDriver(2);');
  });

  it('asserts the key contract markers from the driver log (not a black box)', () => {
    // A driver edit that drops the load-bearing proof lines while still
    // exiting 0 with RESULT: PASS fails HERE — the gate after every deploy.
    expect(LIVE).toContain("'dictation mic tapped'");
    expect(LIVE).toContain("'tool-free dictation setup'");
    expect(LIVE).toContain("'spoken prompt filled the input'");
    expect(LIVE).toContain("'LISTENING state: mic aria-pressed'");
    expect(LIVE).toContain("'spoken reply rendered'");
    expect(LIVE).toContain('voiceLog.includes(marker)');
    expect(LIVE).toContain("fail(`voice driver: missing “${marker}” in the driver log`);");
  });

  it('sweeps its own probes (verify-live-voice- prefix) so a killed run can never hijack /cook', () => {
    // The recipe prefix sits INSIDE verify:live's `verify-live-` sweep
    // namespace, so the pre-run sweep backstops a hard-killed run. The
    // sweep must archive stale ACTIVE/PAUSED probe sessions and delete
    // orphaned probe recipes.
    expect(DRIVER).toContain("const PROBE_PREFIX = 'verify-live-voice-';");
    expect(DRIVER).toContain('async function sweepStaleProbes()');
    expect(DRIVER).toContain("s.recipeId.startsWith(PROBE_PREFIX)");
    expect(DRIVER).toContain("(s.status === 'ACTIVE' || s.status === 'PAUSED')");
    expect(DRIVER).toContain("d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() })");
  });

  it('guarantees cleanup on EVERY exit path (signals, crashes, success)', () => {
    // The owner's data must end exactly as it started even when the run is
    // killed mid-flight — SIGINT/SIGTERM/SIGHUP plus unhandled rejection and
    // uncaught exception all funnel through the same idempotent cleanup.
    expect(DRIVER).toContain('process.on(\'SIGINT\', () => void exitWithCleanup(130, \'drive-live-voice interrupted (SIGINT) — cleanup ran\'));');
    expect(DRIVER).toContain("process.on('SIGTERM', () => void exitWithCleanup(143, 'drive-live-voice terminated (SIGTERM) — cleanup ran'));");
    expect(DRIVER).toContain("process.on('unhandledRejection', (e) => {");
    expect(DRIVER).toContain("process.on('uncaughtException', (e) => {");
    expect(DRIVER).toContain("db.collection('cooking_session_events').where('sessionId', '==', sid).get()");
    expect(DRIVER).toContain("db.collection('cooking_sessions').doc(sid).delete()");
    expect(DRIVER).toContain("db.collection('recipes').doc(seededRecipeId).delete()");
    expect(DRIVER).toContain("ok('the owner account stays clean');");
  });

  it('Phase A — dictation: real speech audio, token minted, constrained WS, setupComplete', () => {
    // The dictation stage must feed REAL speech through the fake media device
    // (so Gemini's inputAudioTranscription transcribes actual words, no
    // mocks), and the handshake must mint the ephemeral token and connect the
    // constrained Live WebSocket.
    expect(DRIVER).toContain("execFileSync('say', ['-o', '/tmp/live-voice-speech.aiff', SPOKEN_PROMPT]");
    expect(DRIVER).toContain("button[aria-label=\"Speak your ingredients\"]");
    expect(DRIVER).toContain("minted ? ok('ephemeral token minted (POST /api/voice/token)')");
    expect(DRIVER).toContain("wsUrlA.includes('BidiGenerateContentConstrained') && wsUrlA.includes('access_token=')");
    expect(DRIVER).toContain("sawReceived(netA, 'setupComplete')");
  });

  it('Phase A — the dictation setup frame carries NO tools (model cannot act on a spoken prompt)', () => {
    // The whole point of dictation is review-before-action: the setup frame
    // the browser sends must not declare functionDeclarations, so the model
    // can only transcribe, never write to the pantry or create a session.
    expect(DRIVER).toContain("const setupFrames = sentFrames(netA).filter((f) => f.includes('\"setup\"'));");
    expect(DRIVER).toContain("!f.includes('functionDeclarations') && !f.includes('\"tools\"')");
    expect(DRIVER).toContain("ok(`tool-free dictation setup");
    expect(DRIVER).toContain("fail(`dictation setup is NOT tool-free:");
  });

  it('Phase A — the final transcription FILLS the starter input', () => {
    // The fill is the observable proof the dictation worked end to end.
    expect(DRIVER).toContain("input[aria-label=\"What do you have to cook with?\"]");
    expect(DRIVER).toContain("stA.prompt");
    expect(DRIVER).toContain("ok(`spoken prompt filled the input in ${elapsed}s: “${stA.prompt}”`)");
    expect(DRIVER).toContain('fail(`dictation did not fill the input after 60s');
  });

  it('Phase B — active-screen mic: minted, constrained WS, LISTENING state, audio streaming', () => {
    expect(DRIVER).toContain("button[aria-label=\"Speak a command\"]");
    expect(DRIVER).toContain("minted ? ok('ephemeral token minted — browser POSTed /api/voice/token') : fail('no client-side POST /api/voice/token observed");
    expect(DRIVER).toContain("wsUrlB && wsUrlB.includes('BidiGenerateContentConstrained') && wsUrlB.includes('access_token=')");
    expect(DRIVER).toContain("ui.pressed === 'true' && ui.indicator === 'Listening…'");
    expect(DRIVER).toContain('ok(`mic audio streaming to Gemini (${frames} realtimeInput audio frames sent)`)');
  });

  it('Phase B — spoken replies render in the Kitchen Agent box + transcript log', () => {
    // Two text turns into the SAME live conversation, replies must render in
    // the Kitchen Agent box, and the scrollable transcript log must show both
    // utterances + both Kitchen Agent rows (the re-readable history).
    expect(DRIVER).toContain("const Q1 = 'What is one good tip for this step?';");
    expect(DRIVER).toContain("const Q2 = 'Should I season the chicken now?';");
    expect(DRIVER).toContain('el.innerText.toUpperCase().includes(\'KITCHEN AGENT\')');
    expect(DRIVER).toContain("ok(`${label}: spoken reply rendered — “${reply.slice(0, 110)}”`)");
    expect(DRIVER).toContain("document.querySelector('[role=\"log\"][aria-label=\"Conversation transcript\"]')");
    expect(DRIVER).toContain("agentMentions >= 2");
  });
});
