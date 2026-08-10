# Kitchen Agent — Cook with Freebuff

Voice-first / screen-light intelligent cooking companion.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript |
| Auth / Data | Firebase Auth + Firestore (owner-scoped rules) |
| Admin | firebase-admin (server-only, service-account) |
| AI | Provider boundary (Gemini ready, swappable) |
| Validation | Zod (runtime input/output validation) |
| Tests | Vitest |
| Hosting | Vercel (or Cloud Run — Firebase Admin compatible) |

## Architecture

```
USER
 │
 │ Voice / Touch
 ▼
MOBILE-FIRST PWA (Next.js)
 │
 │ Server Actions / API Routes
 ▼
SECURE APPLICATION API
 │
 ├──── Recipe Generation Engine   (K4)
 ├──── Recipe Validation Engine   (K4)
 ├──── Cooking Session Engine     (K2)
 ├──── Timer Engine               (K2)
 ├──── Substitution Engine        (K7)
 └──── Pantry Engine              (K8)
 │
 ▼
FIRESTORE
 ├──── users
 ├──── dietary_profiles
 ├──── recipes
 ├──── cooking_sessions
 ├──── cooking_session_events
 ├──── timers
 ├──── pantry_items
 └──── agent_tool_logs
```

## Domain model

All data is structured as typed objects (no prose-only storage). The core domains are:

- **Recipe** — structured ingredients, prep steps, cooking steps, equipment, dietary tags, allergens, safety notes
- **Cooking Session** — persistent state machine with 17 phases, allowed transitions, resumable state, optimistic concurrency
- **Cooking Event** — event-sourced audit trail for every state transition
- **Timer** — backend-tracked timers (never conversation-only)
- **Pantry Item** — persistent ingredient inventory with confidence tracking
- **Dietary Profile** — long-term preferences, allergies, dislikes
- **Agent Tool Log** — observability for every AI tool call

## Verification gates (coming in CI)

The app will follow the same contract-locked verification discipline as Freebuff's portfolio app:

1. TypeScript strict mode
2. Full test suite (unit + integration)
3. Production build
4. Zod input validation (every API route + tool)
5. Firestore rules isolation
6. Lints + dead-word sweeps

## K1 — Foundation complete

- [x] Next.js 15 + TypeScript scaffold
- [x] Domain types (Recipe, Ingredient, PrepStep, CookingStep, Session, Event, Timer, Pantry, Profile, ToolLog)
- [x] Zod schemas for runtime validation
- [x] Cooking-session state machine (17 phases, 30+ transitions, pause/resume/substitution/error recovery)
- [x] Firebase client + Admin initialization
- [x] Repository abstractions (typed CRUD, optimistic concurrency, owner-scoped)
- [x] AI provider boundary (swappable RecipeGenerator/Validator/Substitution/Conversation)
- [x] Firestore security rules (owner-scoped)
- [x] Firestore composite indexes
- [x] 30 state-machine unit tests
- [x] Production build passes

## K2 — Persistent cooking session service

- [x] Operational `SessionService` with `createSession`, `transitionTo`, `pauseSession`, `resumeSession`, `handleError`, `recoverFromError`, `completeCurrentStep`, `repeatCurrentStep`, `previousStep`, `endSession`
- [x] Event sourcing: every transition logs a `CookingSessionEvent` with type, data, correlationId
- [x] Optimistic concurrency via version-gated updates (stale request rejection)
- [x] Idempotency via correlationId (duplicate commands are no-ops)
- [x] Error recovery: transitions to `ERROR_RECOVERY` preserving state, restores on recovery
- [x] Correction flow: `USER_CORRECTION` from guidance phases with resume
- [x] Safety warning system: `SAFETY_WARNING` with resume
- [x] Step navigation: `completeCurrentStep`, `repeatCurrentStep`, `previousStep`
- [x] `InMemorySessionStore` for deterministic testing
- [x] 37 integration tests (happy path, invalid transitions, pause/resume, substitution, timer, step nav, error recovery, double-submit, stale requests, recovery scenarios, event sourcing)
- [x] All 61 tests green + production build passes

