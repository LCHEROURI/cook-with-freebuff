// ============================================================================
// scripts/phase-c-summary.mjs — the phase-C per-run STRUCTURED archive,
// extracted from drive-live-voice.mjs so the schema and the blob-normalization
// are unit-testable.
//
// Every phase-C run writes one phase-c-summary.json to its --out dir (the
// weekly batch uploads the whole dir). The raw copy-voice-details blob is an
// opaque page artifact whose shape drifts as diagnostics evolve — a
// cross-week report comparing stuckQueueSince / playbackQueueLength / outcome
// should read THIS record, not parse each blob. The summary is schema-locked
// (schema: 1) with every key present (null when unknown), so a report never
// breaks on a missing field, and the raw blob text rides along as `rawBlob`
// so no diagnostic fidelity is lost to normalization.
//
// Extraction mirrors the verdict's tolerance: a non-JSON / marker blob (the
// driver's NO_COPY_BUTTON / BLob_CAPTURE_MISS) or an absent gemini.client
// yields `diagnostics: null`; a present client with an absent field yields
// null for that field only (pre-deploy blobs stay readable).
// ============================================================================

export const PHASE_C_SUMMARY_SCHEMA = 1;

// The six phase-C outcome VALUES — the single source of truth. The driver
// assigns `summary.outcome = OUTCOME.stuck` etc., and the batch step builds
// its summary-outcome grep alternation from HARD_PHASE_C_OUTCOMES below, so
// adding or renaming an outcome touches only this file.
export const OUTCOME = {
  pass: 'pass',
  stuck: 'stuck',
  undrained: 'undrained',
  unverifiable: 'unverifiable',
  latency: 'latency',
  drop: 'drop',
};

// The five monitored-contract (non-pass) phase-C outcomes — a failed run
// whose summary records one of these is a hard failure, never a flake.
// Derived from OUTCOME so the set can never drift from the driver's values.
export const HARD_PHASE_C_OUTCOMES = [
  OUTCOME.stuck,
  OUTCOME.undrained,
  OUTCOME.unverifiable,
  OUTCOME.latency,
  OUTCOME.drop,
];

// The structured outcome marker the driver prints to stdout, so the trend +
// escalation parsers (which read workflow LOGS, not the uploaded summary
// file) can classify a run from its outcome instead of grepping fail lines.
export const PHASE_C_OUTCOME_MARKER = 'phase-c-outcome:';

// The comparison surface: exactly the fields the monitors/reports reason
// about. Type-guarded like the verdict — a wrong-typed field is null, never
// a silent string in a numeric column.
const NUMERIC_FIELDS = [
  'playbackQueueLength',
  'stuckQueueSince',
  'stuckQueueMs',
  'transcripts',
  'framesSent',
  'framesReceived',
  'captureRuns',
  'lastCaptureAt',
  'wsCloses',
  'wsErrors',
];
const BOOLEAN_FIELDS = ['playing', 'connected', 'micStarted'];

/** The blob's own capturedAt (the staleness anchor), or null when unreadable. */
export function extractCapturedAt(blobText) {
  try {
    const t = JSON.parse(blobText).capturedAt;
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Normalize the blob's client diagnostics into the comparison record. Returns
 * null when the blob cannot be parsed or carries no gemini.client.
 * @returns {Record<string, number | boolean | null> | null}
 */
export function extractComparisonDiagnostics(blobText) {
  let parsed;
  try {
    parsed = JSON.parse(blobText);
  } catch {
    return null;
  }
  const client = parsed?.gemini?.client;
  if (client == null) return null;
  const out = {};
  for (const f of NUMERIC_FIELDS) out[f] = typeof client[f] === 'number' ? client[f] : null;
  for (const f of BOOLEAN_FIELDS) out[f] = typeof client[f] === 'boolean' ? client[f] : null;
  return out;
}

/**
 * The per-run record skeleton — every key present, null until the driver
 * fills it. The driver mutates this through the phase-C branches and writes
 * it once at the shared exit, so every outcome archives the same shape.
 */
export function emptyPhaseCSummary(app) {
  return {
    schema: PHASE_C_SUMMARY_SCHEMA,
    app,
    capturedAt: null,
    outcome: null, // 'pass' | 'stuck' | 'undrained' | 'unverifiable' | 'latency' | 'drop'
    verdict: null, // { stuck, kind, evidence } when the blob was evaluated
    latency: null, // { flushToTranscript: [n|null, n|null], transcriptToReply: [n|null, n|null], interBurstMs }
    diagnostics: null, // extractComparisonDiagnostics output
    rawBlob: null, // the raw copy-voice-details text (or the capture marker)
  };
}
