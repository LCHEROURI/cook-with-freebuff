# Testing

`npm test` (vitest), `npm run typecheck`, `npm run lint`, `npm run build` —
all run in CI on every push (see [DEPLOYMENT.md](./DEPLOYMENT.md)).

## Layers (K9 Part D)

**Unit** — schema validation, state-machine transitions
(`lib/domain/session.test.ts`), ingredient extraction, recipe validation,
substitutions, timer logic, pantry confidence/staleness, commands.

**Integration** — the full journeys through the real services over in-memory
stores: generate → validate, start session → complete steps, pause → resume,
substitution → resume, timer → completion, reconnect → recover
(`lib/server/guide-service.test.ts`, `guide-service-k7.test.ts`,
`pantry-service.test.ts`, `pantry-tools.test.ts`, `k9-e2e.test.ts`).

**End-to-end scenarios** (`lib/server/k9-e2e.test.ts`) — the spec's numbered
scenarios as integration tests: complete full recipe, pause → close → reopen →
resume exact step, previous, repeat, substitution → resume, tool call fails
honestly, **two rapid "done" commands never advance twice** (version
conflict), dietary-incompatible recipe blocked by validation.

**Live e2e** — `npm run verify:live` drives the DEPLOYED app end to end
(seed recipe → owner token → guided flow incl. safety gate + timer → pantry
add/confirm with Firestore read-back → Gemini turn → cleanup). Also runs in
CI after every push.

## Security + observability tests (K9 Parts B/C)

`lib/server/security.test.ts` (cross-user isolation for every resource +
server-only import surface) and `lib/server/logger.test.ts` (JSON log
contract, severity routing, correlation-id propagation, provider-failure
logging).

## Voice QA (K9 Part E)

`lib/agent/voice-qa.test.ts` — responses are short, actionable, and
unformatted (≤ ~2 spoken sentences; HELP exempt as the UI reference card).
Real-device voice QA (background noise, interruptions, silence, poor
connectivity) is a manual checklist on device.

## Mobile / PWA QA matrix (K9 Part F)

| Check | Status |
|---|---|
| iPhone / Android / tablet rendering | Manual on device — responsive layout, portrait-first |
| Mobile Safari + Chrome | Manual on device |
| Microphone permission flow | Manual on device |
| Reconnect after backgrounding | Covered at the API layer (sessions are durable + resumable); device test manual |
| Large touch targets | Manual review |
| Install surface | `/manifest.json` present (icons are future work) |
