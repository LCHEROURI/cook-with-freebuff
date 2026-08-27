# Phase 2 Verification: Schema and operations

Status: Complete. Date: 2026-08-27.

## Task 2.1 — schema.gql (11 tables, 8 enums)

Wrote `dataconnect/schema/schema.gql` porting every table and enum from the
scope doc 0005, which mirrors `lib/domain/types.ts` (the single source of
truth). Path note: the connector directory is `dataconnect/example/` (as
created by `init dataconnect` in Phase 1), not `dataconnect/connector/`; the
plan's shorthand `connector/` refers to that `example/` connector.

Tables (11): `Recipe`, `CookingSession`, `CookingSessionEvent`, `CookingTimer`,
`PantryItem`, `Leftover`, `GroceryItem`, `DietaryProfile`, `AgentToolLog`,
`CorrelationMarker`, `DeployStatus`.

Enums (8, copied value-for-value from `lib/domain/types.ts`):
`SessionPhase`, `SessionStatus`, `SessionEventType`, `TimerStatus`,
`PantryItemSource`, `LeftoverStatus`, `GroceryItemSource`,
`GroceryItemStatus`.

Key decisions:

- Every table keeps a `String!` primary key preserving current Firestore
  string ids; no id remapping (`@table(key: "id")` except
  `DietaryProfile` on `userId` and `DeployStatus` on `slot`).
- `userId` is indexed everywhere queries filter on it; `CookingSession`
  carries the composite `[userId, status, lastActivityAt]` index for the
  active-session lookup.
- `Recipe.userId` is nullable: the domain schema declares it optional and
  historical recipes predate ownership.
- Scalar mapping follows the zod schemas in `lib/domain/schemas.ts`:
  `servings` is `Int` (zod `z.number().int()`); `quantity`
  (`PantryItem`, `GroceryItem`) and `confidence` are `Float` (double
  precision) because zod does not int-constrain them; `Any` is jsonb for
  nested bodies; `Timestamp` is timestamptz (EpochMs on the wire, the
  repository converts).
- `CorrelationMarker` keeps the deterministic base64url key as primary key
  and the legacy raw-key namespace as a nullable `@unique` column.
- `DeployStatus` is single-slot per the doc semantics of
  `record-verify-status.mjs` (slot key, nullable flake columns).

## Task 2.2 — queries and mutations

Wrote `dataconnect/example/queries.gql` and
`dataconnect/example/mutations.gql`:

- Every operation is `@auth(level: NO_ACCESS)`: the app is server-only, all
  access goes through the Node Admin SDK behind `lib/server/repositories.ts`,
  and owner-token + App Check auth stays at the API layer. `userId` is passed
  as a variable, never `auth.uid_expr`.
- Queries: `GetRecipe`, `ListRecipes`, `GetCookingSession`,
  `GetActiveSession` (newest ACTIVE/PAUSED), `GetSessionEvents`,
  `GetCookingTimer`, `GetActiveTimers`, `ListPantryItems`, `ListLeftovers`,
  `ListGroceryItems`, `GetDietaryProfile`, `GetDeployStatus`,
  `GetAgentToolLog`, `GetCorrelationMarker`.
- Mutations: `InsertRecipe`/`SaveRecipe` (upsert)/`DeleteRecipe`,
  `InsertCookingSession`/`DeleteCookingSession`, `InsertSessionEvent`,
  `InsertCookingTimer`/`UpdateCookingTimer`, `UpsertPantryItem`,
  `UpsertLeftover`, `UpsertGroceryItem`, `UpsertDietaryProfile`,
  `UpsertDeployStatus`, `InsertAgentToolLog`,
  `UpsertCorrelationMarker`/`DeleteCorrelationMarker`.
- `UpdateSession` is a `@transaction` with a filtered update on `version`
  plus a `@check` conflict guard: the SQL Connect expression of the Firestore
  optimistic-concurrency update in `repositories.ts`. A stale expectedVersion
  matches no row, the `@check` fails, and the mutation aborts with the
  conflict message the session service expects.
- `RebaseTimers` is a `@transaction` shifting every RUNNING timer's `endsAt`
  by the same offset, the SQL Connect form of the Firestore rebase-on-resume
  batch.

## Task 2.3 — dataconnect:compile exits 0

`npx -y firebase-tools@latest dataconnect:compile` exits 0 with no errors.
The compile generated the admin SDK into `lib/server/dataconnect` per
`connector.yaml` (`adminNodeSdk`, package
`@cook-with-freebuff/dataconnect-admin`) and the reviewable schema under
`dataconnect/.dataconnect/schema/main/`; both are gitignored.

## Task 2.4 — generated schema review and drift reconciliation

Reviewed the generated schema and, as a stronger check, booted the Data
Connect emulator (Phase 3.1) and confirmed it created every table from the
schema: `recipe` (jsonb `ingredients`/`prep_steps`/`cooking_steps`, integer
`servings`, indexed `userId`), `dietary_profile` (integer `default_servings`,
text[] `allergies`), `correlation_marker` (unique `legacy_raw_id` index),
`deploy_status` (nullable flake columns), `pantry_item`/`grocery_item`
(double precision `quantity`), and all 8 enums.

One drift was reconciled in the scope doc: the earlier draft typed pantry and
grocery `quantity` as `Int`, but the zod schema does not int-constrain it (the
agent parses "1/2 cup" as 0.5). `docs/specs/0005` now says `Float` and the
schema carries `Float`, matching the emulator's `double precision`.

## Phase 2 verification checklist

- `dataconnect:compile` exits 0. Confirmed.
- Generated schema shows all 11 tables and the transaction/check wiring.
  Confirmed (`UpdateSession` @transaction + @check, emulator-created tables
  listed above; `RebaseTimers` was later rewritten per correction 1 below).
- The scope doc and the schema port agree on every table and enum. Confirmed
  after the Float-quantity reconciliation in 0005.

## Codex review corrections (PR #184 gate, 2026-08-27)

The Codex P1 gate reviewed the initial port and raised four findings, all
valid; each was fixed in the same PR and re-proven against the emulator:

1. P1 — RebaseTimers collapsed every RUNNING timer to one absolute `endsAt`.
   The Firestore rebase shifts each timer by the same OFFSET
   (`endsAt: current.endsAt + elapsedMs`), preserving per-timer differences.
   Rewrote as Native SQL `_execute`
   (`ends_at = ends_at + (offset_ms * interval '1 millisecond')`): the
   GraphQL layer cannot express it because `Timestamp_Duration` is
   `@fdc_forbiddenAsVariableType`. A single UPDATE is atomic, matching the
   Firestore batch.
2. P1 — the correlation marker did not ride the session-update transaction.
   SQL Connect transaction steps are unconditional (null-bound steps abort),
   so the port split into `UpdateSession` (no marker) and
   `UpdateSessionWithMarker` (session + marker write/clear, one transaction);
   the repository picks by the optional marker parameter. The empty-string
   clear key deletes no row (harmless no-op). Scope doc 0005 updated.
3. P2 — the connector lacked the per-ID reads the store contracts require
   (`getItem`/`getLeftover`/`getGroceryItem` in `lib/server/tools/types.ts`).
   Added `GetPantryItem`, `GetLeftover`, `GetGroceryItem`.
4. P2 — `DeployStatus` lacked the flake_streak `weeks` array that
   `app/api/status/route.ts` reads and `/status` renders. Added `weeks:
   [String!]` to the table and both the upsert mutation and the read query.
