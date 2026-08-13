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
| Hosting | Vercel + Firebase App Hosting (Cloud Run, SSR) |

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

## Verification gates (live in CI)

Every push to `main` runs the same contract-locked discipline as Freebuff's portfolio app:

1. **TypeScript strict mode** — `npm run typecheck`
2. **Full test suite** — `npm test` (284 tests, unit + integration)
3. **ESLint** — `npm run lint` (configured for CI, `root: true`)
4. **Production build** — `npm run build`
5. **Live E2E after every deploy** — `verify-deployed` job runs `npm run verify:live`
   against the deployed app: seed owner recipe → guided flow → safety gate →
   timer auto-start → pantry add + confirm → Gemini turn → cleanup
6. **Secret-gated loud guards** — a missing secret on a main push fails the
   run with a targeted message instead of silently skipping

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full operational story.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture (Mermaid)
- [`DATA_MODEL.md`](./DATA_MODEL.md) — collections, shapes, ownership
- [`AGENT_TOOLS.md`](./AGENT_TOOLS.md) — the tool surface the AI can call
- [`STATE_MACHINE.md`](./STATE_MACHINE.md) — session phases + transitions
- [`VOICE_ARCHITECTURE.md`](./VOICE_ARCHITECTURE.md) — voice pipeline + provider boundary
- [`SECURITY.md`](./SECURITY.md) — isolation model, audit findings
- [`TESTING.md`](./TESTING.md) — test layout, E2E scenarios, mobile QA matrix
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — env stores, deploy flow, verify:live contract, rollback

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
- [x] Realtime voice provider boundary (`lib/voice/`) — Gemini Live WebSocket client (`gemini-live.ts`) behind a swappable interface
- [x] `POST /api/agent` route — Firebase-auth-gated, routes through the orchestrator
- [x] `POST /api/voice/token` — Firebase-auth-gated ephemeral Gemini Live token mint; the browser never sees `GOOGLE_AI_API_KEY` (single-use, 30-min session / 2-min start window)
- [x] First-party live voice on `/cook` — the mic streams straight to Gemini Live (`BidiGenerateContentConstrained` + `access_token`) when Web Audio is available: spoken replies stream back as audio + transcription, tool calls execute through the same authenticated `/api/tools` registry, and the typed input + Web Speech mic remain as fallbacks
- [x] Starter dictation mic — the recipe starter's mic is a TOOL-FREE Gemini Live session (TEXT modality, `useLiveDictation`): speaking “chicken, rice and onion — for 4, no peanuts, vegetarian” fills the prompt for review before anything is created, so the model can never act on a spoken brain-dump; the typed input stays the fallback
- [x] Shared tool surface — `lib/ai/tool-declarations.ts` (SDK-free) is the ONE source of truth for both `/api/agent` function calling and the Live session, plus the shared `LIVE_SYSTEM_INSTRUCTION` rules text
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

## K9 — Camera readiness, security, observability, QA & production release

### Part A — Camera architecture (provider interfaces)
- [x] `VisualIngredientProvider` + `BarcodeProvider` interfaces (`lib/vision/types.ts`) — recognition results are confirmed before becoming trusted pantry state
- [x] Gemini vision implementation (`lib/ai/gemini-vision.ts`) + `/api/vision/scan` route — snap a photo, identify ingredients, fill the starter

### Part B — Security review
- [x] Firestore rules default-deny with `auth.uid == userId` on every collection; union ruleset shared across both apps
- [x] Object-level authorization: every API route resolves userId from the verified Bearer token, never from the request body
- [x] Server-only secrets (Gemini key, service account) never in client bundles

### Part C — Observability
- [x] Structured JSON logging (`lib/server/logger.ts`) — one event per line, info/stdout vs warn-error/stderr split, GCP/Vercel native ingestion
- [x] Correlation IDs (`lib/server/requestContext.ts`) — AsyncLocalStorage threads one id through voice → agent → tool → DB → response; auto-generated when the client omits it
- [x] Request/response logging on `/api/cook`, `/api/agent`, `/api/tools` (latency + status + correlationId)
- [x] `agent_tool_logs` capture sanitized args + latency + result per tool call, correlationId-keyed

