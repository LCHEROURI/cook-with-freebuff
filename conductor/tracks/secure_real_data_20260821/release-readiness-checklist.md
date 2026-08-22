# Phase 3A release-readiness checklist

Prepared: 2026-08-22

Scope: `LCHEROURI/cook-with-freebuff` only. Command Center,
portfolio-app-freebuff, meal-planner, and all sibling applications are excluded.

## Compatibility

- [x] No destructive data migration is required. The change validates future
  writes and tightens authorization without rewriting stored documents.
- [x] Existing representative document shapes pass repository and emulator
  compatibility tests.
- [x] Full-document creates and merged partial updates validate against the
  canonical schema before mutation.
- [x] Immutable IDs, ownership, source fields, creation timestamps, optimistic
  versions, and correlation-marker transaction invariants remain enforced.
- [x] Cook owner/second-user/anonymous authorization matrices pass for every
  collection; append-only and server-managed policies remain intact.
- [x] Non-Cook union-rules prefix and catch-all suffix remain byte-pinned.
- [x] Emulator development retains its explicit App Check bypass.
- [x] Local aggregate, rules, and persistence gates pass; see
  `phase-4-verification.md`.

## App Check deployment and proof

- [ ] App Hosting has a valid `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` secret.
- [ ] `NEXT_PUBLIC_FIREBASE_APP_ID` names the intended Cook web app and
  `APP_CHECK_ENFORCED=1` is present at runtime.
- [ ] Live build SHA matches the guarded revision at `/api/build-info`.
- [ ] Unattested request returns 403 `APP_CHECK_FAILED` before authentication.
- [ ] `npm run verify:live -- --require-app-check-enforced` returns
  `RESULT: PASS` with fresh single-use voice/vision tokens.
- [ ] Authenticated real-data smoke returns `RESULT: PASS`, including owner
  CRUD, cross-user denial, owner deletion verification, and cleanup of both
  temporary Auth users.

Current evidence: the live SHA is stale, the unattested request returns 401,
and the site key is unavailable to this runner. Do not run write-capable live
proofs until the first four deployment checks are satisfied.

## Shared union-rules synchronization

- [x] Cook-only rule changes and the non-Cook byte-preservation contract pass
  locally.
- [ ] A separately authorized release owner copies the complete final union
  ruleset into the sibling rules repository.
- [ ] The Cook repository and sibling rules file are verified byte-identical.
- [ ] The authorized release workflow deploys that complete union ruleset and
  its indexes together.
- [ ] The owner matrix is rerun after deployment before production acceptance.

Do not access or modify the sibling application from this track. This checklist
records a coordination prerequisite; it grants no cross-repository authority.

## Rollback

- [x] Rollback App Check with a reviewed redeploy setting
  `APP_CHECK_ENFORCED=0`; never delete the route gates to diagnose an incident.
- [x] Promote a prior App Hosting rollout or redeploy a known-good Cook commit
  if the guarded revision regresses.
- [x] Roll Firestore authorization back only with a previous complete synchronized union ruleset, never a Cook-only fragment.
- [x] Repository validation changes require no data rollback because they
  perform no migration.
- [x] After any rollback, recheck `/api/build-info`, run local gates, and repeat
  unattested plus attested production verification before restoring enforcement.

## Release decision

Release status: BLOCKED on deployment of the guarded revision, App Check secret
availability/enforcement proof, authenticated real-data proof, and separately
authorized shared-rules synchronization. Local implementation and compatibility
evidence are green; they do not override these external gates.
