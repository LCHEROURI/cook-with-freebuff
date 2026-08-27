# Firebase SQL Connect migration — Scope

**Date**: 2026-08-26
**Status**: In Progress (Phase 1 scaffold landed on main via PR #182; Phase 2 schema/operations compile green via `dataconnect:compile`; the running app still uses Firestore — no cutover yet)

## Overview

cook-with-freebuff stores every domain object in Firestore: recipes, cooking
sessions, session events, timers, pantry items, leftovers, grocery items,
dietary profiles, agent tool logs, correlation markers, and the deploy-status
doc pair behind `/status`. This document maps that model onto Firebase SQL
Connect (PostgreSQL, the renamed Data Connect), records the decisions a
migration would hinge on, and phases the work. It changes no code.

## Decisive architectural fact: the app is server-only today

Every Firestore access goes through `lib/server/repositories.ts` behind the
store interfaces in `lib/server/stores.ts` (`SessionStore`, `TimerStore`,
`RecipeStore`, `PantryStore`, `DietaryProfileStore`, `LeftoverStore`,
`GroceryStore`, `LogStore`). There is no client-side Firestore usage anywhere
in `app/` or `components/`; the browser talks only to `/api/*` routes, which
authenticate (owner token + App Check) and then drive the server repositories.

Consequences for SQL Connect:

- The migration is a **server-side repository swap**, not a client SDK
  adoption. The generated SDK is the **Node Admin SDK**
  (`adminNodeSdk` in `connector.yaml`; older docs and the SQL Connect skill
  call it `nodeAdminSdk`), not the web SDK.
- The existing store interfaces are already the seam. A
  `sqlConnectStores` implementation replacing `firestoreStores` in
  `stores.ts` leaves the agent, tool, session-service, and most API
  layers untouched. One exception: `/api/status/route.ts` and
  `scripts/record-verify-status.mjs` read the `deploy_status` docs
  directly through `getAdminDb()`, so the DeployStatus migration below
  includes re-pointing those two call sites at the store.
- Authorization stays at the API layer (existing owner-token minting, App
  Check, and session optimistic concurrency in `updateSession`). SQL Connect
  operations run with admin credentials, so `@auth(level: NO_ACCESS)` for
  every operation is the correct, honest setting — the server is the only
  principal. The Firestore rules file is the only authorization that exists
  today, and it is replaced by the repository contract, unchanged in spirit.
- The repo's zod schemas remain the validation boundary; SQL Connect schema
  types mirror them, and `dataconnect:compile` enforces the GraphQL layer.

## Current Firestore inventory (from `lib/server/repositories.ts`)

| Collection | Entity | Key | Notable immutables | Query patterns |
|---|---|---|---|---|
| `recipes` | `Recipe` | `id` (deterministic, derived from title) | id, userId, generatedAt | by id; list by userId |
| `cooking_sessions` | `CookingSession` | `id` | id, userId, startedAt, version | by id; active by userId (status in ACTIVE/PAUSED, newest lastActivityAt); events by sessionId |
| `cooking_session_events` | `CookingSessionEvent` | `id` | id, sessionId, userId, type, at | list by sessionId, ordered by at |
| `timers` | `CookingTimer` | `id` | id, userId, sessionId, startedAt, durationSeconds | RUNNING by sessionId; rebase batch on resume |
| `pantry_items` | `PantryItem` | `id` | id, userId, source | list by userId |
| `leftovers` | `Leftover` | `id` | id, userId, recipeId, completedAt, storedAt | list by userId |
| `grocery_list` | `GroceryItem` | `id` | id, userId, source, pantryItemId, createdAt | list by userId |
| `dietary_profiles` | `DietaryProfile` | `userId` | userId | get/upsert by userId |
| `agent_tool_logs` | `AgentToolLog` | `id` | id, userId, sessionId, tool, at, correlationId | append-only |
| `correlation_markers` | marker docs | base64url(id) + legacy raw id | — | idempotency: has/mark/clear, TTL sweep |
| `deploy_status` | `verify_live` + `last_external` + `flake_streak` docs (two shapes) | fixed ids | — | single-slot reads by `/status` |

Nested structures inside `Recipe` — `ingredients`, `prepSteps`,
`cookingSteps`, `equipment`, `dietaryTags`, `allergens`, `safetyNotes`,
`proteinCategories`, `preferences` — and `availableIngredients` /
`pendingPantryItems` on the session are the only object-valued fields.

## Relational schema (target)

All types get `@table` with an explicit `id: String!` primary key preserving
the current string ids (deterministic recipe ids and existing doc ids stay
valid — no id remapping during migration). `userId` is indexed everywhere;
every query filters on it.

```graphql
type Recipe @table(key: "id") @index(fields: ["userId"]) {
  id: String!
  # userId is nullable: recipeSchema declares it optional and historical
  # recipes were persisted without it (generation predates ownership).
  userId: String
  title: String!
  description: String
  servings: Int!
  estimatedPrepMinutes: Int!
  estimatedCookMinutes: Int!
  totalMinutes: Int!
  # Nested recipe body — see "JSONB vs normalized" below
  ingredients: Any!
  prepSteps: Any!
  cookingSteps: Any!
  equipment: [String!]!
  dietaryTags: [String!]!
  allergens: [String!]!
  safetyNotes: [String!]!
  proteinCategories: [String!]
  preferences: Any
  generatedAt: Timestamp!
  updatedAt: Timestamp!
}

type CookingSession @table(key: "id") @index(fields: ["userId", "status", "lastActivityAt"]) {
  id: String!
  userId: String!
  recipeId: String
  status: SessionStatus!
  currentPhase: SessionPhase!
  currentPrepStepIndex: Int!
  currentCookingStepIndex: Int!
  previousState: Any
  resumableState: Any
  activeTimerIds: [String!]!
  availableIngredients: Any!
  recoveryContext: Any
  pendingSubstitution: String
  pendingPantryItems: Any
  startedAt: Timestamp!
  lastActivityAt: Timestamp!
  pausedAt: Timestamp
  completedAt: Timestamp
  version: Int!           # optimistic-concurrency guard
}

type CookingSessionEvent @table(key: "id") @index(fields: ["sessionId", "at"]) {
  id: String!
  sessionId: String!
  userId: String!
  type: SessionEventType!
  data: Any!
  at: Timestamp!
  correlationId: String
}

type CookingTimer @table(key: "id") @index(fields: ["sessionId", "status"]) {
  id: String!
  userId: String!
  sessionId: String!
  label: String!
  durationSeconds: Int!
  startedAt: Timestamp!
  endsAt: Timestamp!
  status: TimerStatus!
  stepId: String
  completedAt: Timestamp
}

type PantryItem @table(key: "id") @index(fields: ["userId", "expirationDate"]) {
  id: String!
  userId: String!
  name: String!
  quantity: Float   # fractional-capable (zod quantity is z.number(), not int)
  unit: String
  confidence: Float!
  source: PantryItemSource!
  lastConfirmedAt: Timestamp!
  expirationDate: Timestamp
  notes: String
}

type Leftover @table(key: "id") @index(fields: ["userId", "status"]) {
  id: String!
  userId: String!
  recipeId: String
  title: String!
  servings: Int!
  completedAt: Timestamp!
  storedAt: Timestamp!
  status: LeftoverStatus!
  notes: String
}

type GroceryItem @table(key: "id") @index(fields: ["userId", "status"]) {
  id: String!
  userId: String!
  name: String!
  quantity: Float   # fractional-capable (see PantryItem)
  unit: String
  source: GroceryItemSource!
  status: GroceryItemStatus!
  pantryItemId: String
  createdAt: Timestamp!
  updatedAt: Timestamp!
}

type DietaryProfile @table(key: "userId") {
  userId: String!
  allergies: [String!]!
  dietaryRestrictions: [String!]!
  dislikedIngredients: [String!]!
  preferredCuisines: [String!]!
  defaultServings: Int
  preferredEquipment: [String!]!
  updatedAt: Timestamp!
}

type AgentToolLog @table(key: "id") @index(fields: ["userId", "at"]) {
  id: String!
  userId: String!
  sessionId: String
  tool: String!
  sanitizedArguments: Any!
  result: Any!
  latencyMs: Int!
  at: Timestamp!
  correlationId: String
}

# Idempotency markers: the base64url key is deterministic, so it becomes the
# primary key; the legacy raw-key namespace becomes a nullable unique column.
# This is cleaner than Firestore's dual-namespace dance (see repositories.ts
# hasCorrelationMarker) — the legacy drain is a simple column read.
type CorrelationMarker @table(key: "key") {
  key: String!                    # base64url(correlationId)
  rawId: String!                  # the original correlation id
  legacyRawId: String @unique     # non-null only for pre-encoding markers
  markedAt: Timestamp!
}

# Single-slot deploy status: one row per slot (verify_live, last_external,
# flake_streak). Mirrors the doc semantics of record-verify-status.mjs and the
# weekly flake-escalation step; a newer write overwrites the slot, so the
# /status page always shows the newest result. The verify_live/last_external
# rows use verdict/commitSha/reason/source; the flake_streak row (different
# shape, same collection) uses active/recurringCount/signature/ranAt/runUrl —
# nullable columns keep the single table faithful to the single collection.
type DeployStatus @table(key: "slot") {
  slot: String!                   # 'verify_live' | 'last_external' | 'flake_streak'
  verdict: String
  commitSha: String
  reason: String
  source: String
  recordedAt: Timestamp!
  active: Boolean                 # flake_streak row only
  recurringCount: Int             # flake_streak row only
  signature: String               # flake_streak row only
  runUrl: String
}

enum SessionPhase { IDLE COLLECTING_INGREDIENTS CONFIRMING_INGREDIENTS COLLECTING_REQUIREMENTS GENERATING_RECIPE VALIDATING_RECIPE RECIPE_READY PREP_GUIDANCE COOKING_GUIDANCE PLATING WAITING_FOR_TIMER PAUSED SUBSTITUTION_REQUIRED USER_CORRECTION SAFETY_WARNING COMPLETED ERROR_RECOVERY }
enum SessionStatus { ACTIVE PAUSED COMPLETED ERROR_RECOVERY ABANDONED }
enum SessionEventType { SESSION_STARTED INGREDIENT_ADDED INGREDIENT_REMOVED INGREDIENT_CORRECTED RECIPE_GENERATION_STARTED RECIPE_GENERATED RECIPE_VALIDATED RECIPE_VALIDATION_FAILED STEP_STARTED STEP_COMPLETED STEP_REPEATED STEP_REVERSED SESSION_PAUSED SESSION_RESUMED TIMER_STARTED TIMER_COMPLETED TIMER_CANCELLED SUBSTITUTION_REQUESTED SUBSTITUTION_APPLIED SAFETY_WARNING_TRIGGERED PANTRY_ITEM_CONFIRMED ERROR_OCCURRED ERROR_RECOVERED SESSION_COMPLETED LEFTOVER_LOGGED GROCERY_ITEM_ADDED GROCERY_ITEM_REMOVED GROCERY_ITEM_BOUGHT PANTRY_ITEM_EXPIRED }
enum TimerStatus { RUNNING COMPLETED CANCELLED }
enum PantryItemSource { VOICE MANUAL RECIPE_USAGE BARCODE VISION IMPORT }
enum LeftoverStatus { ACTIVE CONSUMED }
enum GroceryItemSource { MANUAL PANTRY_DEPLETION EXPIRATION }
enum GroceryItemStatus { OPEN BOUGHT DISMISSED }
```

The enums copy `lib/domain/types.ts` value-for-value. Timestamps stay `EpochMs`
on the wire (the domain type is `number`) — `Timestamp` in SQL Connect renders
as an instant; the repository layer converts, exactly as it does today.

Numeric scalar mapping follows the zod schemas in `lib/domain/schemas.ts`:
`servings` (recipe, leftover, dietary defaultServings) is integer-constrained
(`z.number().int()`), so it is `Int`; `quantity` on `pantry_items` and
`grocery_list` is not int-constrained (`z.number()`, and the agent parses
"1/2 cup" as 0.5), so it is `Float`; `confidence` (0..1) is `Float`. This was
reconciled during the Phase 2 schema port — the scope originally said `Int`
for `quantity`, which would have truncated fractional pantry/grocery amounts.

## Key decisions

### 1. JSONB vs normalized child tables for the recipe body

The app reads and writes a recipe **as a whole document** (fetch by id, save
the full object; `listRecipes` is by userId only). Nothing queries into
`ingredients` or `steps` relationally today. Two defensible shapes:

- **JSONB (`Any` columns), recommended for v1.** The repository seam keeps its
  current zod-validated whole-object semantics with zero behavioral change;
  the servings scaler, quantity formatter, and pantry matching keep operating
  on the in-memory object. This is the smallest, safest delta and matches how
  the Firestore docs are actually consumed.
- **Normalized child tables** (`recipe_ingredients`, `recipe_steps` with
  FK + ordering). Enables future relational queries ("recipes using chicken",
  "ingredients expiring across recipes") and enforces row-level shape in SQL.
  Costs a write path that must stay atomic with the recipe row (a
  `@transaction`), plus more generated SDK surface.

Recommendation: ship JSONB now, add child tables when a relational query
actually needs them. The `Ingredient`/`PrepStep`/`CookingStep` zod schemas
already guarantee shape at the boundary either way.

### 2. Preserve string ids

`id: String!` as primary key keeps deterministic recipe ids and existing doc
ids valid, so migration is a straight copy with no id mapping. The repo's
immutable-field contract (id, userId, generatedAt …) carries over unchanged:
SQL Connect has no built-in immutability, so the repository layer keeps its
`assertImmutableFields` behavior on write.

### 3. Optimistic concurrency on sessions

`updateSession` currently runs a Firestore transaction: read current, compare
`version`, write `version + 1`, and commit marker set/clear in the same
transaction. SQL Connect expresses this as a `@transaction` mutation with a
filtered update and a `@check`:

```graphql
mutation UpdateSession($id: String!, $partial: CookingSession_Update!, $expectedVersion: Int!)
  @auth(level: NO_ACCESS) @transaction {
  session_update(
    first: { where: {
      id: { eq: $id },
      version: { eq: $expectedVersion }
    }},
    data: { version_update: { inc: 1 }, ...$partial }
  ) @check(expr: "this != null", message: "Session version conflict or missing")
}
```

The marker set/clear (correlation_markers) joins the same `@transaction` via
`response` binding, preserving the PR #58 invariant (transition and marker
commit together, rollback pause and clear commit together). The version-conflict
error surfaces through the `@check` message, which the repository maps back to
the existing `Session ${id} version conflict` error the session service and its
tests already expect.

