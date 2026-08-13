import { describe, expect, it } from 'vitest';
import { evaluateVoiceBlob } from './voice-blob-verdict.mjs';

// ============================================================================
// scripts/voice-blob-verdict.test.ts — prove the phase-C passing-run
// stuck-queue assertion FIRES on a stuck blob.
//
// The driver (drive-live-voice.mjs) captures the copy-voice-details blob on
// a passing two-burst run and must FAIL the harness if the diagnostics show
// the "first burst then dead" drop signature (playback idle, queue
// non-empty) — stuckQueueSince !== 0. The decision lives in
// voice-blob-verdict.mjs precisely so this file can INJECT a stuck blob and
// prove the verdict fires without a live browser. The positive + edge cases
// pin the boundaries so the negative path is not vacuous.
//
// Blob shape: the page's copy payload nests the hook diagnostics under
// `gemini` (app/cook/page.tsx copyMicDiagnostics), so the real field is
// gemini.client.stuckQueueSince.
// ============================================================================

const HEALTHY = JSON.stringify({
  gemini: { client: { playing: false, playbackQueueLength: 0, stuckQueueSince: 0, stuckQueueMs: 0 } },
});

// The pre-fix drop signature verbatim: playing=false, queue non-empty, and a
// non-zero stuckQueueSince — this is exactly what the four failing blobs
// looked like, except the stuck state was invisible then.
const STUCK_SINCE = JSON.stringify({
  gemini: { client: { playing: false, playbackQueueLength: 2, stuckQueueSince: 1786500000000, stuckQueueMs: 10000 } },
});

const STUCK_MS_ONLY = JSON.stringify({
  gemini: { client: { stuckQueueSince: 0, stuckQueueMs: 5000 } },
});

const MISSING_CLIENT = JSON.stringify({ gemini: {} });

const NON_JSON = 'this is not a blob';

// Pre-deploy shape: stuckQueueMs did not exist until the derived-duration
// change landed; absent must be tolerated (clean), not a false stall.
const PRE_DEPLOY = JSON.stringify({
  gemini: { client: { playing: false, playbackQueueLength: 0, stuckQueueSince: 0 } },
});

describe('scripts/voice-blob-verdict.mjs · the passing-run stuck-queue assertion', () => {
  it('NEGATIVE PATH — a stuckQueueSince > 0 blob is judged stuck: the assertion fires', () => {
    // The test the driver cannot run without a browser: inject the exact
    // stuck blob the passing path would capture and prove the verdict is
    // stuck, so the driver's `if (verdict.stuck) fail(...)` fires and the
    // harness goes red on a future stall.
    const v = evaluateVoiceBlob(STUCK_SINCE);
    expect(v.stuck).toBe(true);
    expect(v.stuckSince).toBe(1786500000000);
    expect(v.stuckMs).toBe(10000);
  });

  it('a healthy blob (stuckQueueSince=0, empty queue) is judged clean', () => {
    const v = evaluateVoiceBlob(HEALTHY);
    expect(v.stuck).toBe(false);
    expect(v.stuckSince).toBe(0);
  });

  it('stuckQueueMs non-zero with stuckQueueSince 0 is still a stall (the derived-duration signal)', () => {
    const v = evaluateVoiceBlob(STUCK_MS_ONLY);
    expect(v.stuck).toBe(true);
  });

  it('missing gemini.client cannot prove the mic is not stuck — judged stuck', () => {
    const v = evaluateVoiceBlob(MISSING_CLIENT);
    expect(v.stuck).toBe(true);
    expect(v.stuckSince).toBeUndefined();
  });

  it('a non-JSON blob is unprovable — judged stuck', () => {
    expect(evaluateVoiceBlob(NON_JSON).stuck).toBe(true);
  });

  it('a pre-deploy blob without stuckQueueMs is tolerated (clean), not a false stall', () => {
    const v = evaluateVoiceBlob(PRE_DEPLOY);
    expect(v.stuck).toBe(false);
    expect(v.stuckMs).toBeUndefined();
  });
});
