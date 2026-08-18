import { describe, expect, it } from 'vitest';
import {
  phaseCLatency,
  latencyViolations,
  isTranscriptionFrame,
  isReplyFrame,
  FLUSH_TO_TRANSCRIPT_MS,
  TRANSCRIPT_TO_REPLY_MS,
  INTER_BURST_MS,
} from './phase-c-latency.mjs';

// ============================================================================
// scripts/phase-c-latency.test.ts — prove the phase-C latency pairing and
// bounds with injected wire fixtures (CDP-style timestamps in SECONDS,
// monotonic since the target started — only deltas matter).
//
// The driver (drive-live-voice.mjs) captures timestamped frames, calls
// phaseCLatency + latencyViolations, and FAILS the harness on any violation,
// so the two-burst proof stops being pass/fail and starts bounding HOW FAST
// the bursts were. A slow-but-eventual turn (which the old gate passed) must
// redden here — the negative paths below inject slow/missing markers and
// prove the bounds fire without a live browser, the same discipline as
// scripts/voice-blob-verdict.test.ts.
// ============================================================================

type Frame = { t: number | null; payload: string };
const flush = (t: number | null): Frame => ({ t, payload: JSON.stringify({ realtimeInput: { audioStreamEnd: true } }) });
const trans = (t: number | null, text = 'chicken, rice and onion, for four people'): Frame => ({
  t,
  payload: JSON.stringify({ serverContent: { inputTranscription: { text }, turnComplete: false } }),
});
const reply = (t: number | null): Frame => ({
  t,
  payload: JSON.stringify({
    serverContent: {
      outputTranscription: { text: 'Sounds good' },
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
    },
  }),
});

// A healthy two-burst exchange on the wire, interleaved in order:
//   flush1 → trans1 → reply1 → flush2 → trans2 → reply2
const HEALTHY = {
  flushes: [flush(10.0), flush(16.0)],
  transcriptions: [trans(10.5), trans(16.4)],
  replies: [reply(12.0), reply(18.0)],
};

describe('scripts/phase-c-latency.mjs · frame classifiers', () => {
  it('classifies a FINAL input transcription (text present) and rejects text-less frames', () => {
    expect(isTranscriptionFrame(trans(1).payload)).toBe(true);
    expect(isTranscriptionFrame(JSON.stringify({ serverContent: { inputTranscription: { text: '' } } }))).toBe(false);
    expect(isTranscriptionFrame(JSON.stringify({ serverContent: { turnComplete: true } }))).toBe(false);
    expect(isTranscriptionFrame('not json')).toBe(false);
  });

  it('classifies reply content — outputTranscription text OR modelTurn audio', () => {
    expect(isReplyFrame(reply(1).payload)).toBe(true);
    expect(isReplyFrame(JSON.stringify({ serverContent: { outputTranscription: { text: 'ok' } } }))).toBe(true);
    expect(isReplyFrame(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } }))).toBe(true);
    expect(isReplyFrame(JSON.stringify({ serverContent: { inputTranscription: { text: 'hi' } } }))).toBe(false);
    expect(isReplyFrame(JSON.stringify({ setupComplete: {} }))).toBe(false);
  });
});

describe('scripts/phase-c-latency.mjs · burst pairing', () => {
  it('pairs each flush → transcription → first reply after it, on a healthy interleaved exchange', () => {
    const lat = phaseCLatency(HEALTHY);
    expect(lat.bursts).toEqual([
      { flushToTranscript: 500, transcriptToReply: 1500 },
      { flushToTranscript: 400, transcriptToReply: 1600 },
    ]);
    expect(lat.interBurst).toBe(5900);
    expect(lat.flushCount).toBe(2);
    expect(latencyViolations(lat)).toEqual([]);
  });

  it('never pairs a reply frame that arrived BEFORE the transcription (a stale earlier turn)', () => {
    const lat = phaseCLatency({
      flushes: [flush(10.0)],
      transcriptions: [trans(10.5)],
      replies: [reply(9.0), reply(12.0)], // the 9.0 reply belongs to an earlier turn
    });
    expect(lat.bursts[0].transcriptToReply).toBe(1500);
    expect(lat.bursts[0].transcriptToReply).not.toBe(-1500);
  });

  it('ignores extra silence flushes beyond the two bursts (pairing is by first two)', () => {
    const lat = phaseCLatency({ ...HEALTHY, flushes: [flush(10.0), flush(16.0), flush(22.0)] });
    expect(lat.flushCount).toBe(3);
    expect(lat.bursts[0].flushToTranscript).toBe(500);
    expect(lat.bursts[1].flushToTranscript).toBe(400);
    expect(latencyViolations(lat)).toEqual([]);
  });

  it('stops at one transcription — interBurst stays null until both exist', () => {
    const lat = phaseCLatency({ flushes: [flush(10.0)], transcriptions: [trans(10.5)], replies: [reply(12.0)] });
    expect(lat.bursts).toHaveLength(1);
    expect(lat.interBurst).toBeNull();
    expect(latencyViolations(lat)[0].kind).toBe('unmeasurable');
  });
});

