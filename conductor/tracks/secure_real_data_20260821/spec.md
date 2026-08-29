# Spec: secure_real_data_20260821

## Goal

Make Cook With Freebuff's existing production persistence fail closed at every
write and quota boundary while preserving current user data and the shared
Firebase ruleset.

## Acceptance Criteria

- [ ] Every Cook With Freebuff repository write validates the complete stored
  shape before Firestore mutation, including writes currently expressed as
  partial updates.
- [ ] Update paths reject attempts to change immutable document identity,
  authenticated ownership, creation timestamps, or other explicitly immutable
  fields.
- [ ] Invalid write payloads fail before any Firestore call and return/log the
  existing structured error shape where the caller exposes one.
- [ ] Firestore emulator tests cover every Cook With Freebuff collection for
  owner success, unauthenticated denial, cross-user denial, ownership mutation,
  and collection-specific create/update/delete permissions.
- [ ] Cook With Freebuff rules are tightened without changing the non-Cook
  sections of the union ruleset.
- [ ] Quota-bearing production routes reject missing, malformed, wrong-app, and
  replayed App Check tokens after enforcement is enabled.
- [ ] Emulator and documented local-development flows remain usable without
  production attestation.
- [ ] Deployment configuration and CI require App Check enforcement, and the
  live verifier proves both rejection of an unattested request and success of an
  attested authenticated flow.
- [ ] Existing production documents remain readable; no destructive migration
  or automatic rewrite is required.
- [ ] `npm run check` and the relevant emulator, contract, and live-verification
  gates pass.

## Functional Requirements

### FR1 — Schema-validated writes

1. Inventory every exported repository function that creates, overwrites,
   transactionally updates, or partially updates a Cook With Freebuff document.
2. Validate creates and overwrites with the collection's canonical Zod schema.
3. For patches, merge the stored document and proposed patch inside the trusted
   boundary, enforce immutable fields, then validate the resulting full shape
   before committing.
4. Preserve optimistic concurrency, correlation-marker atomicity, and current
   service error behavior.

### FR2 — Owner-isolated Firestore rules

1. Rules must require authentication for all Cook With Freebuff collections.
2. Creates must stamp `request.auth.uid` as the owner where `userId` is stored.
3. Updates must preserve the existing owner and reject ownership transfer.
4. Reads, deletes, append-only collections, and server-managed operations keep
   their documented collection-specific permissions.
5. The portfolio/shared portion of the union file remains byte-for-byte
   unchanged by this track; synchronizing a sibling repository is a release
   prerequisite, not an additional active product scope.

### FR3 — Enforced App Check

1. Keep App Check ahead of model or quota work on every quota-bearing route.
2. Enforced production mode rejects missing and invalid tokens consistently.
3. Replay protection remains enabled for single-use token-minting paths.
4. Production deployment fails readiness checks when required App Check
   configuration is absent.
5. The live gate runs in enforcement-required mode and proves both negative and
   positive paths.

### FR4 — Rollout and recovery

1. Document Firebase-console/API, service-account IAM, public app ID, and CI
   secret prerequisites without recording secret values.
2. Define monitor observation, enforcement activation, verification, and
   rollback steps.
3. A rollback may disable enforcement but must not weaken authentication,
   ownership, write validation, or audit logging.

## Non-Functional Requirements

- TDD is mandatory for repository, rules, route, and deployment-contract work.
- New testable logic targets at least 80% line coverage.
- No raw Firestore writes may be introduced outside documented repository or
  administrative boundaries.
- No credentials, service-account material, App Check debug tokens, or local
  environment values may be committed.
- Existing sessions, timers, recipes, pantry state, leftovers, grocery items,
  profiles, and audit data remain backward compatible.
- Contract-locked CI and probe cleanup guarantees must not be weakened.

## Out of Scope

- New authentication providers or account-management UI.
- Replacing Firebase, Firestore, Gemini, or the existing repository layer.
- Moving to a dedicated Firebase project.
- Editing another application's source code or treating it as an active product.
- UI redesign, recipe behavior changes, or new cooking features.
- Rewriting existing production documents solely to satisfy this track.
