import { describe, expect, it } from 'vitest';
import {
  HARD_PHASE_C_OUTCOMES,
  OUTCOME,
  PHASE_C_OUTCOME_MARKER,
  PHASE_C_SUMMARY_SCHEMA,
  emptyPhaseCSummary,
  extractCapturedAt,
  extractComparisonDiagnostics,
} from './phase-c-summary.mjs';

// ============================================================================
// scripts/phase-c-summary.test.ts — lock the phase-C STRUCTURED archive.
//
// The driver (drive-live-voice.mjs) writes one phase-c-summary.json per run
// so a cross-week report can compare stuckQueueSince / playbackQueueLength /
// outcome / latency across batches WITHOUT parsing each raw copy-voice-details
// blob (whose shape drifts as diagnostics evolve). These tests inject blobs —
// healthy, pre-deploy (missing newer fields), and unparseable markers — and
// prove the normalization is typed, null-tolerant, and stable, so the archive
// is the trustworthy comparison surface.
// ============================================================================

// A current healthy blob, shaped exactly as the page builds it (gemini.client
// from a real client's getDiagnostics).
const HEALTHY = JSON.stringify({
  capturedAt: '2026-08-18T14:11:53.623Z',
  gemini: {
    client: {
      playing: false,
      playbackQueueLength: 0,
      stuckQueueSince: 0,
      stuckQueueMs: 0,
      transcripts: 0,
      framesSent: 15,
      framesReceived: 4,
      captureRuns: 120,
      lastCaptureAt: 1786414313623,
      wsCloses: 0,
      wsErrors: 0,
      connected: true,
      micStarted: true,
    },
  },
});

// A pre-deploy blob: the queue signature exists, but the newer
// drop-classification fields do not — every absent field must be null, not
// missing, so the report's columns never break.
const PRE_DEPLOY = JSON.stringify({
  capturedAt: '2026-08-01T00:00:00.000Z',
  gemini: {
    client: { playing: false, playbackQueueLength: 0, stuckQueueSince: 0, connected: true, micStarted: true },
  },
});

// The driver's marker strings when the copy button is missing / capture failed.
const MARKER = 'NO_COPY_BUTTON';

describe('scripts/phase-c-summary.mjs · comparison-diagnostics extraction', () => {
  it('normalizes a healthy blob into typed comparison fields', () => {
    expect(extractComparisonDiagnostics(HEALTHY)).toEqual({
      playing: false,
      playbackQueueLength: 0,
      stuckQueueSince: 0,
      stuckQueueMs: 0,
      transcripts: 0,
      framesSent: 15,
      framesReceived: 4,
      captureRuns: 120,
      lastCaptureAt: 1786414313623,
      wsCloses: 0,
      wsErrors: 0,
      connected: true,
      micStarted: true,
    });
  });

  it('treats a pre-deploy blob (missing newer fields) as null-filled, never missing keys', () => {
    const d = extractComparisonDiagnostics(PRE_DEPLOY);
    expect(d).not.toBeNull();
    if (d === null) throw new Error('expected a diagnostics record');
    expect(d.stuckQueueSince).toBe(0);
    expect(d.stuckQueueMs).toBeNull(); // did not exist pre-deploy — null, not absent
    expect(d.framesReceived).toBeNull();
    expect(d.captureRuns).toBeNull();
    expect(Object.keys(d).length).toBe(13); // the full comparison surface stays stable
  });

  it('returns null for a capture-marker, non-JSON, or client-less blob', () => {
    expect(extractComparisonDiagnostics(MARKER)).toBeNull();
    expect(extractComparisonDiagnostics('not a blob')).toBeNull();
    expect(extractComparisonDiagnostics(JSON.stringify({ gemini: {} }))).toBeNull();
    expect(extractComparisonDiagnostics(JSON.stringify({ capturedAt: 'x' }))).toBeNull();
  });

  it('nulls a wrong-typed field instead of shipping a string into a numeric column', () => {
    const d = extractComparisonDiagnostics(
      JSON.stringify({ gemini: { client: { stuckQueueSince: '12', playbackQueueLength: '2', connected: 'yes' } } }),
    );
    expect(d).not.toBeNull();
    if (d === null) throw new Error('expected a diagnostics record');
    expect(d.stuckQueueSince).toBeNull();
    expect(d.playbackQueueLength).toBeNull();
    expect(d.connected).toBeNull();
  });
});

describe('scripts/phase-c-summary.mjs · capturedAt + envelope', () => {
  it('extracts the blob capturedAt and tolerates unparseable input', () => {
    expect(extractCapturedAt(HEALTHY)).toBe('2026-08-18T14:11:53.623Z');
    expect(extractCapturedAt(MARKER)).toBeNull();
    expect(extractCapturedAt(JSON.stringify({}))).toBeNull();
  });

  it('the per-run envelope is schema-locked with every key present (null until filled)', () => {
    const s = emptyPhaseCSummary('https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    expect(s.schema).toBe(PHASE_C_SUMMARY_SCHEMA);
    expect(Object.keys(s).sort()).toEqual(['app', 'capturedAt', 'diagnostics', 'latency', 'outcome', 'rawBlob', 'schema', 'verdict']);
    expect(s.outcome).toBeNull();
    expect(s.verdict).toBeNull();
    expect(s.latency).toBeNull();
    expect(s.diagnostics).toBeNull();
    expect(s.rawBlob).toBeNull();
  });
});

describe('scripts/phase-c-summary.mjs · structured outcome marker', () => {
  it('OUTCOME is the single source of truth and HARD_PHASE_C_OUTCOMES derives from it', () => {
    // The driver assigns summary.outcome = OUTCOME.* and the batch grep builds
    // its alternation from HARD_PHASE_C_OUTCOMES — so the non-pass values are
    // derived from OUTCOME, never a parallel hand-maintained list.
    expect(HARD_PHASE_C_OUTCOMES).toEqual(['stuck', 'undrained', 'unverifiable', 'latency', 'drop']);
    expect(HARD_PHASE_C_OUTCOMES).toEqual(
      Object.entries(OUTCOME)
        .filter(([key]) => key !== 'pass')
        .map(([, value]) => value),
    );
  });

  it('exports the stdout marker the driver prints for the log parsers', () => {
    expect(PHASE_C_OUTCOME_MARKER).toBe('phase-c-outcome:');
  });
});