### Part D — Automated testing
- [x] Unit: schemas, state machine, extraction, validation, substitutions, timers
- [x] Integration: generate→validate, session lifecycle, pause→resume, substitution→resume, reconnect→recover
- [x] E2E drivers (`scripts/drive-*.mjs`): home button, starter prefs, live voice, UI skin — wired into verify:live

### Part E — Voice QA
- [x] Realtime voice client (`lib/voice/gemini-live.ts`) + dictation hook, live driver, interruption/barge-in, LISTENING/THINKING/SPEAKING indicators
- [x] Phase C continuous-voice contract locked (two input transcriptions) in CI

### Part F — PWA / mobile QA
- [x] Installable PWA (`manifest.json` + `sw.js`), standalone display, app-shell offline caching, large touch targets

### Part G — Documentation
- [x] README, ARCHITECTURE.md, DATA_MODEL.md, AGENT_TOOLS.md, STATE_MACHINE.md, VOICE_ARCHITECTURE.md, SECURITY.md, TESTING.md, DEPLOYMENT.md

### Part H — Production readiness
- [x] Build, tests, env config, Firestore indexes + rules, auth flows, secrets, reconnection, recovery, timers, validation, substitution, accessibility, logging, error handling — all verified

## K10 — Leftovers, grocery list & expiration awareness

### Leftovers tracking
- [x] `LeftoverService` over a new `leftovers` collection — every guided completion logs the finished meal (recipe title + servings) as an **ACTIVE** leftover
- [x] `get_leftovers` lists what's still in the fridge (newest first, with how long it's been stored); `log_leftover` covers manual entries (takeout, big batches); `consume_leftover` marks an entry eaten

### Grocery list generation from pantry depletion
- [x] `GroceryService` over a new `grocery_list` collection — lines carry a `source` (MANUAL / **PANTRY_DEPLETION** / **EXPIRATION**) and an OPEN/BOUGHT status
- [x] A guided completion that exhausts an item (its quantity ran out) **auto-adds it to the grocery list**; a merely-reduced item never does
- [x] Open lines are **deduped by normalized name** — repeating the same recipe the same day adds the line once, whatever the source
- [x] Tools: `get_grocery_list`, `add_grocery_item`, `mark_grocery_bought`, `remove_grocery_item` (all resolvable by name for voice)

### Expiration awareness
- [x] Pantry entries flag `expiresSoon` (within 2 days) / `expired` / `daysUntilExpiration` live; `update_pantry_item` records `expirationDate` (epoch ms)
- [x] Expired items are **auto-added to the grocery list** (source EXPIRATION) on completion, and pantry answers surface them ("your milk expires in 2 days — use it up")
- [x] Session events: `LEFTOVER_LOGGED` / `GROCERY_ITEM_ADDED` / `GROCERY_ITEM_REMOVED` / `GROCERY_ITEM_BOUGHT` / `PANTRY_ITEM_EXPIRED`

### Conversational surface
- [x] "what's in my fridge?" / "any leftovers?" → `get_leftovers`
- [x] "add milk to my grocery list" / "I need eggs" / "buy some bread" → `add_grocery_item` (multi-item turns split)
- [x] "what's on my grocery list?" → `get_grocery_list`; "remove X from my grocery list" → `remove_grocery_item`; "I bought X" → `mark_grocery_bought`
- [x] All 7 K10 tools declared in Gemini (nullable rule kept); Firestore rules extended (`leftovers` + `grocery_list`, owner-isolated, byte-identical union deployed to both projects)
- [x] 38 new tests (leftover service, grocery service incl. dedupe/depletion/expiry, tools, guide-completion journey, commands, orchestrator flows, declarations) — 372 total green

## My Kitchen — inspect & change remembered information

`/kitchen` (link from the home page CTA) is the screen counterpart to the
conversational agent: everything the agent remembers about the user's kitchen
is readable and editable without asking.

- **🧺 Pantry** — quantities, live expiry flags (Expired / Expiring soon),
  stale re-confirmation (`✓ Have it` raises confidence), remove, add
- **🛒 Grocery list** — open lines with their source badge (Added by you /
  Pantry ran out / Expired item), mark bought, remove, add
- **🍲 Leftovers** — what's stored and for how long, consume, log manual entries
- **🥗 Dietary profile** — edit allergies / restrictions / dislikes / cuisines /
  default servings (applied to every generated recipe)

