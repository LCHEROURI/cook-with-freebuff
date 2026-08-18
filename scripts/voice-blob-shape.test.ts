import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GeminiLiveClient } from '../lib/voice/gemini-live';
import { evaluateVoiceBlob } from './voice-blob-verdict.mjs';

// ============================================================================
// scripts/voice-blob-shape.test.ts — lock the blob-shape contract between the
// page that PRODUCES the copy-voice-details blob and the verdict that READS it.
//
// Why this exists: the verdict deliberately tolerates absent fields (a blob
// from a pre-deploy client must stay clean, not false-stall), so a silent
// shape drift — the page stops nesting diagnostics under `gemini`, the client
// drops/renames a field the verdict reads, or a `typeof` guard goes inert
// because a field changed type — would NOT red the mic monitor. The monitor
// would keep judging blobs clean while the drop-classification went blind.
// That is exactly the failure mode this file exists to fail on instead.
//
// Three locks, all reading the REAL sources (never fixtures):
//   1. Source pins — the page keeps building the blob with `capturedAt` at the
//      root and the live diagnostics under `gemini:`, and the verdict keeps
//      reading `parsed?.gemini?.client`. A rename on either side fails here.
//   2. Field-set lock — the verdict reads EXACTLY the authoritative field list
//      below (derived from its own source, compared against the pinned list).
//      The verdict adding or dropping a read fails with a legible diff.
//   3. Behavioral lock — a REAL GeminiLiveClient's getDiagnostics() output is
//      nested exactly as the page nests it and every pinned field must be
//      present with the type the verdict's guards require, and the resulting
//      blob must be judged clean. If the client stops emitting a verdict-read
//      field (or emits it as a string where the verdict needs a number), the
//      presence/typeof assertion fails.
// ============================================================================

const PAGE = readFileSync('app/cook/page.tsx', 'utf8');
const HOOK = readFileSync('lib/hooks/useGeminiLive.ts', 'utf8');
const VERDICT = readFileSync('scripts/voice-blob-verdict.mjs', 'utf8');

// The authoritative contract: every path the verdict reads, with the type its
// `typeof` guards require. A wrong type is silently inert (guarded reads fall
// back to 0/false and the classification goes blind), so the type is part of
// the contract, not just the name.
const CONTRACT: Record<string, string> = {
  capturedAt: 'string',
  'gemini.client.connected': 'boolean',
  'gemini.client.micStarted': 'boolean',
  'gemini.client.stuckQueueSince': 'number',
  'gemini.client.stuckQueueMs': 'number',
  'gemini.client.wsCloses': 'number',
  'gemini.client.wsErrors': 'number',
  'gemini.client.framesSent': 'number',
  'gemini.client.framesReceived': 'number',
  'gemini.client.lastFrameReceivedAt': 'number',
  'gemini.client.lastFrameSentAt': 'number',
  'gemini.client.captureRuns': 'number',
  'gemini.client.lastCaptureAt': 'number',
};

/** The blob exactly as the page builds it: page's copyMicDiagnostics → the
 *  hook's getDiagnostics → the client's getDiagnostics. The page calls the
 *  HOOK API (live.getDiagnostics()), which nests the raw client session
 *  diagnostics under `client` — so gemini.client.<field> is the real path the
 *  verdict reads. The hook shape is replicated here and source-pinned below,
 *  so a rename on either side fails the pins instead of silently drifting.
 *  getDiagnostics() is safe pre-connect — the diag counters are initialized in
 *  the field initializer and the connected/playing getters read only
 *  null-safe state. */
function buildRealBlob(): string {
  const client = new GeminiLiveClient({});
  return JSON.stringify(
    {
      active: 'gemini-live',
      capturedAt: new Date().toISOString(),
      gemini: {
        engine: 'gemini-live',
        mode: 'live',
        status: 'LISTENING',
        hearing: false,
        micReplying: false,
        awaiting: false,
        connectTimeoutMs: 5000,
        error: null,
        client: client.getDiagnostics(),
        browser: { userAgent: 'contract-test', webSpeech: true, audioContext: true, webSocket: true },
      },
      webSpeech: { supported: true, listening: false, interim: '', error: null },
    },
    null,
    2,
  );
}