### 4. Correlation markers get simpler

The base64url key is deterministic, so it becomes the primary key; the legacy
raw-id namespace is a nullable unique column. `hasCorrelationMarker` reads
one row (key match, else legacyRawId match), `mark` upserts, `clear` deletes,
and the TTL sweep (`deleteStaleCorrelationMarkers`) is a
`deleteMany(where: { markedAt: { lt: $cutoff }})` paged by key. The dual
namespace and the foreign-occupant collision logic in `repositories.ts`
disappear — Postgres uniqueness does that work.

### 5. Deploy status stays single-slot

`deploy_status` keyed by `slot` mirrors the collection semantics exactly: the
recorder upserts `verify_live` / `last_external` and the flake-escalation step
writes `flake_streak`, newest write wins per slot, `/status` reads the slots.
The flake_streak shape (active/recurringCount/signature/ranAt/runUrl) lives in
nullable columns on the same row type. No behavioral change.

### 6. No real-time subscriptions, no vector/full-text search in v1

The app polls via its own drivers and has no Firestore `onSnapshot` usage.
SQL Connect realtime (`@refresh`) is deliberately not adopted in v1. The
pantry "flags expiring items" logic is a plain query (`expirationDate` range),
not search. If recipe full-text search is ever wanted, `@searchable` is
available later.

