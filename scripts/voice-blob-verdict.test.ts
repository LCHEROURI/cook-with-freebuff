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
// looked like, except the stuck state was invisible then (the raw blobs were
// never archived; see docs/pre-fix-drop-signature.md for the reconstruction
// and the diff against a healthy blob).
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

// ============================================================================
// Drop-classification suite — a pasted blob must pinpoint WHICH layer dropped
// the mic, not just that it did. The verdict classifies in priority order:
// queue (classic stuck drain) > network (socket/frame silence) > audio-graph
// (capture frozen while the socket stayed up). All staleness is measured
// against the blob's own capturedAt, so a paste taken minutes ago still
// classifies correctly (no wall-clock dependence).
// ============================================================================

describe('scripts/voice-blob-verdict.mjs · drop classification (queue / network / audio-graph)', () => {
  const CAPTURE = '2026-01-01T00:00:05.000Z';
  const T0 = Date.parse(CAPTURE);

  // 5s + 1ms older than capture: beyond DROP_STALL_MS.
  const STALE = T0 - 5001;
  // 1s older: within the stall window — must NOT fire.
  const FRESH = T0 - 1000;

  it('network class — a non-clean WebSocket close (wsCloses) is a network drop', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: false,
            wsCloses: 1,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: FRESH,
            lastFrameSentAt: FRESH,
            playing: false,
            playbackQueueLength: 0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(true);
    expect(v.kind).toBe('network');
    expect(v.evidence).toContain('wsCloses=1');
  });

  it('network class — WebSocket errors (wsErrors) are a network drop', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            wsErrors: 2,
            framesSent: 12,
            framesReceived: 9,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.kind).toBe('network');
  });

  it('network class — half-open socket: mic frames flowing but zero received', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 0,
            lastFrameReceivedAt: 0,
            lastFrameSentAt: FRESH,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(true);
    expect(v.kind).toBe('network');
    expect(v.evidence).toContain('framesReceived=0');
  });

  it('network class — socket reports disconnected while audio was being sent', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: false,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: FRESH,
            lastFrameSentAt: FRESH,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.kind).toBe('network');
  });

  it('network class — stale server frames: lastFrameReceivedAt older than 5s at capture', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: STALE,
            lastFrameSentAt: T0,
            micStarted: true,
            captureRuns: 120,
            lastCaptureAt: T0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.kind).toBe('network');
  });

  it('audio-graph class — capture heartbeat frozen while the socket stayed up', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: T0, // server frames still flowing
            lastFrameSentAt: T0,
            micStarted: true,
            captureRuns: 120,
            lastCaptureAt: STALE, // but the mic graph froze
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(true);
    expect(v.kind).toBe('audio-graph');
    expect(v.evidence).toContain('captureRuns=120');
  });

  it('audio-graph class — never captures after mic start is NOT a frozen graph (no ticks yet)', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            framesSent: 2,
            framesReceived: 1,
            lastFrameReceivedAt: T0,
            lastFrameSentAt: T0,
            micStarted: true,
            captureRuns: 0,
            lastCaptureAt: 0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    // Zero ticks is a startup state, not a stall — require captureRuns > 0
    // before judging the graph frozen.
    expect(v.stuck).toBe(false);
  });

  it('priority — the classic queue signature wins over network evidence', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            playing: false,
            playbackQueueLength: 2,
            stuckQueueSince: T0,
            stuckQueueMs: 10000,
            wsCloses: 1,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
          },
        },
      }),
    );
    expect(v.kind).toBe('queue');
  });

  it('priority — network evidence wins over a frozen audio graph', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 1,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 0,
            micStarted: true,
            captureRuns: 120,
            lastCaptureAt: STALE,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.kind).toBe('network');
  });

  it('healthy — a live session with flowing frames and ticking capture is clean', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 120,
            framesReceived: 45,
            lastFrameReceivedAt: T0,
            lastFrameSentAt: T0,
            micStarted: true,
            captureRuns: 500,
            lastCaptureAt: T0,
            playing: false,
            playbackQueueLength: 0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(false);
    expect(v.kind).toBeNull();
    expect(v.evidence).toBeNull();
  });

  it('healthy — a pre-deploy blob without the new fields stays clean (no false network/audio flags)', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        gemini: {
          client: {
            playing: false,
            playbackQueueLength: 0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(false);
    expect(v.kind).toBeNull();
  });

  it('boundary — a frame/capture exactly at the stall window (5s) is NOT stale', () => {
    const AT_WINDOW = T0 - 5000;
    const v = evaluateVoiceBlob(
      JSON.stringify({
        capturedAt: CAPTURE,
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: AT_WINDOW,
            lastFrameSentAt: T0,
            micStarted: true,
            captureRuns: 120,
            lastCaptureAt: T0,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(false);
  });

  it('no capturedAt — staleness is unprovable, so socket/capture age cannot fire (absent = clean)', () => {
    const v = evaluateVoiceBlob(
      JSON.stringify({
        gemini: {
          client: {
            connected: true,
            wsCloses: 0,
            wsErrors: 0,
            framesSent: 12,
            framesReceived: 9,
            lastFrameReceivedAt: 1,
            lastFrameSentAt: 1,
            micStarted: true,
            captureRuns: 120,
            lastCaptureAt: 1,
            stuckQueueSince: 0,
            stuckQueueMs: 0,
          },
        },
      }),
    );
    expect(v.stuck).toBe(false);
  });
});