Every read and mutation goes through `POST /api/kitchen` (Bearer-token auth,
owner-scoped services) — the page is a thin client over the same
`PantryService` / `GroceryService` / `LeftoverService` / `DietaryProfileService`
the agent uses, never direct client-side writes. K8's "allow users to inspect
and change remembered information" is now a screen, not a conversation.

## Development

```bash
# Install
npm install

# Copy env template and fill in your Firebase project values
cp .env.example .env.local

# Run dev server
npm run dev

# Local Firestore/Auth emulator — develop against a LOCAL database instead of
# production. Requires Java 21+ (the Firestore emulator is a JVM binary and
# current firebase-tools rejects older runtimes; `brew install openjdk@21` then
# `sudo ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-21.jdk`).
# The Auth emulator and Emulator UI are Node-based. Add these to .env.local first:
#   NEXT_PUBLIC_USE_FIRESTORE_EMULATOR=1
#   FIRESTORE_EMULATOR_HOST=localhost:8080
#   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
# then start the emulators (Emulator UI at http://localhost:4000):
npm run emulators
# and run the dev server in another terminal — Auth + Firestore now hit the
# local emulator instead of the production project.
#
# Dev data persists across restarts: `npm run emulators` imports the previous
# snapshot from emulator-data/ on startup and re-exports it when you stop the
# emulators with Ctrl+C (SIGINT). To snapshot mid-session without stopping,
# run `npm run emulators:export` in a second terminal. The emulator-data/
# directory is gitignored (it is local seeded state, not source).

# Typecheck
npm run typecheck

# Test
npm test

# Production build
npm run build

# MANUAL deploy to Firebase App Hosting (Cloud Run SSR) — stamps commit-sha.txt
# (read by /api/build-info) then uploads + rolls out to Cloud Run. CI now runs
# this automatically on every push to main (see "Firebase App Hosting
# auto-deploy" below); this command is the manual fallback / local deploy.
npm run deploy:apphosting

# End-to-end verification of the DEPLOYED app (seed recipe + owner token +
# guided flow + safety gate + timer + Gemini turn, with cleanup)
npm run verify:live
# → https://cook-with-freebuff.vercel.app (override: npm run verify:live -- --app URL)
# → https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app (Firebase App Hosting)

# Same check against a LOCAL dev server — boots `next dev` on port 3100,
# warms the routes, runs the full check, and tears the server down, all in
# one command (port override: VERIFY_LOCAL_PORT=3105)
npm run verify:live:local

# Same guided-flow check against the LOCAL Firestore + Auth emulators — boots
# the emulators (reusing them if already running), boots `next dev` pointed at
# them, and runs the deterministic flow (seed → launch → safety gate → timer)
# with ZERO production traffic. No .env.local, service account, or Gemini key
# required. Reuses the `--emulator` mode in scripts/verify-live.mjs, which
# skips the Gemini/Chrome/live-host stages.
npm run verify:live:emulator

# Prove the emulator stack reproduces the deployed guided flow: runs the
# deterministic flow on BOTH production (--guided-only) and the local
# emulators, then diffs the seven shared steps — the emulator side is fully
# offline (no production traffic). Fails on any step divergence.
#
# This ALSO runs automatically as a pre-deploy smoke check: on every main
# push, CI (ci.yml emulator-compare job, needs Java 21) gates the Firebase
# App Hosting deploy on it, and the local pre-push hook runs it too (skips
# with a warning when Java 21 or .env.local is missing; escape hatches:
# SKIP_VERIFY_EMULATOR_COMPARE=1 locally).
npm run verify:live:compare:emulator

# Diff the local stack against the deployed stack on the FULL lifecycle —
# runs both checks, normalizes ephemeral content (ids, timings, Gemini text),
# and fails on any status-line divergence
npm run verify:live:compare

# Live commit vs local HEAD, before any deploy — reports the commit BOTH
# Vercel and Firebase App Hosting are serving and fails unless each matches
# your local HEAD (exit 2 = the VERCEL_TOKEN is invalid/revoked)
npm run verify:deployed-hash
```

## Firebase App Hosting auto-deploy (CI)

