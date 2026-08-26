# Spec: sqlconnect_phase1_20260826

## Goal

Provision Firebase SQL Connect in the `cook-with-freebuff` Firebase project and
prove the relational schema defined in
[docs/specs/0005-sql-connect-migration-scope.md](../../docs/specs/0005-sql-connect-migration-scope.md)
compiles and serves queries/mutations in the local emulator — with zero change
to the running application, which keeps using Firestore.

## Acceptance Criteria

- [ ] `dataconnect/` exists with `dataconnect.yaml`, `schema/schema.gql`, and
  `connector/` (`connector.yaml`, `queries.gql`, `mutations.gql`) following the
  skill's project structure.
- [ ] The schema mirrors the target schema in the scope doc: all 11 tables
  (`Recipe`, `CookingSession`, `CookingSessionEvent`, `CookingTimer`,
  `PantryItem`, `Leftover`, `GroceryItem`, `DietaryProfile`, `AgentToolLog`,
  `CorrelationMarker`, `DeployStatus`) with `String!` primary keys preserving
  current ids, plus all 8 enums copied value-for-value from
  `lib/domain/types.ts`.
- [ ] `npx -y firebase-tools@latest dataconnect:compile` exits 0 with no errors.
- [ ] The Data Connect emulator boots (`emulators:start --only dataconnect`)
  and the PostgreSQL instance accepts connections.
- [ ] A representative smoke test runs against the emulator: insert one
  `Recipe` (with a JSONB `ingredients` payload), read it back by id, and upsert
  a `DietaryProfile` — proving the JSONB columns, String keys, and upsert path
  work.
- [ ] The optimistic-concurrency session mutation from the scope doc compiles:
  a `@transaction` `session_update` filtered on `version` with a `@check`
  conflict guard, plus the correlation-marker join.
- [ ] `firebase.json` `emulators` block documents the Data Connect ports
  (9399 SQL Connect, 9939 PostgreSQL) and the existing emulators keep working.
- [ ] No application source file changes; `npm run check` stays green.
- [ ] Manual verification is recorded per phase in the track directory.

## Functional Requirements

### FR1 — Service scaffold

1. Run `npx -y firebase-tools@latest init dataconnect` against the project
   recorded in `.firebaserc` (default `portfolio-app-freebuff2`). Note that
   `.freebuff/` is gitignored, so `.freebuff/project-id` is not a valid
   fresh-checkout source.
2. Configure `dataconnect.yaml`: `serviceId`, `location: us-central1`
   (matching App Hosting), `schemaValidation: STRICT`, and the Cloud SQL
   datasource.
3. Configure `connector.yaml` with `nodeAdminSdk` generation targeted at a
   server-only directory (e.g. `lib/server/dataconnect`).

### FR2 — Schema

1. Port every table and enum from the scope doc's target schema.
2. Keep `id: String!` primary keys and `userId` indexes per the scope doc.
3. Keep nested recipe/session bodies as `Any` (JSONB) columns per the scope
   decision, with the `Ingredient`/`PrepStep`/`CookingStep` shape enforced by
   the existing zod schemas at the repository boundary (unchanged).

### FR3 — Operations

1. `queries.gql`: the read set from the scope doc (recipe by id, list by
   userId, active session, session events ordered, active timers, pantry,
   leftovers, grocery, dietary profile by userId, deploy status by slot).
2. `mutations.gql`: insert/update/delete per entity, `_upsert` for
   `DietaryProfile` and `DeployStatus`, the `@transaction` session
   version-guarded update, and the timer-rebase `@transaction`.
3. Every operation uses `@auth(level: NO_ACCESS)` (server-mediated; the app's
   owner-token + App Check auth stays at the API layer).

### FR4 — Emulator proof

1. Boot the Data Connect emulator with the seeded local database.
2. Run the smoke operations (insert recipe with JSONB, read back, upsert
   profile, exercise the version-guarded session update).
3. Record the smoke output in the phase verification note.

## Non-Functional Requirements

- No change to the running application: `lib/server/repositories.ts`,
  `stores.ts`, API routes, and the voice/session stack are untouched.
- No id remapping; existing string ids remain valid.
- The scope doc and this spec stay consistent; if the schema port surfaces a
  discrepancy, fix the port and note it in both places.
- Follow the repo's branch + PR landing path with the required checks when
  this track lands.

## Out of Scope

- Repository parity (`lib/server/sqlconnect-stores.ts`) — later phase.
- Data backfill or cutover — later phase.
- Firestore decommission — later phase.
- Realtime subscriptions, vector/full-text search, normalized child tables.
- Client SDK adoption.
