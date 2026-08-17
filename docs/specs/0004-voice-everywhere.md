# Voice Everywhere — Design

**Date**: 2026-08-17
**Status**: Proposed (design approved by engineer in the 2026-08-17 brainstorm; implementation plan pending)

## Overview

The app is voice-first inside the cooking session: `/cook` has the free-form command mic (`useVoiceInput`), the recipe starter has Gemini Live dictation (`useLiveDictation`), and the active session has full realtime Gemini Live (`useGeminiLive`). Outside that session the app is silent and type-only: the kitchen surface (pantry, grocery, leftovers, dietary profile), the recipes search, and the recipe detail stepper all require typing.

This design makes every meaningful input speakable (transcription into the field, no model round-trip) and adds a small set of spoken outputs (confirmations, safety warnings, and recipe read-aloud). The hybrid is deliberate: voice *as a typewriter* everywhere, voice *as an assistant* only where the agent already exists (the cooking session).

## Decisions (settled in the brainstorm)

| Question | Decision |
|---|---|
| Hybrid shape | **B everywhere + A on the cooking session.** Every input gets a transcription mic (client-side, no model); the agent path (`/api/agent`) stays exactly as it is and remains the only place a spoken phrase is *interpreted* and *acted on*. |
| Scope | **Full sweep.** Kitchen (pantry, grocery, leftover, dietary), recipes search, and the recipe detail stepper all get the mic. Login and the internal status page stay typed by design. |
| Voice output | **Tier B.** Short confirmations + safety warnings speak via the browser's `SpeechSynthesis`; the recipe detail page gains a read-aloud affordance. No change to Gemini Live's native speech inside the cook session. |
| Awkward inputs | **Text fields + the stepper.** The mic appends to every text field; a tiny deterministic number parser sets the stepper ("eight" → 8). Filter/sort dropdowns stay tap. |
| Speak-back trigger | **Voice-initiated only.** A confirmation is spoken only when the action came from the mic; typed actions stay visually confirmed. Safety warnings are the exception — they always speak. |
| Field shape | Reuse `lib/domain/fieldUI.ts` separators: `, ` for list fields (allergies, restrictions, disliked ingredients, cuisines), `\n` for free-text notes, plain replacement for single-value fields (name, quantity, unit). |

## Approaches considered

- **A. Voice as a conversation everywhere.** Route every spoken phrase through `/api/agent` so the model interprets and acts. Most powerful, but a model round-trip and per-surface tooling for every input; conflicts with the repo's "voice-first never means voice-only" and the review-before-act principle the starter already embodies.
- **B. Voice as a typewriter everywhere.** A mic on every input that transcribes into the field; the existing submit path runs unchanged. Predictable, cheap, no model cost, typed fallback intact. Chosen as the baseline.
- **Hybrid A+B (chosen).** B on every input; A stays only inside the cooking session where the agent already exists. No new agent surfaces, no new tool wiring.

## Design

### 1. Reusable primitive: `VoiceInputButton`

A new shared component `components/VoiceInputButton.tsx` wrapping the existing `useVoiceInput` hook. It renders a mic button plus the interim caption while listening, and on the final transcript appends the text into its target field using the field's separator. The typed input remains the fallback everywhere (never voice-only).

- The append target is the field's `data-voice-separator` attribute, already attached by `FormInput`/`FormTextarea` via `fieldUI` + `field` (the `fieldUI.ts` annotation surface). The button reads that attribute to choose the append strategy: `, ` (list), `\n` (notes), or plain replace (single value).
- The `useVoiceInput` hook is reused as-is: tap to start, accumulate the full utterance, tap to stop and flush the transcript, with its existing retry-exhaustion and `self-check` diagnostics intact.

### 2. `FormInput` / `FormTextarea` gain a mic

`components/FormField.tsx` gets a `voice?: boolean` prop. When true, it renders the `VoiceInputButton` beside the field, wired to append into the same `value`/`onChange`. The kitchen uses a mix of field kinds: the list/notes fields already render through `FormInput`/`FormTextarea` (the `voice` prop covers them), while the single-value fields (name, quantity, unit, title, servings) and the recipes search box are raw `<input>`s today — those get the `VoiceInputButton` placed beside them directly. A shared pure helper `appendTranscript(current, incoming, separator)` in `lib/domain/fieldUI.ts` owns the append rule (replace when there is no separator, append with the separator otherwise), used by both the `voice` prop and the raw-input wiring.

### 3. Stepper number parser

A pure module `app/recipes/servings-parser.ts` (no React, node-testable, beside `recipe-scaler.ts` and `recipe-filter.ts`) exports `parseServings(text: string): number | null`:

