# Phase 1 Verification: Provision the service

Status: Complete. Date: 2026-08-26.

## Task 1.1 — `firebase init dataconnect`

Ran `npx -y firebase-tools@latest init dataconnect --project portfolio-app-freebuff2 --non-interactive`
from the repo root.

Project id note: the plan referenced the id in `.freebuff/project-id`, but that
file holds a Freebuff thread UUID, not a Firebase project. The authoritative
project id is `portfolio-app-freebuff2` from `.firebaserc` (which also matches
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` in `.env.local`). Used that.

The init enabled the `firebasedataconnect.googleapis.com` and
`sqladmin.googleapis.com` APIs on the project, detected the existing Next.js
app, and wrote the scaffold:

- `dataconnect/dataconnect.yaml`
- `dataconnect/seed_data.gql`
- `dataconnect/schema/schema.gql`
- `dataconnect/example/connector.yaml`, `queries.gql`, `mutations.gql`
- `firebase.json` gained `emulators.dataconnect.dataDir` and `dataconnect.source`

Side effect cleaned up: the init also generated web + admin SDKs into `src/`
and added `file:` dependencies to `package.json`/`package-lock.json`. That
violates the track's "zero change to the running application" rule, so it was
reverted (`git checkout -- package.json package-lock.json`, removed `src/`).
SDK generation is Phase 2 work, and `connector.yaml` already points the admin
SDK at `lib/server/dataconnect`.

## Task 1.2 — service and connector configuration

`dataconnect.yaml`:

- `serviceId: "cook-with-freebuff"`
- `location: "us-central1"` (matches App Hosting)
- `schemaValidation: "STRICT"` on the Cloud SQL datasource
- datasource: `postgresql` database `fdcdb`, `cloudSql.instanceId`
  `cook-with-freebuff-fdc`

`connector.yaml` (`dataconnect/example/`):

- `connectorId: example`
- `generate.adminNodeSdk` output to `../../lib/server/dataconnect` with
  package `@cook-with-freebuff/dataconnect-admin`
- web SDK generation removed (server-only per scope doc 0005)

Naming reconciliation: the skill and scope doc call the key `nodeAdminSdk`, but
current firebase-tools (15.28.1) writes and reads `adminNodeSdk` (verified in
`init/features/dataconnect/sdk.js` and `commands/dataconnect-sdk-generate.js`).
The connector.yaml uses the tool's real key. Scope doc 0005 uses the skill's
older name; no functional impact, noted for the doc reconciliation pass.

## Task 1.3 — emulator ports

`firebase.json` `emulators.dataconnect` block now documents:

- `port: 9399` (SQL Connect emulator; the tool default, made explicit)
- `postgresPort: 9939` (local PostgreSQL; the tool default would otherwise be
  5432, which can collide with a real local Postgres)
- `dataDir: dataconnect/.dataconnect/pgliteData`

Added `.gitignore` rule `dataconnect/.dataconnect/` so generated schema and
pglite data never enter the repo.

## Task 1.4 — existing emulators still boot

A leftover emulator stack from earlier work was already running on
auth:9099, firestore:8080, ui:4000, hub:4400 (pids 13991/14079). Left it
untouched. Boot-verified the new config on remapped ports instead:

`emulators:start --only firestore,auth,ui` with a temp config (auth 9100,
firestore 8081, ui 4001) using the new firebase.json content:

- "All emulators ready" printed
- 0 errors / "could not start"
- listeners confirmed on 9100, 8081, 4001
- temp stack torn down afterward; no stray processes

`scripts/emulator-setup.test.ts` (the contract lock on the emulators block)
passes: 7/7.

## Decisions carried into Phase 2

- Schema and operations work happens under `dataconnect/schema/` and
  `dataconnect/example/`.
- The emulator smoke (Phase 3) runs with `emulators:start --only dataconnect`
  using ports 9399/9939 from firebase.json.
- First `dataconnect:compile` will generate `.dataconnect/schema/main/` under
  `dataconnect/` (gitignored; reviewed on disk per task 2.4).
