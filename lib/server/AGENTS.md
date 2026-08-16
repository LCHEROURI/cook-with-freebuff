# lib/server/

## Overview

The server side of the app: Firebase Admin wiring, Firestore repositories, the cooking-session state machine service, guided-cooking delivery, pantry/leftover/grocery services, and the tool registry the AI model calls to touch state. Routes that execute state tools — `/api/cook`, `/api/agent`, `/api/tools`, `/api/kitchen` — resolve the user server side and build a `ToolContext` from here via `buildProductionContext`; authentication-only routes like `/api/voice/token` never touch it.

## Key files

| File | Owns |
|---|---|
| `admin.ts` | Firebase Admin app + auth + Firestore singletons (server-only) |
| `app-check.ts` | Verifies the `X-Firebase-AppCheck` attestation before Gemini-quota work; monitor mode today, enforced via flag |
| `repositories.ts` | Typed repository interfaces + Firestore implementations. NO raw Firestore calls from service modules (route-level admin reads like `/api/status`' deploy_status check are intentional) |
| `stores.ts` | Binds repositories to the tool-store interfaces and builds `buildProductionContext(userId)` — the `ToolContext` for routes that execute state tools |
| `session-service.ts` | The K1 state machine as a persistent service; optimistic version checks + correlation markers on every transition, with non-atomic audit events (see Conventions) |
| `guide-service.ts` | Guided cooking (K6): one physical action at a time, timer auto-start, safety gates |
| `tools/` | The tool registry: `registry.ts` (dispatch) + per-domain tool modules (`ingredient-tools.ts`, `recipe-tools.ts`, `timer-tools.ts`, `session-tools.ts`, `pantry-tools.ts`, `grocery-tools.ts`, `leftover-tools.ts`, `guide-tools.ts`) + `types.ts` (store interfaces) |
| `pantry-service.ts` | Pantry memory with confidence (0..1), stale-after expiry, and honest consume-for-recipe |
| `leftover-service.ts` / `grocery-service.ts` | K10 leftovers + grocery list intelligence |
| `model-config.ts` | Gemini model names from the Remote Config layer only: unset → null (the caller's env-var → default chain applies), and a failed refresh serves the last-good cached params — the role → (parameter, env, default) table lives in `lib/ai/model-roles.ts`, the single source of truth |
| `requestContext.ts` | `AsyncLocalStorage` carrying a correlation id; `/api/cook`, `/api/agent`, and `/api/tools` wrap requests with `runWithContext` (other routes never enter it; `logger.ts` does not read it automatically) |
| `logger.ts` | Structured logging: one JSON object per line, correlation id threaded through |

## Conventions

- `import 'server-only'` guards the boundary modules: `admin.ts`, `stores.ts`, `repositories.ts` (pinned by `security.test.ts`; `app-check.ts` and `model-config.ts` carry it too). Services, tools, `logger.ts`, and `requestContext.ts` intentionally omit it so Vitest can import them — there is no universal mandate.
- No raw Firestore in services: reads/writes go through the repository layer (`repositories.ts`), which Zod-validates CREATES before persisting. The update partials (`updatePantryItem`, `updateLeftover`, `updateGroceryItem`) pass straight through without a schema check — a documented exception, not a validation duty on callers.
- Services depend on narrow store interfaces (e.g. `SessionStore`), not the repositories directly — each interface has an in-memory implementation beside it for tests (e.g. `InMemorySessionStore`).
- Sessions are optimistic-concurrency: every mutating call takes `expectedVersion` and throws `VersionConflictError` on mismatch. Correlation ids dedupe client retries — the marker write rides the same transaction as the session update (never a separate write that can fail after commit).
- Event-sourced transitions: the service writes a typed event (`SESSION_STARTED`, `STEP_COMPLETED`, `TIMER_STARTED`, ...) as a separate await after the state change — non-atomic audit records, so a failed `createEvent` leaves the state advanced without the event; only the correlation marker rides the update's transaction.
- Errors follow the structured `{ code, recoverable }` shape with a `message`: `SessionError` in the session service, and `GuideError`/`PantryError`/`LeftoverError`/`GroceryError` in their services. `recoverable: true` means the client can retry.
- The AI model touches state ONLY through tools in `tools/` — executed tools log latency and error codes to `agent_tool_logs`; pre-dispatch failures (`UNKNOWN_TOOL`, `INVALID_ARGUMENTS`) return before any log record is written.

## Gotchas

- `buildProductionContext` is the only sanctioned way routes get a `ToolContext` in production; tests build their own with in-memory stores.
- App Check: emulators pass the gate unconditionally (they cannot attest); enforcement is opt-in via `APP_CHECK_ENFORCED=1`. Do not make quota-bearing routes skip the check in production.
- The `recoveryContext.retryCount` budget is deliberately NOT cleared on recover — repeated failures stay bounded (K7).
- Timer rebasing (`rebaseActiveTimers`) is what makes pause/resume agree between the screen and the server — a broken rebase surfaces as timers that drift after resume.

## Related specs

- `docs/specs/0001` (App Hosting primary host) and `docs/specs/0002` (probe grace constants) govern the verify scripts, not this area; the session-state machine and event sourcing are documented in `STATE_MACHINE.md` and `AGENT_TOOLS.md` at the repo root.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
