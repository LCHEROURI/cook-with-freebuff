# lib/server/

## Overview

The server side of the app: Firebase Admin wiring, Firestore repositories, the cooking-session state machine service, guided-cooking delivery, pantry/leftover/grocery services, and the tool registry the AI model calls to touch state. `/api/agent` and `/api/tools` execute state tools through the tool executor and build a `ToolContext` via `buildProductionContext`. `/api/cook` also builds a `ToolContext`, but consumes `GuidedCookingService` directly and, for `create_recipe`, calls `generateRecipeTool.handler` directly rather than dispatching through `executeTool`; `/api/kitchen` uses the context as a store container while calling domain services directly. Routes that never build a `ToolContext` — like `/api/voice/token`, which mints a Gemini credential and is quota-bearing — stay out of it.

## Key files

| File | Owns |
|---|---|
| `admin.ts` | Firebase Admin app + auth + Firestore singletons (server-only) |
| `app-check.ts` | Verifies the `X-Firebase-AppCheck` attestation before Gemini-quota work; monitor mode today, enforced via flag |
| `repositories.ts` | Typed Firestore CRUD functions behind the narrow store contracts (`SessionStore` in `session-service.ts`, the store interfaces in `tools/types.ts`). NO raw Firestore calls from service modules (route-level admin reads like `/api/status`' deploy_status check are intentional) |
| `stores.ts` | Binds repositories to the tool-store interfaces and builds `buildProductionContext(userId)` — the `ToolContext` for tool-executing routes and other routes, such as `/api/kitchen`, that need the same production stores |
| `session-service.ts` | The K1 state machine as a persistent service; optimistic version checks on existing-session updates + caller-supplied correlation markers, with non-atomic audit events (see Conventions) |
| `guide-service.ts` | Guided cooking (K6): one physical action at a time, timer auto-start, safety gates |
| `tools/` | The tool registry: `registry.ts` (dispatch) + per-domain tool modules (`ingredient-tools.ts`, `recipe-tools.ts`, `timer-tools.ts`, `session-tools.ts`, `pantry-tools.ts`, `grocery-tools.ts`, `leftover-tools.ts`, `guide-tools.ts`) + `types.ts` (store interfaces) |
| `pantry-service.ts` | Pantry memory with confidence (0..1), stale-after expiry, and honest consume-for-recipe |
| `leftover-service.ts` / `grocery-service.ts` | K10 leftovers + grocery list intelligence |
| `model-config.ts` | Gemini model names from the Remote Config layer only: unset → `undefined` (`resolveGeminiModel` returns `string \| undefined`, so callers fall through to their env-var → default chain), and a failed refresh serves the last-good cached params — the role → (parameter, env, default) table lives in `lib/ai/model-roles.ts` — the single source of truth, except `lib/voice/gemini-live.ts` keeps its own hardcoded `DEFAULT_LIVE_MODEL` fallback (used when a minted token omits the model) |
| `requestContext.ts` | `AsyncLocalStorage` carrying a correlation id; `/api/cook` POST plus the `/api/agent` and `/api/tools` POST handlers wrap execution with `runWithContext`. `/api/cook` GET and other routes do not enter this context; `logger.ts` does not read it automatically. |
| `logger.ts` | Structured logging: one JSON object per line, correlation id threaded through |

## Conventions

- `import 'server-only'` guards the boundary modules: `admin.ts`, `stores.ts`, `repositories.ts` (pinned by `security.test.ts`; `app-check.ts` and `model-config.ts` carry it too). Services, tools, `logger.ts`, and `requestContext.ts` intentionally omit it so Vitest can import them — there is no universal mandate.
- No raw Firestore in services: reads/writes go through the repository layer (`repositories.ts`), which Zod-validates CREATES before persisting. The update partials (`updatePantryItem`, `updateLeftover`, `updateGroceryItem`) pass straight through without a schema check — a documented exception, not a validation duty on callers.
- Services depend on narrow store interfaces (e.g. `SessionStore`), not the repositories directly — each interface has an in-memory implementation beside it for tests (e.g. `InMemorySessionStore`).
- Updates to an EXISTING session are optimistic-concurrency: they take `expectedVersion` and throw `VersionConflictError` on mismatch at the service level — a losing transaction race surfaces as a plain `Error` from `repositories.updateSession` and reaches routes as `INTERNAL_ERROR` (creation and audit-only writes like `logSessionEvent`/`clearProcessed` take no version). Correlation ids dedupe client retries on the marker-checking transition methods (they call `hasBeenProcessed` before mutating) — the marker write rides the same transaction as the session update (never a separate write that can fail after commit); transitions without a `correlationId` write no marker, and `handleError`/`recoverFromError` accept an id but do not dedupe on it.
- State transitions write append-only audit events (`SESSION_STARTED`, `STEP_COMPLETED`, `TIMER_STARTED`, ...) as a separate await after the state change — non-atomic, so a failed `createEvent` leaves the state advanced without the event; only the correlation marker rides the update's transaction.
- Domain errors follow the structured `{ code, recoverable }` shape with a `message`: `SessionError` in the session service, and `GuideError`/`PantryError`/`LeftoverError`/`GroceryError` in their services. Dependency/store failures may propagate as ordinary `Error` objects and are not guaranteed to expose `code` or `recoverable`. For structured domain errors, `recoverable: true` means the client can retry.
- The AI model touches state ONLY through tools in `tools/` — executed tools log latency and error codes to `agent_tool_logs` best effort (`createLog` failures are swallowed, so a logging outage never fails a tool result); pre-dispatch failures (`UNKNOWN_TOOL`, `INVALID_ARGUMENTS`) return before any log record is written.

## Gotchas

- `buildProductionContext` is the sanctioned way production routes obtain the shared store-backed `ToolContext`; tool-executing routes dispatch through `tools/`, while `/api/kitchen` uses the context's stores through domain services directly. Tests build their own context with in-memory stores.
- App Check: emulators pass the gate unconditionally (they cannot attest); enforcement is opt-in via `APP_CHECK_ENFORCED=1`. Do not make quota-bearing routes skip the check in production.
- The `recoveryContext.retryCount` budget is deliberately NOT cleared on recover — repeated CLASSIFIED transient failures stay bounded (K7); the unknown-code fallback in `recoverAfterError` returns `RETRY` with `retryCount: 1` without persisting the increment, so it does not consume the budget.
- Timer rebasing (`rebaseActiveTimers`) is what makes pause/resume agree between the screen and the server — a broken rebase surfaces as timers that drift after resume.

## Related specs

- `docs/specs/0001-app-hosting-primary-host.md` (App Hosting primary host) and `docs/specs/0002-probe-grace-constants-source-of-truth.md` (probe grace constants) govern the verify scripts, not this area; the session-state machine and event sourcing are documented in `STATE_MACHINE.md` and `AGENT_TOOLS.md` at the repo root.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
