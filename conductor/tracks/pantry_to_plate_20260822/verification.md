# Verification: Phase 3B Pantry-to-Plate Smart Starter

Verified on 2026-08-22 in the Cook-only worktree on branch
`freebuff/cook-next-user-phase-22c3693`.

## Acceptance evidence

- Trusted kitchen policy tests prove expired exclusion, explicit confirmation
  for stale/low-confidence inventory, expiring-soon priority, and non-removable
  stored allergies.
- Kitchen route, field UI, and page tests prove preferred equipment is
  normalized, persisted through the existing profile boundary, and safe for
  legacy profiles.
- Cook route tests prove App Check gates before auth/context work, identity is
  server-derived, pantry lookup is owner-scoped, and missing, foreign, expired,
  or unconfirmed uncertain item IDs never reach recipe generation.
- Pantry starter component tests prove trusted defaults, deliberate uncertain
  selection, text-visible expiry/confidence/freshness indicators, applied
  profile context, bounded refinements, and the empty-pantry `/kitchen` path.
- The pantry handoff regression proves the generated recipe is persisted for
  the authenticated owner and the same recipe ID can be listed, fetched, and
  launched through the existing guided-cooking flow.
- Existing recipe detail, servings scaling, read-aloud/voice UI, guided cooking,
  pantry consumption, grocery synchronization, and leftovers suites pass.
- Deterministic safety evaluation blocks unsafe generated recipes before
  persistence and blocks unsafe stored recipes from normal listing or guided
  cooking while preserving warning and confirmation behavior.
- Recipe-generation idempotency hashes the server-resolved effective request,
  including current authenticated profile constraints; completed replays are
  revalidated before use and changed requests or profiles conflict safely.
- Valid concurrent leases suppress duplicate provider calls. Stale leases may
  recompute, but both in-memory and real Firestore transaction tests prove that
  only the current unexpired fencing token can persist and complete a recipe.
- The local `/cook` route compiled and returned HTTP 200 from a clean local
  development-server smoke run. Authenticated interaction semantics are covered
  by component and route tests; no production account or data was used.

## Required commands

| Command | Result |
| --- | --- |
| `git diff --check` | Pass |
| `npm run check` | Pass: typecheck, lint (0 errors), 1,691/1,691 tests, production build with 17 routes |
| `npm run test:rules` | Pass: 30/30 tests across 2 files |
| `npm run test:emulator` | Pass: 7/7 tests across 4 files |

The lint/build output retains the pre-existing exhaustive-deps warning for the
voice effect in `app/cook/page.tsx` and the pre-existing dynamic-import warning
from `lib/server/admin.ts`. Neither warning was introduced by Phase 3B and both
commands exit successfully.

## Security and release scope

- No Firestore rules, shared indexes, Firebase configuration, or production
  configuration changed.
- `firestore.rules` SHA-256 remains
  `a008bfcf320171ddf022f92c4d57e57e62539045e8b20ed42fc736eccb1b24f4`.
- `firestore.indexes.json` SHA-256 remains
  `b07673b5cfe6389e2ccee37993767deed3f0512586b6faf66fc9dd1007937745`.
- No deploy, production mutation, PR #166 change, or sibling-repository access
  is part of this verification.

## Remaining release blockers

Implementation and repository verification are complete. A separate branch
push, pull request, CI review, merge approval, and authorized release process
remain required before production availability.
