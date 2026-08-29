# Dataconnect — Firebase SQL Connect data layer

The target relational backend for the migration described in
[docs/specs/0005-sql-connect-migration-scope.md](../docs/specs/0005-sql-connect-migration-scope.md).
Phase 1 provisioned it and Phase 2 ports the schema and operations. The running
app **still uses Firestore** (`lib/server/repositories.ts`); this directory is
the not yet adopted SQL Connect twin.

## Layout

- `dataconnect.yaml` — service `cook-with-freebuff`, `us-central1`, STRICT schema
  validation, Cloud SQL datasource (`fdcdb`, instance `cook-with-freebuff-fdc`).
- `schema/schema.gql` — the data model. Ports all 11 Firestore collections and 8
  enums from `docs/specs/0005` with `String!` primary keys preserving current ids.
  `DeployStatus` carries `weeks: [String!]` for the /status flake streak.
- `example/connector.yaml` — the server only connector; generates an `adminNodeSdk`
  into `lib/server/dataconnect` (committed; regenerate with compile after
  connector edits and commit the refreshed output).
- `example/queries.gql`, `example/mutations.gql` — the read set and writes.

## Conventions

- Every operation is `@auth(level: NO_ACCESS)`. The app is server only; all access
  goes through the Admin SDK behind `lib/server/repositories.ts`, and the owner
  token + App Check authorization stays at the API layer.
- Continue the Firestore on existing string ids: no id remapping during migration.
- Nested recipe/session bodies (`ingredients`, `steps`, event `data`, …) are JSONB
  threads, `Any` in GraphQL, per the scope doc; the zod schemas stay the shape
  boundary. Normalized child tables are deferred until a relational query needs them.
- Numeric scalar mapping follows the zod schemas: `quantity` and `confidence` are
  `Float` (fractional capable), `servings` is `Int` (integer constrained).
- The session optimistic concurrency guard ports to two `@transaction` mutations, picked
  by the optional marker parameter: `UpdateSession` (no marker) and `UpdateSessionWithMarker`
  (session update + correlation marker upsert/clear in one transaction). SQL Connect
  transaction steps are unconditional, so a null marker aborts the whole transaction;
  the empty-string clear key keeps the clear step a no-op. Both filter on `_and: [id, version]`
  and carry a `@check("this != null")` conflict message; the repository twin
  (`lib/server/sqlconnect-stores.ts`) maps that failure to the existing
  version-conflict error the session service wraps in `VersionConflictError`.
- The timer rebase on resume is an atomic Native SQL `_execute` (`ends_at = ends_at +
  (offset_ms * interval '1 millisecond')`), not a GraphQL filtered update: the per-row
  shift needs `Timestamp_Duration`, which SQL Connect forbids as a variable. The emulator's
  PGLite cannot run parameterized native DML, so this is proven only by compile, not in the
  emulator (running app still uses Firestore).

## Local checks

- Compile (no app change): `cd dataconnect && npx -y firebase-tools dataconnect:compile`
  must exit 0. It also regenerates `lib/server/dataconnect` and runs
  `npm install file:...`, which touches `package.json`; revert that unless the SDK
  is adopted for real.
- The Data Connect emulator runs on ports 9399 (SQL Connect) and 9939 (PostgreSQL)
  per `firebase.json`.

_Drafted by /sync from the introducing change, worth a quick human pass._