## Operations (connector)

- `queries.gql`: `recipe(id)`, `recipes(where: { userId: … })`,
  `cookingSession(id)`, active session
  (`cookingSessions(where: userId + status in [ACTIVE, PAUSED],
  orderBy lastActivityAt DESC, limit 1)`), `cookingSessionEvents(where:
  sessionId, orderBy at ASC)`, `cookingTimer(id)`, active timers,
  `pantryItems`, `leftovers`, `groceryItems`, `dietaryProfile(userId)`,
  `deployStatus(slot)`.
- `mutations.gql`: inserts/updates/deletes per entity (upsert for
  `dietaryProfile` and `deployStatus`), the `@transaction` session update
  above, and the timer-rebase transaction (shift all RUNNING endsAt by
  `elapsedMs` in one `@transaction`, replacing the Firestore batch).
- Every operation: `@auth(level: NO_ACCESS)` (server-mediated; see the
  architectural fact above).
- `connector.yaml`: `adminNodeSdk` (the current firebase-tools key; older
  docs call it `nodeAdminSdk`) output to `lib/server/dataconnect` (or
  `lib/dataconnect`), package `@kitchen-agent/dataconnect`.

## Phased plan

1. **Provision + validate (no app change).** `firebase init dataconnect`
   against the existing project (project id in `.freebuff/project-id`),
   schema + connectors written, `dataconnect:compile` green, emulator
   (`emulators:start --only dataconnect`) boots. Add the emulator ports to
   `firebase.json` `emulators` block. This phase alone proves the mapping.
