# The pre-fix "first burst then dead" drop — the exact signature the fix eliminated

*Companion to [`mic-regression-trend.md`](./mic-regression-trend.md). Written Aug 18, 2026.*

## 1. Provenance — the four raw blobs were never archived

The four failing phase-C blobs (the pre-fix measurement that proved the 33%
drop rate) do **not exist in any archive**. The full search trail:

| Where we looked | Result |
|---|---|
| GitHub Actions artifacts, repo-wide (`/actions/artifacts`) | **0 artifacts total** — green runs persisted nothing pre-fix, and the red-run artifact path never fired. **(Changed Aug 18:** the phase-C driver now archives the raw blob on every run — see below.) |
| Git history (`--all`, `--diff-filter=A -- '*blob*.json'`) | nothing committed |
| GitHub issue/PR bodies and comments (`playbackQueueLength in:body,comments`) | nothing quoted |
| Local captures (`/tmp/voice-blob.json`, `/tmp/phase-c-*`, `/tmp/live-voice-drive`) | only the **healthy** capture survives (`/tmp/voice-blob.json`, 2026-08-18) |

They were captured in memory during the pre-fix local measurement batches and
survived only as a **description**. This document reconstructs them
field-by-field from the strongest surviving evidence and diffs the
reconstruction against a real healthy blob, so the signature is documented
even though the raw bytes are gone.

**This gap is closed as of Aug 18:** the phase-C driver now writes
`phase-c-summary.json` — a schema-locked structured record (the raw
copy-voice-details text embedded as `rawBlob`, plus normalized
`diagnostics`, `verdict`, `latency`, and `outcome`) — to its `--out` dir on
**every** run, green or red, on both the two-burst path and the drop path
(see the *"structured summary archived"* note in the driver). The weekly
batch uploads the whole dir, so every run's diagnostics are archived
permanently and a cross-week report can compare `stuckQueueSince` / queue
length / outcome across batches without parsing each blob — a future
regression's raw evidence will exist without reconstruction, and this
document becomes the record of the *historical* signature only.

## 2. Evidence the reconstruction is built on

1. **Commit `2c36be3`** (Aug 12, "surface the stuck-queue state…") names the
   signature verbatim: *"The idle stuck-queue drop signature (playing=false,
   non-empty queue, playbackStalls=0) was invisible in a pasted diagnostics
   blob."*
2. **`scripts/voice-blob-verdict.test.ts`** — the `STUCK_SINCE` fixture is
   described as *"the pre-fix drop signature verbatim: playing=false, queue
   non-empty, and a non-zero stuckQueueSince — this is exactly what the four
   failing blobs looked like, **except the stuck state was invisible then**"*
   — pinning `playbackQueueLength: 2`.
3. **The diagnostics field set at capture time** (`VoiceSessionDiagnostics` at
   `2c36be3^`): exactly 20 fields, **no `stuckQueueSince`, no `stuckQueueMs`**.
4. The **failure mode** (burst 1 transcribed, then the mic went dead): the
   session was healthy up to the drop — socket up, audio streamed, one
   transcription — then playback idled with the queue stuck.

## 3. The reconstructed pre-fix blob (a stuck run, captured at the drop)

Shape is exact (page + hook envelopes are byte-identical to today); values
marked **[S]** come from the archived description, **[i]** are inferred from
the failure mode.

```json
{
  "active": "gemini-live",
  "capturedAt": "<capture time>",
  "gemini": {
    "engine": "gemini-live", "mode": "live", "status": "LISTENING",
    "hearing": false,
    "micReplying": true,            // [i] mic muted for playback that never drained
    "awaiting": false, "connectTimeoutMs": 5000, "error": null,
    "client": {
      "tokenHttpStatus": 200, "tokenError": null,      // [i] session worked for burst 1
      "wsOpens": 1, "wsCloses": 0, "wsLastCloseCode": null, "wsErrors": 0, // [i] socket alive
      "transcripts": 1,             // [i] burst 1 transcribed — the "first burst" half
      "agentSpeech": 0, "turnCompletes": 0,            // [i] reply never completed
      "flushesSent": 1,             // [i] burst 1's audioStreamEnd fired
      "framesSent": 15,             // [i] mic audio streamed (healthy capture shows 15)
      "playbackStalls": 0,          // [S] THE signature — the watchdog never fired
      "connectTimeoutMs": 5000,
      "micStarted": true, "micError": null, "lastError": null,  // [i] mic graph fine
      "hearing": false, "connected": true,            // [i] connection never dropped
      "playing": false,             // [S] THE signature — playback idle
      "playbackQueueLength": 2      // [S] THE signature — queue non-empty (never drained)
      /* ❌ stuckQueueSince / stuckQueueMs did not exist yet — the stuck
           state was indistinguishable from healthy without the console */
    },
    "browser": { "userAgent": "…", "webSpeech": true, "audioContext": true, "webSocket": true }
  },
  "webSpeech": { "supported": true, "listening": false, "interim": "", "error": null }
}
```