- Accepts digits ("8"), number words ("eight", "ten"), and trailing-unit forms ("8 servings").
- Returns `null` when no number is found (the mic is ignored, the stepper stays put).
- Bounds to the stepper's 1–24 range.

The recipe detail page's stepper gains a mic that transcribes, parses, and sets `targetServings` — still bounded 1–24, still a display-only change (the stored recipe and the Start handoff stay the base, exactly as today).

### 4. Speech output: `useSpeech` + confirmations + safety

A new hook `lib/hooks/useSpeech.ts` wraps the browser `SpeechSynthesis` API: `speak(text)`, `stop()`, and `speaking`. It is the single TTS seam for the non-cook surfaces.

- **Confirmations.** Kitchen and recipes submit handlers speak a short confirmation only when the action was voice-initiated (a source flag set when the `VoiceInputButton` produced the value). Typed submissions stay silent.
- **Safety warnings.** The cooking session already speaks safety warnings through Gemini Live; no change there. On the detail page, safety notes are spoken as part of read-aloud (below). There is deliberately no auto-speak on page load.
- **Degradation.** When the browser has no voices, `useSpeech` is a no-op and the text remains on screen — no error spam.

### 5. Recipe read-aloud

A local component `app/recipes/[id]/RecipeReadAloud.tsx` on the detail page, using `useSpeech`:

- **"Read this step"** on each prep/cooking step speaks the instruction, its time, and its safety note if present.
- **Read all** speaks the steps in order with a **Stop** control that cancels the current utterance.
- Read-aloud is always user-initiated and independent of the confirmations rule.

## Data flow

- **In:** mic → Web Speech → transcript → append into the field with the right separator → the user reviews → the existing submit path runs unchanged. No model round-trip, no auto-submit.
- **Out:** voice-initiated submit → spoken confirmation; safety note → spoken in read-aloud; read-aloud → user-initiated only.

## Error handling

- **Mic:** reuses `useVoiceInput`'s retry-exhaustion and `lib/voice/self-check.ts` (mic denied, no API, dead network all surface honestly). The typed fallback is always present.
- **Speech output:** a browser with no voices degrades to silent text, never an error.
- **Number parser:** an unparseable utterance is a no-op (stepper unchanged), never an error.

## Testing

- **Unit:** `parseServings` boundaries (digits, number words, trailing units, no-match, 1–24 clamping); the separator-append logic (list vs paragraph vs single-value).
- **jsdom:** `VoiceInputButton` appends with the right separator; the stepper mic sets servings; confirmations speak only on voice-initiated actions (and never on typed); read-aloud speaks and stops.
- **Contract:** the verify drivers (`scripts/drive-*.mjs`) extend to pin the new mics, following the repo's contract-locked culture.

## Scope boundaries

- No change to `/api/agent`, the tool registry, the orchestrator, or any server code — the agent path stays exactly as it is.
- No voice on login, the status page, or filter/sort dropdowns.
- No auto-submit from voice; the user always reviews before an action.
- No new Gemini Live or Web Speech service beyond what exists; TTS is browser `SpeechSynthesis` only.

## Follow-ups (recorded, not in scope)

- A client-side Remote Config feature flag (`voice_everywhere_enabled`) as a live kill switch / staged rollout, if the feature ever needs one. Decided against for v1: the feature is additive and every mic keeps its typed fallback, so shipping flag-free is the simpler call. The repo uses Remote Config server-side only today (`lib/server/model-config.ts`), so a flag would mean wiring the client-side SDK.
- Voice-driving filter/sort choices (rejected here — tap is better; revisit if users ask).
- WebRTC/agent voice on the kitchen surface (deliberately out of scope; the agent stays cooking-only).
- Reading a recipe aloud on a timer while cooking hands-free.

## Files touched

- `components/VoiceInputButton.tsx` (new) + test — the reusable transcription mic.
- `lib/domain/fieldUI.ts` — add the pure `appendTranscript` helper + test.
- `components/FormField.tsx` — `voice` prop that renders the mic; `FormField.test.tsx` updated.
- `lib/hooks/useSpeech.ts` (new) + test — the `SpeechSynthesis` seam.
- `app/recipes/servings-parser.ts` (new) + test — `parseServings`.
- `app/recipes/[id]/RecipeReadAloud.tsx` (new) — read-aloud, local to the page.
- `app/recipes/[id]/page.tsx` + `page.module.css` — stepper mic + read-aloud.
- `app/kitchen/page.tsx` — wire the mic to pantry/grocery/leftover/dietary inputs.
- `app/recipes/page.tsx` — search box mic.
- `scripts/drive-*.mjs` + `scripts/AGENTS.md` — extend the verify drivers to pin the new mics.
