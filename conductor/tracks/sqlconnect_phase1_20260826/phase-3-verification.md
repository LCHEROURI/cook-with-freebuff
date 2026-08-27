# Phase 3 Verification: Emulator proof

Status: In progress (Tasks 3.1-3.3 complete; 3.4 and 3.5 pending).
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
the unique legacy_raw_id index, deploy_status with nullable flake columns,
pantry_item and grocery_item with double precision quantity, all 8 enums).

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

Result: 12/12 checks passed.

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
4. Correlation marker: `upsertCorrelationMarker` (base64url key) then
   `getCorrelationMarker` reads it back — the idempotency-marker join path.

## Task 3.3 — record (this file)

Smoke output and the schema porting notes are recorded above. The only porting
note beyond the Phase 2 doc: the admin SDK's emulator switch is the standard
`DATA_CONNECT_EMULATOR_HOST` env var — no code change needed to point the
generated SDK at the emulator.

## Remaining (Tasks 3.4, 3.5)

- Task 3.4: `npm run check` to confirm no application regression, then land
  Phases 2-3 through the branch + PR path.
- Task 3.5: Conductor user manual verification.

## Phase 3 verification checklist

- Emulator smoke output recorded with recipe/dietary-profile/session results.
  Confirmed (12/12 above).
- `npm run check` green; no application source files changed. Pending (3.4).
- Track metadata and registry reflect completion. Partially updated (3.1-3.3
  ticked; completion follows the landing).