## K3 — Secure agent tool/API layer

- [x] Tool executor (`executeTool`) — validate → authenticate → execute → persist → audit-log → structured envelope
- [x] Result envelope: `{ success, data?, error?: { code, message, recoverable } }` — never false success
- [x] `agent_tool_logs` with sanitized args (secret keys dropped), result, latency, correlationId
- [x] **Ingredient tools**: `save_available_ingredients`, `update_available_ingredients`, `confirm_available_ingredients`
- [x] **Session tools**: `start/get_cooking_session`, `get_current_step`, `complete_current_step`, `repeat_current_step`, `previous_step`, `pause/resume/end_cooking_session`
- [x] **Timer tools**: `start_timer`, `get_active_timers`, `cancel_timer`, `complete_timer` (backend `timers` state, never conversation-only)
- [x] **Recipe tools**: `generate_recipe`, `validate_recipe` (provider boundary), `resize_recipe`, `find_substitution`, `replace_ingredient`
- [x] `POST /api/tools` — Firebase ID-token auth, userId from verified token, per-tool zod validation
- [x] Object-level authorization: every session/timer read enforces `userId` ownership (FORBIDDEN)
- [x] Session ingredient collection persisted on the session (`availableIngredients`) with INGREDIENT_ADDED/REMOVED/CORRECTED events
- [x] Timers transition the state machine: COOKING_GUIDANCE → WAITING_FOR_TIMER → COOKING_GUIDANCE
- [x] 28 tool tests + 4 route tests (93 total green) + production build passes

## K4 — Recipe generation + validation engine

- [x] Deterministic validation engine (`lib/recipe/validate.ts`) — all 10 checks: schema validity, ingredient consistency, quantity consistency, resource validation, dietary constraints, logical order, actionability, timing plausibility, safety, one-action suitability
- [x] Controlled pipeline (`lib/recipe/pipeline.ts`) — USER INPUT → GENERATE → VALIDATE → CORRECT/CLARIFY → RECIPE READY, driving the session state machine (GENERATING_RECIPE → VALIDATING_RECIPE → RECIPE_READY / COLLECTING_REQUIREMENTS)
- [x] Concrete Gemini providers (`lib/ai/gemini.ts`) — structured JSON output, zod-validated before entering the system; registered via `lib/ai/register.ts` when `GOOGLE_AI_API_KEY` is set
- [x] `validate_recipe` tool now runs the deterministic engine always, merging AI semantic findings when configured
- [x] Missing-confirmation flow: never silently assumes the user has an ingredient/equipment
- [x] Dietary + allergen constraints block incompatible recipes (vegetarian + chicken = error)
- [x] One-action-suitability heuristic: verb-counting catches multi-action steps, tolerates "add salt and pepper"
- [x] 30 new tests (21 validation + 9 pipeline) — 123 total green + production build passes

## K5 — Realtime voice agent + conversational orchestration

- [x] Voice-status state machine (`lib/agent/voice-status.ts`) — LISTENING / THINKING / SPEAKING / OFFLINE / ERROR with pure transition rules
- [x] Deterministic command router (`lib/agent/commands.ts`) — done/next, repeat, previous, pause, resume, stop, timer, temperature, substitute (follow-up), confirm, help
- [x] Ingredient brain-dump extraction (`lib/agent/extract.ts`) — structured quantities, unknown quantities stay `null`, extraction only fires on real brain-dumps (possession lead-in or quantity signal, so "hello" or "go ahead and start cooking" never become fake ingredients)
- [x] `ConversationOrchestrator` (`lib/agent/orchestrator.ts`) — commands → extraction → provider fallback, always concise spoken responses, never claims success the backend didn't confirm
- [x] Gemini conversation provider (`lib/ai/conversation.ts`) — function calling over the full 20-tool surface, tool calls executed by the backend executor
- [x] Realtime voice provider boundary (`lib/voice/`) — Gemini Live WebRTC skeleton (`gemini-live.ts`) behind a swappable interface
- [x] `POST /api/agent` route — Firebase-auth-gated, routes through the orchestrator
- [x] Voice UI: `VoiceIndicator` component + `useVoiceSession` hook wired into the landing page
- [x] 46 new tests (commands, extraction + gate, voice status, orchestrator, route) — 169 total green + production build passes

