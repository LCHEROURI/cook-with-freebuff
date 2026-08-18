// ============================================================================
// scripts/phase-c-latency.mjs — phase-C two-burst LATENCY measurement,
// extracted from drive-live-voice.mjs so the pairing/bound logic is
// unit-testable with injected wire fixtures (the same discipline that pulled
// the stuck-queue verdict into scripts/voice-blob-verdict.mjs).
//
// The two-burst proof asserts the bursts HAPPEN; these bounds assert they
// happen FAST ENOUGH. A burst that still transcribes but takes 40s would PASS
// the old phase C (only the 90s hard-drop cap caught it, as an undiagnosed
// drop). The bounds are ~5-10x the healthy envelope (recognition ≈0.2-3s,
// reply ≈1-5s) yet far below the 90s drop cap, so a slow-but-eventual turn is
// caught and CLASSIFIED as degradation long before it becomes a hard drop.
//
// Wire metrics (all deltas from the SAME CDP timestamp base — monotonic
// seconds since the target started, so time-base-independent):
//   flush→transcript  — client sends audioStreamEnd (1.2s after the burst's
//                       last speech frame, the documented flushOnSilenceMs)
//                       → FINAL inputTranscription lands. Perceived
//                       speech-end→transcript latency = this + 1.2s.
//   transcript→reply  — inputTranscription → first reply content frame
//                       (outputTranscription text or modelTurn audio).
//   inter-burst gap   — first → second transcription: the re-arm cadence the
//                       one-shot-flush bug used to break entirely.
//
// Input shape: timestamped wire frames — { t: number|null, payload: string }
// (CDP Network.webSocketFrameSent/Received filtered for audioStreamEnd,
// inputTranscription, and reply content respectively). The DRIVER builds the
// arrays; this module only pairs and judges, so a future edit that relaxes
// the bounds (or the pairing) fails the unit tests, not a live run.
// ============================================================================

export const FLUSH_TO_TRANSCRIPT_MS = 15_000;
export const TRANSCRIPT_TO_REPLY_MS = 25_000;
export const INTER_BURST_MS = 45_000;

/** A server→client frame is a FINAL input transcription when it carries text. */
export function isTranscriptionFrame(payload) {
  try {
    return Boolean(JSON.parse(payload).serverContent?.inputTranscription?.text?.trim());
  } catch {
    return false;
  }
}

/** A server→client frame is reply CONTENT when it carries reply text or audio. */
export function isReplyFrame(payload) {
  try {
    const sc = JSON.parse(payload).serverContent;
    return Boolean(sc?.outputTranscription?.text || sc?.modelTurn?.parts?.some((p) => p.inlineData?.data));
  } catch {
    return false;
  }
}

/**
 * Pair each burst's flush → transcription → first reply from timestamped wire
 * frames and return per-burst latencies in ms.
 *
 * @param {{ flushes: Array<{t: number|null, payload: string}>, transcriptions: Array<{t: number|null, payload: string}>, replies: Array<{t: number|null, payload: string}> }} frames
 * @returns {{ bursts: Array<{flushToTranscript: number|null, transcriptToReply: number|null}>, interBurst: number|null, flushCount: number }}
 *   - `bursts[i]` pairs the i-th flush with the i-th transcription and the
 *     first reply frame AFTER that transcription. A null latency means the
 *     marker existed but lacked a usable timestamp, or (for transcriptToReply)
 *     no reply content frame followed the transcription.
 *   - `interBurst` is the first→second transcription gap (null until both
 *     transcriptions exist).
 *   - `flushCount` counts ALL audioStreamEnd frames seen, so the caller can
 *     distinguish "flush missing" from "extra silence flushes".
 */
export function phaseCLatency({ flushes, transcriptions, replies }) {
  const ms = (a, b) => (a?.t != null && b?.t != null ? Math.round((b.t - a.t) * 1000) : null);
  const bursts = [];
  for (let i = 0; i < 2; i++) {
    if (!transcriptions[i]) break;
    let reply = null;
    for (const r of replies) {
      if (r.t != null && (transcriptions[i].t ?? -Infinity) < r.t) {
        reply = r;
        break;
      }
    }
    bursts.push({
      flushToTranscript: flushes[i] ? ms(flushes[i], transcriptions[i]) : null,
      transcriptToReply: reply ? ms(transcriptions[i], reply) : null,
    });
  }
  return {
    bursts,
    interBurst: bursts.length === 2 ? ms(transcriptions[0], transcriptions[1]) : null,
    flushCount: flushes.length,
  };
}

/**
 * @typedef {{
 *   kind: 'unmeasurable',
 *   bursts: number,
 *   flushCount: number,
 *   message: string,
 * } | {
 *   kind: 'flush-to-transcript' | 'transcript-to-reply',
 *   burst: number,
 *   ms: number | null,
 *   limit: number,
 * } | {
 *   kind: 'inter-burst',
 *   ms: number,
 *   limit: number,
 * }} LatencyViolation
 */

/**
 * Judge a phaseCLatency result against the bounds. Returns an empty array on a
 * healthy run; otherwise one entry per violation:
 *   unmeasurable           — bursts transcribed but a flush or transcription
 *                            marker is missing, so no bound can be proven
 *   flush-to-transcript    — a burst's flush→transcript cleared the bound
 *   transcript-to-reply    — a burst's reply cleared the bound (ms null = the
 *                            burst got NO reply content frame at all)
 *   inter-burst            — the first→second transcription gap cleared the
 *                            bound (the re-arm cadence)
 * @returns {LatencyViolation[]}
 */
export function latencyViolations(lat) {
  const b1 = lat.bursts[0];
  const b2 = lat.bursts[1];
  if (!b1 || !b2 || b1.flushToTranscript == null || b2.flushToTranscript == null) {
    return [
      {
        kind: 'unmeasurable',
        bursts: lat.bursts.length,
        flushCount: lat.flushCount,
        message: `two bursts transcribed but their latency cannot be bounded (bursts=${lat.bursts.length}, flushes=${lat.flushCount}) — a flush or transcription marker is missing on the wire`,
      },
    ];
  }
  const over = [];
  for (const [burst, b] of [[1, b1], [2, b2]]) {
    if (b.flushToTranscript > FLUSH_TO_TRANSCRIPT_MS) {
      over.push({ kind: 'flush-to-transcript', burst, ms: b.flushToTranscript, limit: FLUSH_TO_TRANSCRIPT_MS });
    }
    if (b.transcriptToReply == null || b.transcriptToReply > TRANSCRIPT_TO_REPLY_MS) {
      over.push({ kind: 'transcript-to-reply', burst, ms: b.transcriptToReply, limit: TRANSCRIPT_TO_REPLY_MS });
    }
  }
  if (lat.interBurst != null && lat.interBurst > INTER_BURST_MS) {
    over.push({ kind: 'inter-burst', ms: lat.interBurst, limit: INTER_BURST_MS });
  }
  return over;
}