Every push to `main` deploys the Firebase Hosting side automatically, so it
stops drifting behind Vercel (which auto-deploys on push while App Hosting
used to need a manual `npm run deploy:apphosting`). The `deploy-apphosting`
job in `.github/workflows/ci.yml` runs **after** `validate` passes (broken
code never deploys), stamps the pushed commit into `commit-sha.txt` (the
App Hosting source ZIP excludes `.git`, so `/api/build-info` can report the
exact commit), then rolls out to Cloud Run.

**Auth is a `FIREBASE_TOKEN` refresh token from `firebase login:ci` run as
the project OWNER — not the service account.** The reason is IAM, not
aesthetics: `firebase deploy --only apphosting` is the "deploy from source as
a human" path and provisions resources on first deploy — it creates a
service account and sets the project IAM policy for the App Hosting agents.
Those calls need owner-level IAM (`iam.serviceAccounts.create`,
`resourcemanager.projects.setIamPolicy`). The restricted Admin SDK service
account the verify gates use (`FIREBASE_SERVICE_ACCOUNT`, role set
`firebase.sdkAdminServiceAgent` + `firebaseauth.admin` + `iam.serviceAccountTokenCreator`)
does not have those permissions and **must never be widened to them** —
granting it `setIamPolicy` is equivalent to making it an owner, and its key
lives in a CI secret.

Set up or rotate the token:

```bash
npx -y firebase-tools@latest login:ci      # sign in as the project owner, click Allow
# paste the printed token into GitHub → Settings → Secrets and variables → Actions → FIREBASE_TOKEN
```

