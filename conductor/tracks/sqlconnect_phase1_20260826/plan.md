# Plan: sqlconnect_phase1_20260826 — [ ] Pending

## Phase 1: Provision the service

- [x] Task 1.1: Run `npx -y firebase-tools@latest init dataconnect` against the project id in `.freebuff/project-id` and commit the generated `dataconnect/` scaffold and `firebase.json` updates
- [x] Task 1.2: Configure `dataconnect.yaml` (serviceId, us-central1, STRICT validation, Cloud SQL datasource) and `connector.yaml` (nodeAdminSdk to `lib/server/dataconnect`)
- [x] Task 1.3: Add the Data Connect emulator ports (9399, 9939) to the `emulators` block and confirm the existing Firestore/Auth emulators still boot
- [x] Task 1.4: Conductor - User Manual Verification 'Provision the service' (see `phase-1-verification.md`)

### Phase 1 verification

- `dataconnect/` scaffold exists and is valid per the skill's project structure.
- `firebase.json` emulators block documents ports 9399 and 9939.
- Existing emulators (auth, firestore) still start.

## Phase 2: Schema and operations

- [ ] Task 2.1: Write `schema/schema.gql` porting all 11 tables and 8 enums from the scope doc, keeping `String!` keys and `userId` indexes
- [ ] Task 2.2: Write `connector/queries.gql` and `connector/mutations.gql` per the spec (NO_ACCESS auth, upserts, the version-guarded session `@transaction`, timer-rebase `@transaction`)
- [ ] Task 2.3: Run `npx -y firebase-tools@latest dataconnect:compile` until it exits 0 with no errors
- [ ] Task 2.4: Review the generated schema in `.dataconnect/schema/main/` and reconcile any drift with the scope doc
- [ ] Task 2.5: Conductor - User Manual Verification 'Schema and operations'

### Phase 2 verification

- `dataconnect:compile` exits 0.
- Generated schema shows all 11 tables and the transaction/check wiring.
- The scope doc and the schema port agree on every table and enum.

## Phase 3: Emulator proof

- [ ] Task 3.1: Boot the Data Connect emulator (`emulators:start --only dataconnect`) with the local PostgreSQL instance accepting connections
- [ ] Task 3.2: Run the smoke: insert a `Recipe` with a JSONB `ingredients` payload, read it back by id, upsert a `DietaryProfile`, and exercise the version-guarded session update plus a marker join
- [ ] Task 3.3: Record the smoke output and any schema porting notes in `phase-3-verification.md`
- [ ] Task 3.4: Run `npm run check` to confirm no application regression, then land the track through the branch + PR path
- [ ] Task 3.5: Conductor - User Manual Verification 'Emulator proof'

### Phase 3 verification

- Emulator smoke output recorded with the recipe/dietary-profile/session results.
- `npm run check` green; no application source files changed.
- Track metadata and registry reflect completion.
