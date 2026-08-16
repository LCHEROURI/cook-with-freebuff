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
    expect(LIVE).toContain("spawnSync('node', ['scripts/drive-live-voice.mjs', '--app', APP, '--probe-prefix', `${PROBE_PREFIX}voice-`, '--out', `/tmp/verify-live-voice-${t}-${attempt}`], {");
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
    // The retry path logs via `note` — the helper must exist or the retry
    // branch itself crashes (`note is not defined`), failing the gate with a
    // misleading crash instead of a clean verdict. Lock the definition so a
    // future edit can't drop it.
    expect(LIVE).toContain('const note = (m) => console.log(`  - ${m}`);');
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

  it('asserts the passing-run diagnostics blob is not stuck (stuckQueueSince === 0)', () => {
    // A phase-C run that still produces two bursts must ALSO prove the mic is
    // not sitting behind a stuck queue — the exact "first burst then dead"
    // signature (playback idle, queue non-empty) that a regression would
    // reintroduce. The driver captures the copy-voice-details blob on the
    // PASSING path and fails if stuckQueueSince is non-zero, so a future stall
    // fails the harness (and the post-deploy [3e] gate) instead of passing
    // silently. A driver edit that drops this assertion while still exiting 0
    // fails HERE.
    expect(DRIVER).toContain('stuckQueueSince');
    expect(DRIVER).toContain('captureVoiceDetailsBlob');
    expect(DRIVER).toContain('diagnostics blob clean');
    expect(DRIVER).toContain("fail(`passing run but the blob reports a stuck queue");
  });

  it('declares the shared minted flag at MODULE scope (Phase B reassigns Phase A\'s flag)', () => {
    // Seen live: `let minted` lived inside Phase A's `if (!PHASE_C_ONLY)`
    // block (wrapping added by 9cc53e2), so Phase B's `minted = tokenPosted(netB);`
    // threw `minted is not defined` — every full verify:live [3e] run crashed
    // at the active-screen mic stage while the Phase-C-only batches stayed
    // 100% (they skip A and B). The fix hoists the declaration to module top
    // level, before Phase A's block. Locks:
    //   - the top-level declaration exists BEFORE the Phase A block starts
    //   - Phase A ASSIGNS (never redeclares with `let`) — a block-local
    //     redeclaration would re-break the scope and fail HERE
    const phaseA = DRIVER.indexOf('// ── PHASE A:');
    const phaseB = DRIVER.indexOf('// ── PHASE B:');
    expect(phaseA).toBeGreaterThan(-1);
    expect(phaseB).toBeGreaterThan(phaseA);
    const beforePhaseA = DRIVER.slice(0, phaseA);
    const phaseASection = DRIVER.slice(phaseA, phaseB);
    expect(beforePhaseA).toContain('let minted;');
    expect(phaseASection).toContain('minted = tokenPosted(netA);');
    expect(phaseASection).not.toContain('let minted');
  });

  it('delegates the blob verdict to the shared unit-tested function (voice-blob-verdict.mjs)', () => {
    // The negative path — a stuckQueueSince > 0 blob MUST fail the run — is
    // PROVEN by scripts/voice-blob-verdict.test.ts (which injects the blob
    // and asserts verdict.stuck). That proof is only worth anything if the
    // driver actually runs the tested function: this locks the import and the
    // thin call site, so a future edit that re-implements the decision inline
    // (leaving the tested module dead code) fails HERE instead of silently
    // un-proving the assertion.
    expect(DRIVER).toContain("import { evaluateVoiceBlob } from './voice-blob-verdict.mjs';");
    expect(DRIVER).toContain('const verdict = evaluateVoiceBlob(blob);');
    expect(DRIVER).toContain('if (verdict.stuck)');
  });

  it('sweeps its own probes (verify-live-voice- prefix) so a killed run can never hijack /cook', () => {
    // The recipe prefix sits INSIDE verify:live's `verify-live-` sweep
    // namespace, so the pre-run sweep backstops a hard-killed run. The
    // sweep must archive stale ACTIVE/PAUSED probe sessions and delete
    // orphaned probe recipes.
    expect(DRIVER).toContain("const PROBE_PREFIX = flag('--probe-prefix', 'verify-live-voice-');");
    expect(DRIVER).toContain('async function sweepStaleProbes()');
    expect(DRIVER).toContain("s.recipeId.startsWith(PROBE_PREFIX)");
    expect(DRIVER).toContain("(s.status === 'ACTIVE' || s.status === 'PAUSED')");
    expect(DRIVER).toContain("d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() })");
  });

  it('never sweeps a recipe seeded within the grace period (a concurrent same-prefix run\'s in-flight probe)', () => {
    // The weekly mic-regression monitor and a manual re-run both use
    // `mic-regression-` and run as the same owner. Between a run's seed and
    // its launch POST the recipe has no session yet; a concurrent run's sweep
    // would delete it and fail the launch with RECIPE_NOT_FOUND. The grace
    // guard keeps a fresh seed alive while still deleting genuinely old
    // leftovers from a killed run.
    const fnStart = DRIVER.indexOf('async function sweepStaleProbes');
    const fn = DRIVER.slice(fnStart, DRIVER.indexOf('\n}\n', fnStart));
    expect(DRIVER).toContain('const PROBE_GRACE_MS = 15 * 60 * 1000;');
    expect(fn).toContain('const cutoff = Date.now() - PROBE_GRACE_MS;');
    expect(fn).toContain('const seededAt = d.data().updatedAt ?? d.data().createdAt ?? 0;');
    expect(fn).toContain('typeof seededAt === \'number\' && seededAt < cutoff');
  });

  it('archives only STALE probe sessions — a fresh session from a concurrent run is never archived', () => {
    // Two same-prefix runs overlap after the first launched its session: the
    // second sweep must NOT mark that fresh ACTIVE session ABANDONED (it would
    // yank the first run's /cook session on its next reload). Only sessions
    // idle past the 10-minute cutoff are archived.
    const fnStart = DRIVER.indexOf('async function sweepStaleProbes');
    const fn = DRIVER.slice(fnStart, DRIVER.indexOf('\n}\n', fnStart));
    expect(DRIVER).toContain('const STALE_SESSION_MS = 10 * 60 * 1000;');
    expect(fn).toContain('const sessionCutoff = Date.now() - STALE_SESSION_MS;');
    expect(fn).toContain('const staleProbeSessions = probeSessions.filter((d) => {');
    expect(fn).toContain('const last = d.data().lastActivityAt;');
    expect(fn).toContain('typeof last === \'number\' && last > 0 && last < sessionCutoff');
    // The archive loop must iterate the STALE subset, never the full set.
    expect(fn).toContain('for (const d of staleProbeSessions)');
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
    // Cross-platform fallback: macOS `say` does not exist on the Linux CI
    // runner — the committed fixture (scripts/fixtures/dictation-speech.wav)
    // must back the fresh-synthesis path or the dictation stage fails with
    // `say ENOENT` on every deploy run (seen live).
    expect(DRIVER).toContain("copyFileSync(fileURLToPath(new URL('./fixtures/dictation-speech.wav', import.meta.url)), SPEECH_WAV)");
    expect(DRIVER).toContain('using the committed speech fixture');
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

  it('Phase C — asserts TWO input transcriptions from two spoken bursts through the active mic', () => {
    // The continuous-voice contract (seen live: exactly 1 transcription
    // across two bursts = one-shot flush bug). The driver must gate on
    // seen.length >= 2 so a future edit that relaxes the check to a single
    // burst (masking the one-shot-flush regression) fails HERE, at the
    // post-deploy gate.
    //
    // The speech WAV loops (speech → 3s silence → …). Each burst + 1.2s
    // trailing silence flushes via audioStreamEnd, and the re-armed flush
    // (inputTranscription.final !== false) produces the second transcription.
    // A future edit that drops the >= 2 check to >= 1, or changes the label
    // from TWO to anything else, fails this contract.
    expect(DRIVER).toContain('TWO input transcriptions');                   // the stage header
    expect(DRIVER).toContain('seen.length >= 2');                           // the gate condition
    expect(DRIVER).toContain('ok(`TWO spoken bursts transcribed through the active mic'); // the success marker
    expect(DRIVER).toContain('fail(`only ${seen.length} transcription(s) after 90s');       // the failure marker
    // The two-burst proof is exercise, not a cosmetic label — the driver
    // must still collect the actual transcriptions array and populate
    // seen[0] / seen[1] in the success message.
    expect(DRIVER).toContain('${seen[0]}');
    expect(DRIVER).toContain('${seen[1]}');
  });
});
