# Spec: pantry_to_plate_20260822

## Goal

Let an authenticated cook create a validated, personalized recipe directly from
trusted pantry inventory and their saved dietary profile, then continue through
the existing recipe and guided-cooking experience without re-entering known
kitchen context.

## Acceptance Criteria

- [x] The pantry starter excludes expired items and does not silently select
  stale or low-confidence items.
- [x] Expiring-soon ingredients are visibly prioritized, while stale or
  low-confidence ingredients require explicit confirmation before use.
- [x] Saved allergies remain non-removable safety constraints; explicit user
  choices may refine servings, cuisine, time, craving, and selected ingredients.
- [x] Preferred equipment is editable in My Kitchen, schema validated, persisted
  through the existing profile repository, and applied to recipe generation.
- [x] Pantry item identifiers are resolved server-side for the authenticated
  owner, and foreign, missing, expired, stale, or unconfirmed uncertain items
  cannot enter the generation request.
- [x] The `/cook` starter provides a visible “Cook from my pantry” flow with
  selection, expiry/confidence indicators, applied-profile context, optional
  refinements, and an empty-pantry link to `/kitchen`.
- [x] Pantry-generated recipes use the existing validation, persistence,
  recipe-ready, saved-recipes, scaling, read-aloud, and guided-cooking flows.
- [x] Manual, voice, and photo recipe starters remain available and unchanged in
  behavior.
- [x] Existing authentication, App Check ordering/enforcement, owner isolation,
  Firestore write validation, cooking-state safety, pantry consumption, grocery
  synchronization, leftovers behavior, and accessibility contracts remain green.
- [x] Typecheck, lint, unit/contract tests, rules tests, emulator tests, and the
  production build pass.

## Functional Requirements

### FR1 — Trusted kitchen context

1. A pure, deterministic policy classifies pantry items as trusted, confirmation
   required, or ineligible.
2. Expired items are ineligible.
3. Stale or low-confidence items require explicit user confirmation.
4. Eligible expiring-soon items sort ahead of other eligible items.
5. Stored allergies are always retained; request refinements may add but never
   remove allergy constraints.

### FR2 — Preferred equipment

1. My Kitchen displays and edits preferred equipment through the existing
   dietary-profile mutation path.
2. Input is normalized and validated by the existing domain schema boundary.
3. Saved equipment is included in pantry-based generation requests.

### FR3 — Authenticated pantry-starter contract

1. The server derives identity from the verified Firebase token.
2. Requested pantry IDs resolve only through the authenticated user's pantry
   store; the client cannot supply an authoritative user ID or pantry payload.
3. Missing, foreign, expired, stale-unconfirmed, and low-confidence-unconfirmed
   IDs return a structured validation error before model work.
4. The server combines resolved pantry ingredients with the stored dietary
   profile and explicit refinements, then invokes the existing recipe generator
   and validator.
5. The quota-bearing route preserves App Check gating before auth, parsing,
   persistence, or provider work.

### FR4 — Pantry starter experience

1. `/cook` loads a read-only pantry/profile starter snapshot for the signed-in
   user.
2. The user can review and select pantry ingredients, including explicitly
   confirming stale or low-confidence items.
3. The interface exposes expiry/confidence status and the applied profile in
   accessible text, not color alone.
4. Optional cuisine, maximum-time, craving, and servings refinements are
   controlled inputs and never auto-submit from voice transcription.
5. An empty eligible pantry points to `/kitchen`; existing manual, voice, and
   photo paths remain usable.

### FR5 — Existing-flow handoff

1. A pantry-generated recipe renders in the existing recipe-ready state.
2. Recipe persistence and ownership checks use existing repositories.
3. Starting the recipe uses the existing guided-cooking state machine.
4. Saved recipe detail, servings scaling, read-aloud, pantry consumption,
   grocery synchronization, and leftovers behavior are not rebuilt.

## Non-Functional Requirements

- TDD is mandatory for every behavior change.
- Pure policy logic and route contracts must have focused unit tests, with new
  testable logic targeting at least 80% line coverage.
- Client code never imports server-only modules and never queries Firestore.
- No raw Firestore write or new client-trusted identity boundary is introduced.
- Controls retain visible focus, meaningful labels, keyboard operation, and at
  least 44px touch targets where applicable.
- No new Firestore collection, shared rules edit, shared index edit, production
  deployment, or production configuration change is part of this track.

## Out of Scope

- General meal planning, calendars, or a meal-planner product.
- Recipe-community discovery or public recipe sharing.
- Rebuilding recipe detail, guided cooking, voice, vision, pantry consumption,
  grocery synchronization, or leftovers systems.
- Merging PR #166 or changing its frozen branch.
- Firebase deployment, production mutation, or sibling-repository access.
