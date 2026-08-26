# SQL Connect Phase 1 — Provision and Validate

- App: `cook-with-freebuff`
- Track ID: `sqlconnect_phase1_20260826`
- Type: feature
- Status: in progress
- [Specification](spec.md)
- [Implementation plan](plan.md)
- [Metadata](metadata.json)

This track provisions Firebase SQL Connect in the existing Firebase project
and proves the relational schema from
[docs/specs/0005-sql-connect-migration-scope.md](../../docs/specs/0005-sql-connect-migration-scope.md)
compiles and runs in the emulator. It changes no application code: the app
continues to use Firestore through `lib/server/repositories.ts` untouched.