## K6 — "Cook With Me" guided cooking

- [x] `GuidedCookingService` (`lib/server/guide-service.ts`) — one-action-at-a-time delivery; never reads a whole procedure
- [x] Two user modes: Quick Recipe (generate + display) and Cook With Me (persistent guided cooking)
- [x] Step retrieval via `get_current_step` — the recipe store, never conversation memory
- [x] Step completion via `complete_current_step` — advances only on backend success
- [x] Auto phase transitions: every prep step completed → `PREP_GUIDANCE → COOKING_GUIDANCE`; cooking exhausted → `PLATING → COMPLETED`
- [x] Timer auto-start: a cooking step with `timerSeconds` starts a backend timer and enters `WAITING_FOR_TIMER` — announced only after backend success; multi-timer safe
- [x] Timer completion surfacing: `check_timers` alerts ("Your four-minute timer is finished.") and recovers the session to the exact step
- [x] Safety confirmation gate: a step carrying a `safetyNote` (prep or cooking) is NOT completed on "done" — the session enters `SAFETY_WARNING` with the note surfaced and progress preserved; the step completes only after the cook acknowledges the gate (a second "done"). The gate is durable (survives refresh) and surfaced by the API, the tools, and the voice agent
- [x] Navigation: `previous_step` (clamped at 0), `repeat_current_step` (no progress change), `pause` / `resume` (exact-step restore)
- [x] New tools: `cook_with_me`, `check_timers`; `complete/repeat/previous/get_current_step` now return the guided snapshot
- [x] New `POST /api/cook` route (auth-gated) — launch / status / done / repeat / back / pause / resume / timers
- [x] Cooking UI at `/cook` — one large instruction, phase chip, step count, live timer countdown, big Previous/Repeat/Done controls, voice input, expandable Ingredients + Full recipe (secondary); large type, strong contrast, 44px+ targets
- [x] "start cooking" / "let's cook" / "cook with me" route to the `cook_with_me` tool in the conversational agent
- [x] 40 new tests (guide service, guide tools, cook route, CookScreen render) — 209 total green + production build passes

## K7 — Substitutions, corrections & error recovery

### Part A — Ingredient substitution
- [x] `requestSubstitution` — preserves the exact session location, transitions to `SUBSTITUTION_REQUIRED`, returns honest candidates (never invented)
- [x] Deterministic substitution engine (`lib/recipe/substitute.ts`) — curated culinary map, pantry-first ranking, excludes recipe ingredients, capped at 3
- [x] `applySubstitution` — replace throughout the recipe → persist → revalidate → log `SUBSTITUTION_APPLIED` → resume the EXACT step; never silent (requires the pending state)
- [x] "use X" confirmation flow — the pending ingredient is persisted on the session
- [x] New tools: `request_substitution`, `apply_substitution`; orchestrator parses "I don't have garlic" → ingredient, "use garlic powder" → confirmation

### Part B — User correction
- [x] `correctAvailableIngredients` — persists the correction (`USER_CORRECTION`), decides revalidation: recipe still viable → resume exact step; broken → regenerate from requirements
- [x] `correct_ingredient` tool + orchestrator `CORRECT` intent ("No, I said two tomatoes" → `{ name, quantity }`)
- [x] Guided launch seeds the availability list from the validated recipe so corrections stay viable