**Rotation.** GitHub Actions secrets cannot auto-expire, and this token is a
long-lived Google refresh token — it never expires on its own, but it DIES
the moment the owner account revokes it (signing out of Firebase sessions, a
Google password change, or a manual revocation at
https://myaccount.google.com/security). Rotate it **quarterly** as routine
hygiene, and immediately after any of those events or a suspected leak.

**A stale token never fails silently.** When the token dies, the next `main`
push leaves the `deploy-apphosting` job RED with a Firebase auth error (loud,
on the runner, not silent), while Vercel still deploys independently — so the
app stays up and only the Firebase Hosting side stops auto-syncing. Recovery
is the same two lines above: re-run `login:ci`, update the secret, then
re-run the failed job (or push again). The contract test in
`scripts/ci-workflows.test.ts` locks the loud-guard so a missing-token push
can never masquerade as a green skip.

The job is gated on `FIREBASE_TOKEN`: fork PRs and unconfigured repos skip
(never deploy), and a missing token on a canonical `main` push fails loudly
so a skipped deploy can never masquerade as a green auto-sync.

## Pre-push hook — live-vs-HEAD surfacing before production pushes

`.githooks/pre-push` runs the `verify:deployed-hash` gate on any push that
lands on `refs/heads/main` and shows the operator exactly what the push will
change relative to what Vercel is currently serving. The hook **delegates its
entire verdict to the gate driver's `--stale-guard` mode** — the same
implementation the CI validate job runs — so the local hook and CI can never
disagree about what is safe to push:

- exit 0 → PASS (live == HEAD, or a forward deploy — live is behind HEAD;
  the post-deploy gate verifies after Vercel finishes)
- exit 1 → **blocked** — live is **not** an ancestor of HEAD (rollback /
  clobber risk, pull/rebase first), or the live commit could not be
  determined at all (a push that cannot be verified must not go out
  silently)
- exit 2 → invalid/revoked token — warn and continue (a bad local token
  must not block a deploy; CI has its own token and verifies there)

Wire it in a fresh clone:

```bash
git config core.hooksPath .githooks
```

Escape hatch: `SKIP_VERIFY_DEPLOYED_HASH=1 git push ...`

### Re-proving the gate's teeth in seconds

The gate's FAIL and the hook's BLOCK paths are easy to reproduce with a
throwaway detached worktree at an older commit — the live site is always
at (or ahead of) your recent commits, so the comparison necessarily
mismatches. Each one-liner creates the worktree, runs the check, prints the
verdict, and always cleans up.

Each proof is also one npm script — no copy-paste needed (the runner
creates the worktree, copies the CURRENT hook/driver artifacts in, asserts
the expected verdict actually appeared, and always cleans up, exiting 1 if
the proof did not reproduce — so it is independent of the worktree
commit's age):

```bash
npm run verify:teeth-proofs         # ALL three teeth in one command
npm run verify:gate-stale-proof     # BOTH gate teeth in one command (FAIL + stale-guard)
npm run verify:hook-block-proof     # Hook BLOCK path    → expects ✗ BLOCKED
# granular: npm run verify:gate-fail-proof → expects RESULT: FAIL · npm run verify:stale-guard-proof → expects ✗ STALE-HEAD BLOCK
```

The one-liners below document exactly what each script runs under the hood.
The Gate FAIL and CI stale-guard one-liners run the worktree's OWN driver,
so their worktree commit must be recent enough to include the gate driver
with `--stale-guard` support (any commit at or after `067b313`; `HEAD~1`
normally is). The Hook BLOCK one-liner copies the CURRENT hook AND the
current `--stale-guard` driver (plus the base driver it composes) into the
worktree, so it is independent of the worktree commit's age.

**Gate FAIL path** (expect `RESULT: FAIL` and `gate exit=1`):

```bash
git worktree add --detach /tmp/cook-hash-proof HEAD~1 && (cd /tmp/cook-hash-proof && npm run verify:deployed-hash; echo "gate exit=$?"); git worktree remove /tmp/cook-hash-proof --force
```

**CI stale-guard mode** (expect `✗ STALE-HEAD BLOCK` and `gate exit=1` —
the direction-aware verdict the CI validate step runs):

```bash
git worktree add --detach /tmp/cook-stale-guard HEAD~1 && (cd /tmp/cook-stale-guard && node scripts/verify-deployed-hash-gate.mjs --stale-guard; echo "gate exit=$?"); git worktree remove /tmp/cook-stale-guard --force
```

**Hook BLOCK path** (expect `✗ BLOCKED` and `hook exit=1`):

```bash
git worktree add --detach /tmp/cook-hook-block HEAD~1 && mkdir -p /tmp/cook-hook-block/.githooks && cp .githooks/pre-push /tmp/cook-hook-block/.githooks/ && cp scripts/verify-deployed-hash-gate.mjs scripts/verify-deployed-hash.mjs /tmp/cook-hook-block/scripts/ && (cd /tmp/cook-hook-block && printf 'refs/heads/main a refs/heads/main b\n' | bash .githooks/pre-push; echo "hook exit=$?"); git worktree remove /tmp/cook-hook-block --force
```

All three are read-only against git and Vercel — nothing is pushed, deployed, or
modified; only a temporary worktree is created and removed.

### PR preview gate — the post-deploy check PRs report

Branch protection on `main` requires two checks before a PR can merge:

- **`Typecheck · Lint · Test · Build`** — the CI validate job (runs on every
  PR already).
- **`Verify PR preview deploy (hash gate)`** — a job in
  `.github/workflows/verify-deployed.yml` that fires on Vercel's successful
  **Preview** deployment of the PR head and asserts the preview serves the PR
  head commit (the same `verify-deployed-hash.mjs --url … --expect …`
  assertion the production post-deploy gate runs).

It is deliberately lightweight — `VERCEL_TOKEN` only, zero Firestore traffic —
so verifying every PR costs no owner-verify write budget (that is why the
write-heavy `verify:live` stays Production-only). Fork PRs (no secrets) get a
skipped-but-green check; a missing token on the canonical repo fails loudly.

### PR-time stale-head guard — a stale PR surfaces in the checks

Beyond the push-time stale-head guard, the CI validate job also runs the same
direction-aware gate on **pull_request**, pinned to the PR head via `--head`:

```bash
node scripts/verify-deployed-hash-gate.mjs --stale-guard --head "${{ github.event.pull_request.head.sha }}"
```

This is load-bearing on PRs because the checkout is the **merge ref** — which
always contains current base main, so comparing live against the checkout HEAD
would make every stale PR pass. The rule, applied to the PR head: **FAIL iff
live is NOT an ancestor of the PR head** (the PR was cut before live's current
state — stale, update the branch); **PASS** if the PR head already contains the
entire live state (cut from current-or-newer main). A PR head is legitimately
behind *base* main (that is the push-time step's job), but a PR cut before
*live's* state surfaces here in the checks instead of only at merge time. The
gate fetches commits by sha from `origin` first (the CI checkout is shallow),
so the ancestry decision is real, never a missing-object accident.

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