/** Every field the verdict actually reads off `client`, from its own source. */
function verdictReadFields(): Set<string> {
  const fields = new Set<string>();
  const clientField = /\bclient(?:\?\.|\.)([A-Za-z_$][\w$]*)/g;
  for (const m of VERDICT.matchAll(clientField)) fields.add(`gemini.client.${m[1]}`);
  if (/\bparsed\?\.capturedAt/.test(VERDICT)) fields.add('capturedAt');
  return fields;
}

describe('scripts/voice-blob-shape.test.ts · copy-voice-details blob-shape contract', () => {
  it('the page keeps nesting the blob exactly where the verdict reads it', () => {
    // The staleness anchor must stay at the blob root and the hook's
    // diagnostics under `gemini` — the verdict reads parsed?.gemini?.client.
    expect(PAGE).toContain('capturedAt: new Date().toISOString(),');
    expect(PAGE).toContain('gemini: live.getDiagnostics(),');
    expect(PAGE.indexOf('capturedAt:')).toBeLessThan(PAGE.indexOf('gemini: live.getDiagnostics(),'));
    expect(VERDICT).toContain('parsed?.gemini?.client');
    // The webSpeech fallback block is part of the same blob object — pin it
    // so the page cannot silently drop the sibling keys the copy button ships.
    expect(PAGE).toContain('webSpeech: {');
  });

  it('the hook keeps nesting the client session diagnostics under `client`', () => {
    // The page calls live.getDiagnostics() — the HOOK's API, not the raw
    // client's. The hook must keep exposing the raw client diagnostics at the
    // `client` key (a rename to e.g. `session` would make the verdict's
    // gemini.client read undefined → every blob judged 'missing' → red weeks).
    expect(HOOK).toContain('client: clientRef.current?.getDiagnostics() ?? null');
    // And the hook's diagnostics must still ride the `gemini` key on the page
    // — a flatten would need BOTH this test and the verdict to change.
    expect(HOOK).toContain("engine: 'gemini-live'");
  });

  it('the verdict reads EXACTLY the pinned field list — no silent additions or removals', () => {
    const derived = verdictReadFields();
    const pinned = Object.keys(CONTRACT);
    // Dedupe guard: a regex double-match (e.g., a comment quoting a field)
    // would silently pass the equality below, so assert the derivation itself.
    expect(derived.size).toBe(pinned.length);
    expect([...derived].sort()).toEqual([...pinned].sort());
  });

  it('a real copied blob carries every verdict-read field with the type its guards require', () => {
    const blob = JSON.parse(buildRealBlob()) as Record<string, unknown>;
    // The nesting itself must exist — an absent client is judged 'missing' by
    // the verdict, which would red every blob the monitor captures.
    expect((blob.gemini as Record<string, unknown> | undefined)?.client).toBeDefined();
    for (const [path, type] of Object.entries(CONTRACT)) {
      // Walk the dotted path from the blob root so the path list stays the
      // single source of truth for the nesting (gemini.client.<field>).
      let value: unknown = blob;
      for (const part of path.split('.')) {
        value = (value as Record<string, unknown> | null | undefined)?.[part];
      }
      expect(value, `blob field ${path} must be present`).not.toBeUndefined();
      expect(typeof value, `blob field ${path} must stay ${type} (a guarded typeof falls back silently)`).toBe(type);
    }
  });

  it('the real blob is judged clean — the shipped shape never false-positives the verdict', () => {
    const v = evaluateVoiceBlob(buildRealBlob());
    expect(v.stuck).toBe(false);
    expect(v.kind).toBeNull();
  });
});
