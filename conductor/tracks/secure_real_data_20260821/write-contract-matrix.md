# Phase 1 Write-Contract Matrix

This inventory covers every Firestore mutation exported by
`lib/server/repositories.ts`. “Immutable” means a repository update must reject
the change before it reaches Firestore. Delete authorization remains a caller
and Firestore-rules responsibility; Phase 2 proves those owner checks in the
emulator.

| Collection | Repository mutations | Canonical schema | Immutable on update | Concurrency / atomicity | Audit requirement |
| --- | --- | --- | --- | --- | --- |
| `correlation_markers` | `markCorrelationMarker`, migration write in `hasCorrelationMarker`, marker mark/clear in `updateSession`, `clearCorrelationMarker`, `deleteStaleCorrelationMarkers` | `correlationMarkerSchema` | Encoded document key represents `rawId`; cleanup only deletes markers older than the cutoff | Session marker mark/clear stays in the same transaction as the session update; legacy migration must not clobber a foreign encoded slot; sweep remains batch-bounded | Marker documents are the durable idempotency audit; no secondary event is required |
| `recipes` | `createRecipe`, `updateRecipe`, `deleteRecipe` | `recipeSchema` | `id`, `userId`, `generatedAt` | Full overwrite; owner check occurs before repository delete/update callers | Recipe generation and substitutions retain their existing tool/session logging |
| `cooking_sessions` | `createSession`, `updateSession` | `cookingSessionSchema` | `id`, `userId`, `startedAt`; `version` and `lastActivityAt` are repository-managed during update | `expectedVersion` is checked in the Firestore transaction; version increments exactly once; correlation marker operations share the transaction | State changes continue to append `cooking_session_events` through `SessionService` |
| `cooking_session_events` | `createEvent` | `cookingSessionEventSchema` | Append-only: every field is immutable after creation | Independent append after the state change (existing documented non-atomic behavior) | The document is the audit record |
| `timers` | `createTimer`, `updateTimer`, `rebaseActiveTimers` | `cookingTimerSchema` | `id`, `userId`, `sessionId`, `startedAt`, `durationSeconds` | Rebase validates every merged timer and commits all updates in one batch; ordinary update validates the merged stored document | Timer transitions continue to produce session events through the service layer |
| `pantry_items` | `createPantryItem` (full upsert), `updatePantryItem`, `deletePantryItem` | `pantryItemSchema` | `id`, `userId`, `source` | Full upserts validate the complete item; partial updates read, merge, validate, then update | Attached-session mutations keep `INGREDIENT_*` / `PANTRY_ITEM_CONFIRMED` events |
| `leftovers` | `createLeftover`, `updateLeftover` | `leftoverSchema` | `id`, `userId`, `recipeId`, `completedAt`, `storedAt` | Partial update reads, merges, validates, then updates | Creation keeps `LEFTOVER_LOGGED` when a session is attached; consume has no new audit requirement in this phase |
| `grocery_list` | `createGroceryItem`, `updateGroceryItem`, `deleteGroceryItem` | `groceryItemSchema` | `id`, `userId`, `source`, `pantryItemId`, `createdAt` | Partial update reads, merges, validates, then updates; `updatedAt` remains caller supplied and schema checked | Existing tool log is retained; no new collection-specific event is required |
| `dietary_profiles` | `upsertDietaryProfile` | `dietaryProfileSchema` | Document key and `userId` must agree; an existing profile cannot transfer ownership | Full overwrite after validating the complete profile | Existing tool log is retained |
| `agent_tool_logs` | `createToolLog` | `agentToolLogSchema` | Append-only: every field is immutable after creation | Full create only; logging remains best effort so a logging outage does not fail a tool | The document is the tool audit record |

## Contract coverage map

| Write shape | Red tests required in Task 1.2 | Implementation target |
| --- | --- | --- |
| Full create / overwrite | Invalid complete object is rejected before `.set()`; document ID must match the schema ID/owner key | Shared validated full-write helper plus collection wrapper |
| Partial update | Unknown/invalid fields, immutable changes, and an invalid merged result are rejected before `.update()` | Read-current → immutable check → merge → full-schema parse → write sanitized patch |
| Transactional session update | Immutable changes fail without transaction writes; stale version still fails; version/last-activity remain repository-managed | `updateSession` transaction |
| Atomic timer rebase | One malformed stored timer prevents every batch update; valid timers shift together | `rebaseActiveTimers` batch |
| Marker writes | Malformed markers never persist; foreign-slot and legacy behavior remain intact | Existing marker helpers and session transaction |
| Delete / cleanup | No payload schema; IDs/cutoffs/batch bounds are validated and authorization is proven in Phase 2 | Existing delete helpers and stale-marker sweep |

## Inventory findings resolved in Phase 1

- `updatePantryItem`, `updateLeftover`, and `updateGroceryItem` send raw partials
  directly to Firestore without schema parsing.
- `updateTimer` validates only the partial object, so it cannot detect an invalid
  merged document or ownership/identity changes.
- `rebaseActiveTimers` validates only `{ endsAt }`, not the complete shifted
  timer.
- Full overwrite helpers validate shape but do not centrally enforce document
  key/owner/timestamp immutability against an existing document.
- `readDoc` and query helpers cast stored data without schema validation; Phase
  1 validates before writes while preserving backward-compatible reads, as the
  track explicitly forbids a destructive migration.

The first four write-boundary findings above are resolved by Tasks 1.3–1.5 and
covered by `lib/server/repositories.test.ts`. The final read-path constraint is
intentional for this phase: existing stored shapes remain readable while every
new or changed document is validated before persistence.
