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