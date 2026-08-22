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
- [x] Task 2.2: Add effective-context generation idempotency with fenced leases and complete verification

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

## Phase 3: Four-Finding Remediation

- [x] Task 3.1: Derive deterministic allergy and dietary safety from ingredient evidence
- [x] Task 3.2: Revalidate the safety context at the atomic persistence boundary
- [ ] Task 3.3: Derive the model prompt and idempotency hash from one effective generation input
- [ ] Task 3.4: Supply stable per-intent idempotency keys from both Cook starters

### Task 3.1 requirements

- Add RED coverage for ingredient-derived peanut and tree-nut allergies,
  supported vegan, vegetarian, and gluten-free conflicts, safe equivalents,
  supplemental generated metadata, and agreement across persist/list/launch.
- Normalize ingredient name, preparation, and condition in one small shared
  classifier consumed by `validateRecipe`.
- Treat generated allergen metadata as supplemental evidence only.

### Task 3.2 requirements

- Add an emulator RED scenario where the profile changes during generation and
  completion writes neither a recipe nor a successful marker.
- Record a dedicated effective safety-context identity at claim time.
- At completion, read the current profile in the same Firestore transaction as
  recipe creation and marker completion; reject changes with
  `SAFETY_CONTEXT_CHANGED`.

### Task 3.3 requirements

- Add RED coverage for preparation, condition, current safety context,
  normalized equality, and owner isolation.
- Build one normalized model-visible generation input consumed by both Gemini
  prompt construction and request hashing; do not hash model-invisible ids.

### Task 3.4 requirements

- Add UI RED coverage for synchronous duplicate suppression, valid correlation
  IDs, one stable ID per attempt, fresh IDs for later attempts, and lock release
  after success or failure.
- Apply the same per-intent behavior to manual and pantry generation without
  restoring the wrapper-generated guided-cooking fallback.

### Phase 3 verification

- Ingredient evidence blocks unsafe generated and legacy recipes even when
  generated allergen metadata is missing or incorrect.
- The effective request hash covers every model-visible ingredient field and
  continues to isolate owners and current safety contexts.
- Manual and pantry Cook starters synchronously suppress rapid duplicate
  submissions and send one stable key per intentional generation attempt.
- A profile change during model work prevents recipe persistence and marker
  completion in the same Firestore transaction.
- The focused fencing test passes twenty consecutive runs, all repository gates
  pass, and the frozen Firestore rules and index checksums remain unchanged.
