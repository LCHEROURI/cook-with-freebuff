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
 * Judge a copy-voice-details blob for the stuck-queue signature.
 *
 * @param {string} blobText - the raw blob text produced by the copy button
 * @returns {{ stuck: boolean, stuckSince: unknown, stuckMs: unknown }}
 *   - `stuck` is true when the diagnostics are missing OR stuckQueueSince is
 *     non-zero OR stuckQueueMs is present and non-zero. Missing
 *     gemini.client is a stall (cannot prove the mic is not stuck).
 *   - `stuckSince` / `stuckMs` are the raw values (undefined when absent) so
 *     the caller's fail/ok messages can echo them.
 */
export function evaluateVoiceBlob(blobText) {
  let parsed = null;
  try {
    parsed = JSON.parse(blobText);
  } catch {
    /* non-JSON blob */
  }
  const client = parsed?.gemini?.client ?? null;
  const stuckSince = client?.stuckQueueSince;
  // stuckQueueMs only exists once the derived-duration change deploys;
  // absent is tolerated, present-and-non-zero is a stall.
  const stuckMs = client?.stuckQueueMs;
  const stuckMsBad = typeof stuckMs === 'number' && stuckMs !== 0;
  return {
    stuck: client === null || stuckSince !== 0 || stuckMsBad,
    stuckSince,
    stuckMs,
  };
}