2. **Repository parity behind the existing interfaces.**
   `lib/server/sqlconnect-stores.ts` implementing the same
   `SessionStore`/`TimerStore`/`RecipeStore`/`PantryStore`/`DietaryProfileStore`/
   `LeftoverStore`/`GroceryStore`/`LogStore` interfaces, with the
   existing repository tests (unit + `RUN_EMULATOR_TESTS=1`) re-pointed at it.
3. **Cutover per collection, read-mostly first.** Deploy status, dietary
   profiles, pantry, grocery, leftovers, recipes — then events, timers, and
   sessions last (they carry the active-state and concurrency semantics).
   Dual-write during cutover, backfill by direct copy (ids preserved), then
   flip `stores.ts` to the SQL Connect implementation.
4. **Decommission.** Remove Firestore rules/indexes, drop the Firestore
   emulator config, delete `repositories.ts` Firestore paths, and update the
   verify drivers (`scripts/drive-*.mjs`) to keep their contract tests green
   against the SQL Connect backend.
5. **/sync** to reconcile AGENTS.md (data-layer conventions) and the scope.

## Risks and watch items

- **Emulator parity.** The Data Connect emulator runs a real local Postgres;
  the repo's `RUN_EMULATOR_TESTS=1` suite must exercise the SQL Connect
  emulator the way it exercises Firestore's, or contract tests drift from
  production behavior.