describe('scripts/phase-c-latency.mjs · bound violations', () => {
  it('fires flush-to-transcript when a burst clears the bound', () => {
    const lat = phaseCLatency({
      flushes: [flush(10.0), flush(16.0)],
      transcriptions: [trans(10.0 + FLUSH_TO_TRANSCRIPT_MS / 1000 + 0.1), trans(16.4)],
      replies: [reply(10.0 + FLUSH_TO_TRANSCRIPT_MS / 1000 + 1.0), reply(18.0)],
    });
    const v = latencyViolations(lat);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'flush-to-transcript', burst: 1, limit: FLUSH_TO_TRANSCRIPT_MS });
  });

  it('fires transcript-to-reply when a reply clears the bound', () => {
    const lat = phaseCLatency({
      flushes: [flush(10.0), flush(16.0)],
      transcriptions: [trans(10.5), trans(16.4)],
      replies: [reply(10.5 + TRANSCRIPT_TO_REPLY_MS / 1000 + 0.2), reply(18.0)],
    });
    const v = latencyViolations(lat);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'transcript-to-reply', burst: 1, limit: TRANSCRIPT_TO_REPLY_MS });
  });

  it('fires transcript-to-reply with ms null when a burst got NO reply content frame at all', () => {
    // The settle proved the mic drained idle with no reply ever queued — a
    // real stall, not a reply that hadn't arrived yet.
    const lat = phaseCLatency({ flushes: [flush(10.0), flush(16.0)], transcriptions: [trans(10.5), trans(16.4)], replies: [] });
    const v = latencyViolations(lat);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ kind: 'transcript-to-reply', burst: 1, ms: null });
    expect(v[1]).toMatchObject({ kind: 'transcript-to-reply', burst: 2, ms: null });
  });

  it('fires inter-burst when the re-arm cadence clears the bound', () => {
    const lat = phaseCLatency({
      flushes: [flush(10.0), flush(10.0 + INTER_BURST_MS / 1000 + 1)],
      transcriptions: [trans(10.5), trans(10.5 + INTER_BURST_MS / 1000 + 2)],
      replies: [reply(12.0), reply(60)],
    });
    const v = latencyViolations(lat);
    expect(v.some((x) => x.kind === 'inter-burst' && x.limit === INTER_BURST_MS)).toBe(true);
  });

  it('treats a missing flush for a transcribed burst as unmeasurable, not a pass', () => {
    const lat = phaseCLatency({ flushes: [flush(10.0)], transcriptions: [trans(10.5), trans(16.4)], replies: [reply(12.0), reply(18.0)] });
    const v = latencyViolations(lat);
    expect(v[0]).toMatchObject({ kind: 'unmeasurable', bursts: 2, flushCount: 1 });
    // The violation union is inferred with `kind: string`, so narrow via the
    // message-bearing member instead of a discriminated check.
    expect((v[0] as { message?: string }).message).toContain('latency cannot be bounded');
  });

  it('treats absent CDP timestamps as unmeasurable (no timestamp, no bound)', () => {
    const lat = phaseCLatency({ flushes: [flush(null)], transcriptions: [trans(null)], replies: [reply(null)] });
    expect(lat.bursts[0].flushToTranscript).toBeNull();
    expect(lat.bursts[0].transcriptToReply).toBeNull();
    expect(latencyViolations(lat)[0].kind).toBe('unmeasurable');
  });

  it('boundary — a latency exactly AT the limit is NOT a violation (strict >)', () => {
    const atFlush = FLUSH_TO_TRANSCRIPT_MS / 1000;
    // The whole exchange shifted by the flush window so burst 1's
    // flush→transcript lands EXACTLY on the limit while everything else stays
    // healthy (replies after their transcriptions, trans2 after trans1).
    const lat = phaseCLatency({
      flushes: [flush(10.0), flush(10.0 + atFlush + 1.0)],
      transcriptions: [trans(10.0 + atFlush), trans(10.0 + atFlush + 1.4)],
      replies: [reply(10.0 + atFlush + 2.0), reply(10.0 + atFlush + 3.0)],
    });
    expect(lat.bursts[0].flushToTranscript).toBe(FLUSH_TO_TRANSCRIPT_MS);
    const v = latencyViolations(lat);
    expect(v.filter((x) => x.kind === 'flush-to-transcript')).toHaveLength(0);
  });
});
