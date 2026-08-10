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
- [x] 30-state-machine unit tests
- [x] Production build passes

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