## 4. Diff vs a real healthy blob (live capture 2026-08-18T14:11:53Z)

The discriminating fact: **in the fields that existed pre-fix, a stuck blob
and a healthy blob were almost identical** — both show `connected=true`,
`micStarted=true`, `playing=false`, `playbackStalls=0`. The only differences
were the ones the human eye had to catch:

| Field | Pre-fix stuck blob (reconstructed) | Healthy blob (real capture) | Verdict |
|---|---|---|---|
| `client.playing` | `false` | `false` | identical — idle alone is healthy |
| `client.playbackQueueLength` | **`2`** | `0` | **the discriminator** — idle *with* a stuck queue |
| `client.playbackStalls` | `0` | `0` | identical — the watchdog hadn't fired |
| `client.transcripts` | `1` (burst 1) | `0` (probe fed silence) | different, not diagnostic |
| `client.framesSent` | `>0` | `15` | both prove audio flowed |
| `client.connected` / `micStarted` | `true` / `true` | `true` / `true` | identical — network + mic graph were FINE |
| `gemini.micReplying` | `true` (muted) | `false` | different — mute stuck on |
| `client.stuckQueueSince` | **missing** | `0` | **the field that didn't exist** |
| `client.stuckQueueMs` | **missing** | `0` | **the field that didn't exist** |

The exact signature the fix eliminated, in one sentence: **`playing=false`
∧ `playbackQueueLength>0` (idle playback with a non-empty queue) while
`connected=true` and `micStarted=true`** — i.e., the network and the mic
audio graph were healthy and the queue had real chunks waiting, but the
drain had stopped and no stall was recorded. Every "healthy-looking" field
was identical; only the queue length betrayed the drop.

## 5. What the fix made visible (and what would catch it today)

| Commit | What it added | Effect on the signature |
|---|---|---|
| `33c3926` (Aug 12) | stall watchdog covers the idle stuck-queue state | the state now **clears itself** after 15s instead of muting the mic forever |
| `2c36be3` (Aug 12) | `stuckQueueSince` in the blob | the stuck state became **visible** in a paste |
| `8ae2450` (Aug 12) | `stuckQueueMs` | the paste reads "stuck for N ms" with no epoch math |
| `voice-blob-verdict.mjs` | `evaluateVoiceBlob` | the passing-run assertion **fails the harness** on `stuckQueueSince ≠ 0` (unit-tested with the injected `STUCK_SINCE` fixture) |
| drop-classification fields | `framesReceived`, `captureRuns`, `playbackChunksPlayed`, … | a modern blob classifies the drop layer (queue / network / audio-graph) instead of hiding it |

A **current** capture of the same stuck state would differ from the healthy
blob at `stuckQueueSince≠0` / `stuckQueueMs>0` — the exact fields the
reconstructed pre-fix blob lacks — and `evaluateVoiceBlob` would judge it
stuck, reddening the mic-regression run. The pre-fix blob's modern
equivalent is the verdict test's `STUCK_SINCE` fixture:
`playing=false, playbackQueueLength=2, stuckQueueSince≠0, stuckQueueMs>0` —
the four failing blobs, with the invisible state finally visible.

## 6. Why the bug survived

A stuck run's paste was *indistinguishable from a healthy one* in every field
that existed: `connected=true`, `micStarted=true`, `playing=false`,
`playbackStalls=0`, `wsErrors=0`. A user's report of "it heard my first
phrase, then went dead" could not be corroborated from the diagnostics, and
the monitor did not exist yet — so the 33% failure rate was only measurable
by repeated live runs, not by inspecting a single blob. The fix's real
contribution was making the failure **legible**: one new field
(`stuckQueueSince`) turned an invisible state into a paste-able, assertable,
monitor-able signature.
