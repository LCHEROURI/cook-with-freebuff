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

## Pending production evidence

Task 4.3 must run the enforcement-required deployed verifier and the guarded
authenticated real-data smoke, or record the precise missing external
prerequisite. Documentation, compatibility/rollback release checks, and final
manual verification remain pending.
