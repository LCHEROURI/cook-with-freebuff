# Phase 2 Verification: Firestore authorization contract

Verified at `2026-08-21T23:39:25Z` in the scoped Cook With Freebuff worktree.

## Scope identity

- Repository: `LCHEROURI/cook-with-freebuff`
- Branch: `freebuff/cook-secure-real-data-c4ce5103`
- Package: `cook-with-freebuff`
- Phase: 2 — Firestore authorization contract

## Automated evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Cook owner/deny emulator matrix | Pass | `npm run test:rules`: 29 tests passed against the real Firestore emulator |
| Shared union scope lock | Pass | Five tests pin the non-Cook prefix and catch-all suffix and exercise mutation detection |
| Existing-data compatibility | Pass | Representative existing Cook document shapes remain owner-readable, cross-user/anonymous denied, and repository reads perform no rewrite |
| Complete local gate | Pass | `npm run check` exited 0: typecheck, lint, full Vitest suite, and production build completed |
| Production build | Pass | Next.js generated all static pages and completed route optimization |
| Diff hygiene | Pass | `git diff --check` clean; worktree clean before this report |

Lint emitted the pre-existing `react-hooks/exhaustive-deps` warning at
`app/cook/page.tsx:377` and the Next.js `next lint` deprecation notice. Neither
is introduced by this phase, and lint exited successfully.

## Authorization proof

- UID-keyed `users` and `dietary_profiles` allow only the matching authenticated
  UID.
- Recipes, sessions, timers, pantry items, leftovers, and grocery items require
  the authenticated owner on create, read, update, and delete; updates cannot
  transfer `userId`.
- Cooking-session events and agent tool logs remain owner-readable and
  append-only for clients.
- Correlation markers remain server-managed and denied to every client.
- Unauthenticated and second-user requests are denied for every Cook
  collection policy.
- The non-Cook union prefix and catch-all suffix are byte-pinned. Only the Cook
  section changed in this phase.

## Release prerequisite

The changed union ruleset must not be deployed until a separately authorized
release workflow synchronizes the exact file to the sibling rules repository
and verifies byte identity. This track did not access or modify that sibling
application.