- **Concurrency semantics.** The session version guard and the marker
  transaction are the two places where Firestore's transaction model is load
  bearing. They must be proven in the emulator before sessions cut over.
- **Cloud SQL cost/ops.** A Cloud SQL instance is a provisioned resource
  (vs Firestore's serverless). The project is currently free-tier Firestore;
  this is the real cost line to accept before starting.
- **verify:live.** The live verification pipeline reads/writes Firestore
  (`deploy_status`, seeded owner recipe). It must be re-pointed in the same PR
  as the cutover or `/status` and the CI gate break mid-migration.
- **No client impact.** Because all access is server-side, this migration is
  invisible to the browser — the /cook, /kitchen, and /recipes flows keep
  working against `/api/*` unchanged. That is the mitigation for most of the
  above.

## Scope boundaries

- No change to `/api/*` routes, the agent, the tool registry, session-service
  logic, or the voice stack.
- No client SDK adoption, no realtime subscriptions, no vector/search.
- No id remapping; all existing string ids preserved.
- Firestore stays until each collection has a green SQL Connect twin plus a
  backfill; nothing is deleted in phase 1–3.

## Follow-ups (recorded, not in scope)

- Normalized `recipe_ingredients` / `recipe_steps` child tables for future
  relational queries.
- `@searchable` recipe search if the recipes page ever needs full-text.
- Realtime pantry/substitution updates via `@refresh` if a live kitchen board
  is ever built.
