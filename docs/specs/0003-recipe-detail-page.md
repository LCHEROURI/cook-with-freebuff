# Recipe Detail Page — Design

**Date**: 2026-08-16
**Status**: Proposed (awaiting review)

## Overview

`/recipes` ("My Recipes") lists every saved recipe as a summary row — title, meta line (servings · time · ingredient count · diet · allergies), a one-tap Start button, and delete. The full generated recipe — ingredients with quantities, units, prep and optional flags, equipment, prep steps and cooking steps with timers, temperatures, heat levels and safety notes, plus top-level safety notes — is persisted and owner-scoped, but nothing renders it outside a live cooking session. A user cannot read a saved recipe; they can only launch it.

This design adds a read-only recipe detail page at `/recipes/[id]`: click a saved recipe, read the whole thing, and Start cooking from it.

## Decisions (settled in the brainstorm)

| Question | Decision |
|---|---|
| Q1 — content | Full recipe: title, servings, time, dietary tags + allergens, ingredients (quantity, unit, prep, optional flag), equipment, prep + cooking steps (instruction, estimated time, timer/temperature/heat badges, safety note), top-level safety notes |
| Q2 — interactivity | Read-only plus a Start button. No servings scaler, no check-off (recorded as follow-ups) |
| Q3 — entry point | Recipe titles in the `/recipes` list become links to `/recipes/[id]`. No other navigation changes |
| Q4 — errors/states | Mirror `/recipes` and `/kitchen`: loading, error with retry, a clear "recipe not found" for missing/not-owned recipes, and the existing signed-out redirect |
| Fetch surface | Add a `get_recipe` action to `/api/cook` (approach A, below) |

## Approaches considered

- **A. Add a `get_recipe` action to `/api/cook` (chosen).** Matches how `list_recipes` and `delete_recipe` already live there, reuses `resolveUserId` and the same dispatch, and owner-scopes through the repository. No new route topology. The `delete_recipe` case is a ready-made template for the read path.
- **B. Dedicated `app/api/recipes/[id]/route.ts`.** Cleaner REST shape, but new route topology this repo does not use for the domain.
- **C. Inline modal on `/recipes`.** No new route or URL, but no deep-linking and a bigger change to the existing page.

## Design

### 1. API: `get_recipe` action on `/api/cook`

Add one case to the existing dispatch, mirroring `delete_recipe` exactly:

- Require `recipeId` in the parsed body; missing → `400 INVALID_BODY` ("get_recipe requires a recipeId"), same shape as the other id-taking actions.
- `const recipe = await recipeStore.getRecipe(recipeId)`.
- Owner check: `if (!recipe || recipe.userId !== userId)` → `404 NOT_FOUND` ("Recipe not found"). A user can never read another user's recipe — same rule the delete path and `launchCookWithMe` already enforce ("a user must never launch (and thereby read) another user's recipe").
- Otherwise return the full recipe: `{ success: true, data: { recipe } }`, where `recipe` is the stored `Recipe` — the same Zod-validated shape persisted at creation (title, servings, totalMinutes, preferences with allergies/dietaryRestrictions, ingredients, equipment, prepSteps, cookingSteps, safetyNotes).

No new route topology, no client-side Firestore query, no change to `list_recipes` (it stays the lightweight-summary read the browser uses).

### 2. Page: `/recipes/[id]`

A client component following the exact conventions of `/recipes` and `/kitchen`:

- `useAuthSession` for auth; token + `appCheckHeaders` on the POST; reads go through `/api/cook`'s `get_recipe` — never a client-side Firestore query.
- **States** (Q4):
  - auth loading → "Loading recipe…" (the existing pattern).
  - signed out once auth settles → `router.replace('/login')` (existing pattern).
  - recipe loading → "Loading recipe…".
  - fetch error → error message + Try again button (mirrors `/recipes`' error state).
  - `404 NOT_FOUND` (missing or not owned) → a clear "Recipe not found" state with a back link to `/recipes`.
- **Layout** (Q1): a header card with the title, the meta line (servings · time · diet · allergies — reuse `RecipeRowMeta`, which the `/recipes` rows already use), and the Start button. Then, in the recipe's own order:
  - Ingredients: quantity + unit + name, with prep appended and an "(optional)" marker when flagged.
  - Equipment: the equipment list.
  - Prep steps: each with instruction, estimated time, and the ingredient/equipment context.
  - Cooking steps: each with instruction, estimated time, and badges for timer, temperature (+unit), and heat level where present, plus the step's safety note when present.
  - Top-level safety notes.
- Styling: a new `page.module.css` matching the other pages' look.
- **Start button**: posts the existing `launch` action with `recipeId`, then `router.push('/cook')` — the same handoff the `/recipes` rows use. Ownership is enforced server-side; the page only sends the id.

### 3. Entry point

In `app/recipes/page.tsx`, the row title (currently a `<p className={styles.cardName}>`) becomes a `Link` to `/recipes/[r.recipeId]`. No other navigation changes; the Start and Delete buttons keep working exactly as they do today.

### 4. Testing

- **Route test** (`app/api/cook/route.test.ts`): 400 without `recipeId`; 200 returns the full recipe for the owner; 404 `NOT_FOUND` for another user's recipe (ownership enforced, other user's recipe untouched); 404 `NOT_FOUND` for a missing recipe.
- **Page test** (`app/recipes/[id]/page.test.tsx`, jsdom): renders all sections (ingredients, equipment, prep, cooking, safety notes); Start posts `launch` and hands off to `/cook`; error state with working retry; "recipe not found" state; signed-out redirect.
- **List test** (`app/recipes/page.test.tsx`): each row title is a link to `/recipes/[id]` and the row's Start/Delete still work.
- Then the full suite + typecheck, and land through the branch + PR path under the required checks (validate, Codex gate, deploy, verify:live).

## Scope boundaries

- Read-only by design: no edit, no delete here (delete already lives in the browser), no servings scaling, no print, no share.
- The page is a reader, not a session host: starting cooking hands off to `/cook` exactly like today's rows.

## Follow-ups (recorded, not in scope)

- Servings scaler: multiply ingredient quantities and step timers for more/fewer people (pure client-side function over the recipe data; edge cases: null quantities, "to taste" lines, "1 pinch" units).
- Print view for the detail page.
- Share a recipe (read-only, non-owner visibility) — would require rethinking the ownership model, so it is deliberately out of scope here.

## Files touched

- `app/api/cook/route.ts` — add the `get_recipe` case (+ the action to the allowed-actions list).
- `app/api/cook/route.test.ts` — route tests above.
- `app/recipes/[id]/page.tsx` (new) + `page.module.css` (new) + `page.test.tsx` (new).
- `app/recipes/page.tsx` — title becomes a link; `app/recipes/page.test.tsx` — link assertion.
