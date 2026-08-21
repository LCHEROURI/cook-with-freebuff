# Plan: secure_real_data_20260821 — [~] In Progress

## Phase 1: Repository write contracts

- [x] Task 1.1: Inventory every Cook With Freebuff Firestore write and classify its schema, immutable fields, concurrency, and audit requirements
- [x] Task 1.2: Add failing repository tests proving invalid full writes and invalid partial updates are rejected before Firestore mutation
- [x] Task 1.3: Implement schema-backed full-document and patch validation for recipes, sessions, events, timers, pantry items, leftovers, grocery items, dietary profiles, tool logs, and correlation markers
- [x] Task 1.4: Enforce immutable IDs, user ownership, creation timestamps, and existing optimistic-concurrency/correlation-marker invariants
- [x] Task 1.5: Refactor shared validation helpers while keeping focused repository and service suites green
- [x] Task 1.6: Conductor - User Manual Verification 'Repository write contracts'

### Phase 1 verification

- Focused repository, service, and route tests pass.
- Typecheck and lint pass.
- A test matrix maps every write export to a canonical schema and immutable-field policy.

## Phase 2: Firestore authorization contract

- [x] Task 2.1: Add a Cook With Freebuff emulator-rules harness with deterministic owner, second-user, and unauthenticated fixtures
- [x] Task 2.2: Add failing rules tests for cross-user access, ownership transfer, and forbidden operations across every Cook With Freebuff collection
- [x] Task 2.3: Tighten only the Cook With Freebuff clauses in the union ruleset while preserving non-Cook clauses byte-for-byte
- [x] Task 2.4: Add a contract check that detects unintended edits outside the Cook With Freebuff rules section and documents the sibling-rules synchronization release prerequisite
- [x] Task 2.5: Run repository and emulator tests against representative existing document shapes to prove backward compatibility
- [x] Task 2.6: Conductor - User Manual Verification 'Firestore authorization contract'

### Phase 2 verification

- Owner allow/deny matrix passes in the Firebase emulator.
- Non-Cook union-rules sections are unchanged.
- `npm run check` passes.

## Phase 3: App Check enforcement rollout

- [ ] Task 3.1: Inventory quota-bearing routes and add contract tests proving App Check executes before model/provider work
- [ ] Task 3.2: Add failing tests for missing, malformed, wrong-app, replayed, and valid attestation in enforced production mode
- [ ] Task 3.3: Harden App Check error mapping and readiness checks without changing emulator behavior
- [ ] Task 3.4: Require enforcement in production deployment configuration and CI live verification
- [ ] Task 3.5: Update the live verifier to prove unattested rejection and attested authenticated success under the required-enforcement flag
- [ ] Task 3.6: Document prerequisites, monitor observation, activation, rollback, and failure diagnosis
- [ ] Task 3.7: Conductor - User Manual Verification 'App Check enforcement rollout'

### Phase 3 verification

- App Check unit, route, workflow, and live-verifier contract tests pass.
- Production configuration fails closed when enforcement prerequisites are absent.
- Local/emulator flows remain documented and green.

## Phase 4: Production proof and release readiness

- [ ] Task 4.1: Add an authenticated real-data smoke covering create, read, update, owner isolation, and cleanup without exposing secrets
- [ ] Task 4.2: Run the full unit, contract, emulator, typecheck, lint, and production-build gates
- [ ] Task 4.3: Run enforcement-required deployed verification and capture evidence or a precise external prerequisite blocker
- [ ] Task 4.4: Update SECURITY.md, DEPLOYMENT.md, TESTING.md, and relevant AGENTS.md contracts
- [ ] Task 4.5: Produce the final compatibility, rollback, and shared-rules synchronization checklist
- [ ] Task 4.6: Conductor - User Manual Verification 'Production proof and release readiness'

### Phase 4 verification

- All acceptance criteria have test or operational evidence.
- Existing production data requires no destructive migration.
- `npm run check`, emulator gates, and applicable live gates pass.
