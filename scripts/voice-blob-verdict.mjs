// ============================================================================
// scripts/voice-blob-verdict.mjs — the passing-run stuck-queue verdict,
// extracted from drive-live-voice.mjs so the negative path is unit-testable.
//
// The phase-C driver's passing path captures the copy-voice-details blob and
// must FAIL the run if the diagnostics report a stuck playback queue — the
// "first burst then dead" drop signature (playback idle, queue non-empty),
// which shows as stuckQueueSince !== 0. That decision used to be inline in
// the driver, where it could only be contract-locked by string markers, not
// PROVEN by injecting a stuck blob. Extracted here as a pure function (no
// side effects, safe to import in tests), the driver stays a thin caller, and
// scripts/voice-blob-verdict.test.ts injects a stuckQueueSince > 0 blob and
// proves the verdict fires.
//
// The page's copy payload nests the hook diagnostics under `gemini` (see
// app/cook/page.tsx copyMicDiagnostics): gemini.client holds the session
// diagnostics, so stuckQueueSince lives at gemini.client.stuckQueueSince.
// ============================================================================

/**
 * Judge a copy-voice-details blob and classify WHICH layer dropped the mic.
 *
 * @param {string} blobText - the raw blob text produced by the copy button
 * @returns {{ stuck: boolean, kind: string|null, evidence: string|null, stuckSince: unknown, stuckMs: unknown }}
 *   - `stuck` is true when the diagnostics are missing OR any class fires:
 *     `kind` is then one of
 *       'missing'     — gemini.client absent (cannot prove the mic is not stuck)
 *       'queue'       — the classic stuck playback drain (stuckQueueSince !== 0
 *                       or stuckQueueMs present-and-non-zero)
 *       'network'     — the socket closed/errored, or the server→client path
 *                       is silent: framesSent > 0 with framesReceived === 0,
 *                       or the last received frame is older than STALL_MS at
 *                       capture time (the half-open-stall signature)
 *       'audio-graph' — the mic processor started and ticked, but its last
 *                       tick is older than STALL_MS at capture time (the
 *                       audio graph froze while the socket stayed up)
 *   - `evidence` is a human-readable summary of the discriminating fields.
 *   - `stuckSince` / `stuckMs` are the raw queue values (undefined when
 *     absent) so the caller's messages can echo them.
 *
 * All staleness is measured against the blob's own `capturedAt` (deterministic
 * — no wall-clock dependence), so a paste taken minutes ago still classifies
 * correctly. Fields absent from pre-deploy blobs are tolerated: the queue
 * signature stays authoritative and the new classes stay inert.
 */
export const DROP_STALL_MS = 5000;

export function evaluateVoiceBlob(blobText) {
  let parsed = null;
  try {
    parsed = JSON.parse(blobText);
  } catch {
    /* non-JSON blob */
  }
  const client = parsed?.gemini?.client ?? null;
  const capturedAt = typeof parsed?.capturedAt === 'string' ? Date.parse(parsed.capturedAt) : NaN;
  const finiteCapture = Number.isFinite(capturedAt) ? capturedAt : null;

  const stuckSince = client?.stuckQueueSince;
  // stuckQueueMs only exists once the derived-duration change deploys;
  // absent is tolerated, present-and-non-zero is a stall.
  const stuckMs = client?.stuckQueueMs;
  const stuckMsBad = typeof stuckMs === 'number' && stuckMs !== 0;

  if (client === null) {
    return {
      stuck: true,
      kind: 'missing',
      evidence: 'gemini.client absent — cannot prove the mic is not stuck',
      stuckSince: undefined,
      stuckMs: undefined,
    };
  }

  // 1. Queue class — the classic "first burst then dead" signature.
  if (stuckSince !== 0 || stuckMsBad) {
    return {
      stuck: true,
      kind: 'queue',
      evidence: `idle playback with a non-empty queue (stuckQueueSince=${stuckSince}, stuckQueueMs=${stuckMs})`,
      stuckSince,
      stuckMs,
    };
  }

  // 2. Network class — socket-level or frame-level silence.
  const wsCloses = typeof client.wsCloses === 'number' ? client.wsCloses : 0;
  const wsErrors = typeof client.wsErrors === 'number' ? client.wsErrors : 0;
  const framesSent = typeof client.framesSent === 'number' ? client.framesSent : 0;
  const framesReceived = typeof client.framesReceived === 'number' ? client.framesReceived : 0;
  const lastFrameReceivedAt = typeof client.lastFrameReceivedAt === 'number' ? client.lastFrameReceivedAt : 0;
  const lastFrameSentAt = typeof client.lastFrameSentAt === 'number' ? client.lastFrameSentAt : 0;
  const connected = typeof client.connected === 'boolean' ? client.connected : null;
  const receivedStale =
    lastFrameReceivedAt > 0 &&
    finiteCapture !== null &&
    finiteCapture - lastFrameReceivedAt > DROP_STALL_MS;
  if (
    wsCloses > 0 ||
    wsErrors > 0 ||
    (framesReceived === 0 && framesSent > 0) ||
    (connected === false && framesSent > 0) ||
    receivedStale
  ) {
    return {
      stuck: true,
      kind: 'network',
      evidence: `no server frames flowing: framesSent=${framesSent}, framesReceived=${framesReceived}, lastFrameReceivedAt=${lastFrameReceivedAt}, lastFrameSentAt=${lastFrameSentAt}, wsCloses=${wsCloses}, wsErrors=${wsErrors}, connected=${connected}`,
      stuckSince,
      stuckMs,
    };
  }

  // 3. Audio-graph class — the processor started and ticked, then froze.
  const micStarted = typeof client.micStarted === 'boolean' ? client.micStarted : false;
  const captureRuns = typeof client.captureRuns === 'number' ? client.captureRuns : 0;
  const lastCaptureAt = typeof client.lastCaptureAt === 'number' ? client.lastCaptureAt : 0;
  const captureStale = lastCaptureAt > 0 && finiteCapture !== null && finiteCapture - lastCaptureAt > DROP_STALL_MS;
  if (micStarted && captureRuns > 0 && captureStale) {
    return {
      stuck: true,
      kind: 'audio-graph',
      evidence: `mic capture frozen: captureRuns=${captureRuns}, lastCaptureAt=${lastCaptureAt}, micStarted=${micStarted}`,
      stuckSince,
      stuckMs,
    };
  }

  return { stuck: false, kind: null, evidence: null, stuckSince, stuckMs };
}
