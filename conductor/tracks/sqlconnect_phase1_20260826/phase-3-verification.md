# Phase 3 Verification: Emulator proof

Status: Complete (Tasks 3.1-3.5 done).
Date: 2026-08-27.

## Task 3.1 — emulator boot

Booted the Data Connect emulator against the ports in `firebase.json`
(SQL Connect 9399, Postgres 9939):

```
npx -y firebase-tools emulators:start --only dataconnect \
  --project demo-cook-with-freebuff
```

run from `dataconnect/` so it picks up `dataconnect.yaml` and the Phase 2
schema. Launched detached (double-fork + setsid via
`.freebuff/launch-dataconnect-emu.py`; plain nohup gets reaped on macOS and
launchctl is TCC-blocked on ~/Documents), logging to
`.freebuff/dataconnect-emu.log`. Confirmed: SQL Connect listening on
127.0.0.1:9399, local Postgres on 9939, and the emulator created every table
and enum from `schema/schema.gql` (recipe with jsonb
ingredients/prep_steps/cooking_steps and integer servings, dietary_profile
with integer default_servings and text[] allergies, correlation_marker with
the unique legacy_raw_id index, deploy_status with nullable flake columns and
the weeks array, pantry_item and grocery_item with double precision quantity,
all 8 enums).

Tooling note: the launch script pins `firebase-tools@15.28.2` because a
stale npx cache resolves bare `firebase-tools` to 15.24.0, whose emulator
binary (3.4.16) lags the registry pin (3.4.18) and fights the compile's
cache.

## Task 3.2 — the smoke

Drove the generated admin SDK (`@cook-with-freebuff/dataconnect-admin`,
generated into `lib/server/dataconnect` by `dataconnect:compile`) against the
emulator. The admin client switches to emulator mode via the standard
`DATA_CONNECT_EMULATOR_HOST` env var, with `initializeApp({ projectId })` and
no credentials (the emulator issues the `owner` token).

Runner: `.freebuff/smoke-phase3.mjs` (gitignored, like the other helpers):

```
DATA_CONNECT_EMULATOR_HOST=127.0.0.1:9399 node .freebuff/smoke-phase3.mjs
```

Result: 20/21 checks passed, 1 documented skip.

1. Recipe: `saveRecipe` (upsert) with a JSONB `ingredients` payload
   (`[{ name: 'pasta', quantity: 0.5, unit: 'cup' }]`), read back via
   `getRecipe`. JSONB round-trips exactly (0.5 survives — the Float fix) and
   `servings` comes back as Int 2.
2. DietaryProfile: `upsertDietaryProfile` then `getDietaryProfile`. text[]
   `allergies` and Int `defaultServings` (4) round-trip.
3. Version-guarded session update:
   - `insertCookingSession` with `version: 1`.
   - `updateSession({ expectedVersion: 1 })` succeeds; the session reads back
     with `version: 2` and the applied phase.
   - `updateSession({ expectedVersion: 1 })` again (stale) aborts with
     `data-connect/query-error Session version conflict or missing (aborted)
     (rolled back)`; the session still reads back at `version: 2` with the
     stale status not applied. The @check conflict guard works end to end.
4. Marker join (Codex P1, PR #58 invariant): `updateSessionWithMarker` writes
   the marker in the SAME transaction as the session update; a plain
   `updateSession` with no marker still succeeds; the rollback path clears the
   original marker and writes its own rollback marker in one transaction.
5. RebaseTimers (Codex P1): rewritten as Native SQL
   (`ends_at = ends_at + (offset_ms * interval '1 millisecond')`), which the
   GraphQL layer cannot express (`Timestamp_Duration` is forbidden as a
   variable). DOCUMENTED SKIP: the local emulator cannot execute ANY
   parameterized native-SQL DML — even a trivial
   `UPDATE cooking_timers SET label = $1 WHERE id IS NOT NULL` fails with the
   masked PGLite error `unexpected message 'E'; expected ReadyForQuery`
   (firebase-tools emulator defect; the emulator's own GraphQL-generated DML
   works fine). The rebase is verified by `dataconnect:compile` validation
   and by mirroring `repositories.rebaseActiveTimers` exactly; runtime
   execution is exercised in the parity phase against Cloud SQL.
6. Per-ID reads (Codex P2): `getPantryItem`, `getLeftover`,
   `getGroceryItem` each round-trip by id — the store contracts in
   `lib/server/tools/types.ts` (`getItem`/`getLeftover`/`getGroceryItem`).
7. DeployStatus flake_streak (Codex P2): `weeks` array round-trips
   (`['2026-08-03','2026-08-10','2026-08-17']`) alongside `active`,
   `recurringCount`, `signature` — the shape `/status` renders.

## Task 3.3 — record (this file)

Smoke output and the schema porting notes are recorded above. Porting notes
beyond the Phase 2 doc:

- The admin SDK's emulator switch is the standard `DATA_CONNECT_EMULATOR_HOST`
  env var — no code change needed to point the generated SDK at the emulator.
- SQL Connect transaction steps are unconditional: a step whose required
  variables are null (or absent) aborts the whole transaction, so optional
  marker writes cannot live in one fixed mutation — hence the two-mutation
  split documented in the scope doc and phase-2-verification.md.
- Native SQL `_execute` DML cannot be exercised in the local emulator (PGLite
  defect above); it is validated by `dataconnect:compile` and runs on Cloud
  SQL in production.

## Tasks 3.4 and 3.5 — landing and manual verification

- Task 3.4: `npm run check` green (131 files, 1725 tests) with no application
  source files changed; Phases 2-3 landed through the branch + PR path
  (schema/operations + verification docs via #184, concurrency contract test
  via #185).
- Task 3.5: Conductor user manual verification — this file records the emulator
  smoke output above (recipe insert/read, dietary-profile upsert, the
  version-guarded session update with its stale-version abort, the marker
  join, and the documented native-SQL rebase skip), the gate is green, and
  the track registry/metadata now report completion.

## Phase 3 verification checklist

- Emulator smoke output recorded with recipe/dietary-profile/session results.
  Confirmed (20/21 above, rebase documented-skip with the emulator defect
  recorded).
- `npm run check` green; no application source files changed. Confirmed
  (Task 3.4, via #184/#185).
- Track metadata and registry reflect completion. Confirmed (Tasks 3.1-3.5
  ticked, track marked done).
