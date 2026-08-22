# Plan: pantry_to_plate_20260822 — [~] In Progress

## Phase 1: Pantry-to-Plate Smart Starter

- [x] Task 1.1: Define and test the trusted kitchen-context policy
- [x] Task 1.2: Finish preferred-equipment profile support
- [x] Task 1.3: Add the authenticated pantry-starter server contract
- [x] Task 1.4: Build the accessible Cook from my pantry starter
- [x] Task 1.5: Connect pantry results to existing recipe and guided-cooking flows
- [x] Task 1.6: Run full regression, security, emulator, accessibility, and build verification

### Phase 1 verification

- Focused policy, profile, route, and component tests pass.
- Ownership and App Check contracts remain explicit and green.
- Existing manual, voice, photo, recipe, and guided-cooking tests pass.
- `npm run check`, `npm run test:rules`, and `npm run test:emulator` pass.
- Acceptance criteria have automated or documented manual evidence.

## Phase 2: Review Remediation

- [x] Task 2.1: Enforce deterministic recipe safety before persistence, usable listing, and guided-cooking launch
- [ ] Task 2.2: Add effective-context generation idempotency with fenced leases and complete verification

### Phase 2 verification

- Unsafe generated or previously stored recipes cannot persist, appear in the
  normal usable list, or launch guided cooking.
- Valid, warning-only, and confirmation-required recipes preserve their
  documented behavior.
- Concurrent requests under one valid lease generate once; stale workers cannot
  complete or fail after a successor takes the lease.
- Ownership, App Check, authentication, rules, indexes, and existing cooking
  behavior remain unchanged and green.
- `git diff --check`, `npm run check`, `npm run test:rules`, and
  `npm run test:emulator` pass.
