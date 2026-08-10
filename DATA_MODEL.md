# Data Model

Source of truth: `lib/domain/types.ts` (types) + `lib/domain/schemas.ts`
(zod). Every write is validated against its schema. All collections are
owner-scoped under the shared-project union ruleset.

## Firestore collections

| Collection | Doc key | Owner scope |
|---|---|---|
| `users` | uid | `users/<uid>` |
| `dietary_profiles` | uid | keyed by uid |
| `recipes` | id | `userId` field |
| `cooking_sessions` | id | `userId` field |
| `cooking_session_events` | id | `userId` field (append-only audit trail) |
| `timers` | id | `userId` field |
| `pantry_items` | id | `userId` field |
| `agent_tool_logs` | id | `userId` field (sanitized args only) |

## Core shapes

**Recipe** — title, servings, time estimates, `ingredients[]`
(`name`, `quantity` (null = unknown, never invented), `unit`,
`preparation`, `condition`, `optional`), `equipment[]`, `prepSteps[]`
(each with `spokenInstruction`, `estimatedSeconds`, optional `safetyNote`),
`cookingSteps[]` (same + optional `timerSeconds`, `temperature`, `heatLevel`),
`dietaryTags`, `allergens`, `safetyNotes`, `generatedAt/updatedAt`.

**CookingSession** — the durable state machine instance: `currentPhase`,
`currentPrepStepIndex`, `currentCookingStepIndex`, `previousState` /
`resumableState` (recovery targets), `activeTimerIds`,
`availableIngredients[]`, `pendingSubstitution` (K7), `pendingPantryItems[]`
(K8, awaiting "yes"), `recoveryContext` (K7 Part C), optimistic `version`
(conflicts are recoverable).

**CookingSessionEvent** — append-only audit: `type` (24 event kinds, e.g.
`STEP_COMPLETED`, `SAFETY_WARNING_TRIGGERED`, `PANTRY_ITEM_CONFIRMED`),
structured `data`, `correlationId`.

**CookingTimer** — `label`, `durationSeconds`, `startedAt/endsAt`,
`status` (RUNNING / COMPLETED / CANCELLED), `stepId`.

**PantryItem** — `name`, optional `quantity/unit`, `confidence` (0..1),
`source` (VOICE / MANUAL / RECIPE_USAGE / BARCODE / VISION / IMPORT),
`lastConfirmedAt`, optional `expirationDate/notes`. Entries older than 30 days
are flagged stale and never silently trusted.

**DietaryProfile** — `allergies[]`, `dietaryRestrictions[]`,
`dislikedIngredients[]`, `preferredCuisines[]`, `defaultServings?`,
`preferredEquipment[]`, `updatedAt`. Keyed by uid.

**AgentToolLog** — `tool`, `sanitizedArguments` (secret keys scrubbed),
`result { success, errorCode?, errorMessage? }`, `latencyMs`, `correlationId`.

## Concurrency

Sessions use optimistic concurrency: every mutation passes the expected
`version`; a mismatch throws a recoverable `VERSION_CONFLICT` (the K9 double-
"done" scenario — the second tap can never advance twice).