### Part C — Generalized error recovery
- [x] `RecoveryContext` persisted on the session (errorCode, previousState, currentStepIndex, failedTool, retryCount, recoverable)
- [x] `recoverAfterError` classification: transient → bounded `RETRY` (max 2, retry budget carries across failures); user-correctable → one `QUESTION`; version conflict → `RELOAD` canonical state; non-recoverable → `FATAL` (session preserved)
- [x] Recovery invariants proven by tests: never skips/duplicates a step, never duplicates timers, never alters the recipe, never loses progress
- [x] New tools: `correct_ingredient`, `recover_session`; `/api/cook` actions: substitute / apply_substitution / correct / recover / clear_recovery
- [x] 36 new tests (substitute engine, K7 guide flows + invariants, tools, route, commands) — 245 total green + production build passes

## K8 — User memory, dietary profile & pantry intelligence

### Dietary profile (long-term preferences)
- [x] `DietaryProfile` persisted per user (`allergies`, `dietaryRestrictions`, `dislikedIngredients`, `preferredCuisines`, `defaultServings`, `preferredEquipment`)
- [x] `get_dietary_profile` / `update_dietary_profile` tools — inspect and change remembered information; arrays replace whole lists
- [x] Explicit allergies/safety constraints take priority (single source of truth for generation/validation to consult)

### Pantry model & confidence
- [x] `pantry_items` with quantity/unit, `confidence` (0..1), `source` (VOICE/MANUAL/RECIPE_USAGE, BARCODE/VISION reserved), `lastConfirmedAt`, optional expiration/notes
- [x] Honest staleness: entries older than 30 days are flagged `stale` and never silently trusted ("You had garlic last time — do you still have some?")
- [x] Explicit confirmation (`confirm_pantry_item`) raises confidence to 1 and refreshes the date

### Pantry conversational tools
- [x] `get_pantry`, `add_pantry_item`, `update_pantry_item`, `remove_pantry_item`, `confirm_pantry_item` + `confirm_pending_pantry_items`
- [x] "I always have olive oil, salt and black pepper" → parsed names added to the pantry, listed as **pending on the session**, and confirmed on "yes" (persistence after confirmation)
- [x] Orchestrator intents: `PANTRY_ADD` ("I always have…", "add X to my pantry"), `PANTRY_GET` ("what's in my pantry", "do I have X"), `PANTRY_REMOVE` ("remove X from my pantry")
- [x] `CONFIRM` fallback chain: pending pantry items → collected ingredients → advance the step
- [x] Gemini tool declarations extended with all 8 pantry/profile tools (`nullable: true` schema rule kept — no union types)

### Recipe consumption
- [x] `consumeForRecipe` on guided completion — adjusts ONLY high-confidence, quantity-known matches; uncertain quantities are never reduced automatically
- [x] Wired into `GuidedCookingService` (optional `PantryService`, best-effort, non-fatal) and every tool-route construction via `createGuideService`
- [x] Session events logged: `INGREDIENT_ADDED` / `INGREDIENT_REMOVED` / `INGREDIENT_CORRECTED` / `PANTRY_ITEM_CONFIRMED`
- [x] 30 new tests (pantry service, pantry tools, commands, orchestrator flows, guide-service consumption, Gemini declarations) — 284 total green + production build passes

## Development

```bash
# Install
npm install

# Copy env template and fill in your Firebase project values
cp .env.example .env.local

# Run dev server
npm run dev

# Typecheck
npm run typecheck

# Test
npm test

# Production build
npm run build
```

## Project principles

1. The backend is the source of truth — LLM conversation history is never authoritative.
2. Tools perform actions; the AI agent chooses tools, the backend executes them.
3. No false success — the agent may only announce confirmed operations.
4. Structured data over prose.
5. Generation is separate from validation.
6. One action at a time during cooking.
7. Interruptions are first-class behavior.
8. Voice-first does not mean voice-only.
9. Recovery is designed, not improvised.
10. Build the core before advanced intelligence.