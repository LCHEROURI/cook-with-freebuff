# Architecture Context

## Layers

1. Next.js pages and presentational components provide the mobile, voice-first UI.
2. Hooks own client authentication, voice, and browser integration state.
3. Protected routes verify identity, gate App Check where required, validate
   input, and delegate.
4. Server services implement cooking sessions and kitchen domains behind narrow
   store interfaces.
5. The repository layer is the Firestore persistence boundary.
6. AI providers return validated structured data; registered tools are the only
   model-controlled path to state changes.

## Request flow

Protected browser requests attach a Firebase ID token. The route resolves the
UID on the server; quota-bearing routes also verify App Check. Routes construct
the production context and call a service or tool. Firestore documents remain
owner-scoped, and tool calls emit structured audit logs best effort.

## Core invariants

- Session state and timers are persistent, not conversation-only.
- A cook never skips or duplicates a step during retries or recovery.
- Safety warnings require explicit acknowledgement.
- Existing-session writes use optimistic version checks where documented.
- Correlation markers make retryable transitions idempotent.
- AI output is schema validated before entering the domain.
- Firebase and model credentials never reach the browser.

See `ARCHITECTURE.md`, `DATA_MODEL.md`, `STATE_MACHINE.md`,
`VOICE_ARCHITECTURE.md`, `SECURITY.md`, and directory `AGENTS.md` files for the
full curated contracts.
