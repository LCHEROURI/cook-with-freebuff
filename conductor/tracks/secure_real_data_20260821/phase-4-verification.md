# Phase 4 verification — production proof and release readiness

Verified locally: 2026-08-22

## Scope lock

- Repository: `LCHEROURI/cook-with-freebuff`
- Worktree: `/Users/laredjchehrouri/Documents/freebuff meal planner/cook-with-freebuff/.freebuff/worktrees/secure-real-data-c4ce5103`
- Branch: `freebuff/cook-secure-real-data-c4ce5103`
- Application package: `cook-with-freebuff`
- Command Center, portfolio-app-freebuff, meal-planner, and sibling
  applications remain excluded.

## Authenticated real-data smoke contract

Command contract: `npm run verify:real-data`

The production-only probe is explicit opt-in, rejects emulator configuration
and any Firebase project other than the shared `portfolio-app-freebuff2`
project, and never prints credentials or tokens. It creates two unique,
temporary authenticated identities and uses the Firebase client SDK to prove:

- owner create, read, update, and delete on one isolated `pantry_items`
  document;
- second-user read, update, and delete all fail with `permission-denied`;
- owner deletion is read back as absent; and
- an Admin-SDK `finally` backstop removes the document and both temporary Auth
  users after success, failure, SIGINT, or SIGTERM.

Focused contract command:

```text
npx vitest run scripts/verify-real-data.test.ts
```

Result: 1 file passed, 5 tests passed. `node --check
scripts/verify-real-data.mjs` also passed. The production command itself remains
pending for Task 4.3; Task 4.1 made no production writes.

## Full local quality gates

### Aggregate repository gate

Command: `npm run check`

Result: exit 0.

- TypeScript: passed.
- Lint: passed with the existing `app/cook/page.tsx:377` missing `voice`
  dependency warning and Next.js `next lint` deprecation notice.
- Tests: 125 files passed, 1,640 tests passed.
- Production build: passed with the existing dynamic dependency warning from
  `lib/server/admin.ts`.

The first attempt found duplicate ignored declarations in stale `.next`
output. The cache was moved aside, Next regenerated it, and the complete gate
then passed. No tracked file changed during that remediation.

### Firestore authorization emulator gate

Command: `npm run test:rules`

Result: 2 files passed, 29 tests passed. Owner, second-user, anonymous,
ownership-transfer, append-only, and server-managed collection policies are
green against the running Firestore emulator.

### Persistence emulator gate

Command: `npm run test:emulator`

Result: 3 files passed, 5 tests passed. Rollback/resume atomicity, paginated
correlation-marker cleanup, and the rules harness are green.

## Production preflight and external prerequisite blocker

Task 4.3 performed a read-only deployment-identity check and a non-mutating,
unattested request on 2026-08-22. No credential values were printed.

- Guarded worktree commit: `f446598edf89caa2ef5d61b75455fbe53377768d`.
- Live `/api/build-info` commit:
  `7e5bd6a02d19d9b4497e4d4ce9c134581c7a2de4`, built at
  `2026-08-21T23:00:59.519Z`.
- Required API key, project ID, app ID, service account, and owner UID are
  present in the imported worktree environment; the App Check site key is not
  available to this runner.
- An unattested `POST /api/agent` returned HTTP 401 `UNAUTHENTICATED`, not the
  required HTTP 403 `APP_CHECK_FAILED`. The stale deployment therefore does
  not provide the enforcement-required negative proof.

The guarded revision must be deployed with the
`NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` App Hosting secret available and
`APP_CHECK_ENFORCED=1`, then `/api/build-info` must report that revision before
running:

```text
npm run verify:live -- --require-app-check-enforced
npm run verify:real-data
```

Those write-capable probes were not run against the known-stale deployment:
their temporary production writes could not produce valid release evidence.
This is the precise external prerequisite blocker allowed by Task 4.3.
Subsequent tasks completed the operational documentation and release checklist;
their unchecked production prerequisites remain blocking.

## Manual verification checkpoint

Accepted by the user on 2026-08-22 with the production-release blocker above
retained. Acceptance covers the completed local implementation, tests,
documentation, cleanup safeguards, and scope lock; it does not certify the
stale live deployment or waive any unchecked item in
`release-readiness-checklist.md`.

## Final finished-tree verification

Command: `npm run check`

Result: exit 0 after all 25 track tasks and the manual checkpoint were
complete.

- TypeScript: passed.
- Lint: passed with the existing `app/cook/page.tsx:377` hook warning and
  Next.js `next lint` deprecation notice.
- Tests: 126 files passed, 1,645 tests passed.
- Production build: passed with the existing dynamic dependency warning from
  `lib/server/admin.ts`.

The implementation track is locally complete. Production release remains
BLOCKED exactly as recorded in `release-readiness-checklist.md`.
