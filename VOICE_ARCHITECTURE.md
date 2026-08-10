# Voice Architecture

The Kitchen Agent is voice-first and hands-free. The architecture keeps
speech recognition out of the critical path: the agent layer is
conversation-transport-agnostic (HTTP today, WebRTC on the roadmap) and the
deterministic command router means the most common commands never depend on a
model round-trip.

## Voice status machine

`lib/agent/types.ts` — `LISTENING / THINKING / SPEAKING / OFFLINE / ERROR`,
driven by `USER_SPEAKING → UTTERANCE_SENT → AGENT_RESPONSE →
AGENT_FINISHED`, with `ERROR / DISCONNECTED / RECONNECTED` transitions.
`lib/agent/voice-status.ts` holds the pure reducer (tested separately).

## Conversational routing (per utterance)

1. **Deterministic commands** (`matchCommand`) — "done", "repeat that",
   "pause", "I don't have garlic", "what's in my pantry?" … short-circuit to
   tools. Concise, deterministic, no model cost.
2. **Ingredient extraction** (`extractIngredients`) — quantity-first
   brain-dumps and possession lead-ins ("I have salt, pepper and olive oil")
   become structured ingredient lists, persisted and confirmed.
3. **Free-form provider** (Gemini via `lib/ai/conversation.ts`) — function
   calling with the full tool surface; every proposed tool call is executed
   through the registry and the outcome is confirmed honestly.

## Speech quality (K9 Part E)

Responses are asserted short and unformatted (≤ ~2 spoken sentences, no
markdown) — see `lib/agent/voice-qa.test.ts`. Help is the one deliberately
long reference card, rendered in the UI rather than spoken.

## Safety gate phrasing

A step with a `safetyNote` is not completed on "done" — the agent answers
*"Before you continue: Hot oil. Say 'done' to confirm you understand."* — and
the step completes only on the acknowledgment, with progress preserved
(durable via the `SAFETY_WARNING` phase).

## Mobile/PWA notes (K9 Part F)

- `/manifest.json` provides the install surface (icons are future work).
- Viewport metadata: `width=device-width`, `themeColor #e85d2c`.
- The mobile QA matrix (microphone/audio permissions, reconnect,
  foreground/background, large touch targets) lives in [TESTING.md](./TESTING.md).
