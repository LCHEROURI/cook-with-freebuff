# Phase 3 verification — App Check enforcement rollout

Verified: 2026-08-22

## Scope lock

- Repository: `LCHEROURI/cook-with-freebuff`
- Worktree: `/Users/laredjchehrouri/Documents/freebuff meal planner/cook-with-freebuff/.freebuff/worktrees/secure-real-data-c4ce5103`
- Branch: `freebuff/cook-secure-real-data-c4ce5103`
- Application package: `cook-with-freebuff`
- No Command Center, portfolio-app-freebuff, meal-planner, or sibling
  application source was accessed or modified for this phase.

## Automated evidence

### Focused App Check surface

Command:

```text
npm test -- lib/server/app-check.test.ts lib/firebase/app-check.test.ts scripts/app-check-route-order.test.ts app/api/agent/route.test.ts app/api/cook/route.test.ts app/api/tools/route.test.ts app/api/vision/scan/route.test.ts app/api/voice/token/route.test.ts scripts/apphosting-config.test.ts scripts/ci-workflows.test.ts scripts/verify-live-emulator.test.ts scripts/app-check-rollout-docs.test.ts
```

Result: 12 files passed, 205 tests passed.

This proves the five quota-bearing routes gate before quota work, enforced
verdicts cover missing/malformed/wrong-app/replayed/valid tokens, readiness
fails closed on missing prerequisites, production App Hosting and CI require
enforcement, and the live verifier contract pairs an unattested denial with an
attested authenticated success. Voice-token and both vision probes mint fresh
tokens for their single-use gates.

### Aggregate repository gate

Command: `npm run check`

Result: exit 0.

- TypeScript: passed.
- Lint: passed with the pre-existing `app/cook/page.tsx:377` missing `voice`
  dependency warning and the existing Next.js `next lint` deprecation notice.
- Tests: 124 files passed, 1,635 tests passed.
- Production build: passed. The existing dynamic-require warning from
  `lib/server/admin.ts` remained unchanged.

### Local emulator proof

Command: `npm run verify:live:emulator`

Result: PASS against `http://localhost:3200`.

- Reused the existing Firestore (`localhost:8080`) and Auth
  (`localhost:9099`) emulators.
- Confirmed emulator App Check bypass, owner authentication, guided cooking,
  safety gate, timer start, and the deterministic pantry lifecycle.
- Confirmed probe cleanup; the reused emulators were intentionally left
  running and the temporary dev server was stopped.

## Production boundary

No deployment, Firebase-console mutation, Secret Manager mutation, or deployed
production probe was performed in Phase 3. Phase 4 must provision/confirm the
App Hosting site-key secret and IAM prerequisites, deploy the guarded revision,
and run `npm run verify:live -- --require-app-check-enforced` to capture the
real negative and positive proof.

## Phase verdict

PASS for local implementation and rollout contracts. Ready for the explicit
Phase 4 approval checkpoint; production proof remains pending by design.
