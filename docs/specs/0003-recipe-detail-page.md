# Recipe Detail Page — Design

**Date**: 2026-08-16
**Status**: Accepted (built, tested, and deployed via PR #114; verify:live green)

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

- Servings scaler: designed below (D1–D5). Ingredients scale; timers stay fixed.
- Print view for the detail page.
- Share a recipe (read-only, non-owner visibility) — would require rethinking the ownership model, so it is deliberately out of scope here.

## Follow-up design: Servings scaler (D1–D5)

**Core mechanic.** A pure client-side function `scaleRecipe(recipe, targetServings)` returns a display copy of the recipe with scaled ingredient quantities. The factor is `targetServings / recipe.servings`. No API change, no persistence — the scale is a reading aid on the detail page and resets when you leave. Start always launches the stored base recipe; the server-side session keeps its own quantities.

**D1 — What scales: ingredients only, timers fixed.** Ingredient quantities scale linearly with servings. But `estimatedSeconds` and `timerSeconds` stay unchanged: cooking duration does not scale with batch size (a soup for 8 does not simmer twice as long as for 4), so `totalMinutes` on the meta line keeps the stored value. Scaling timers linearly would mislead a cook — a 15 minute timer fired at 30 minutes because you doubled a recipe is a bug, not a feature.

**D2 — Which lines never scale.**
- `quantity === null` ("to taste", "a handful") → passthrough, no multiplier.
- Unit-level exemptions: `pinch`, `dash`, `to taste`, `as needed`, `handful` → passthrough regardless of quantity.
- Optional ingredients DO scale (the quantity is real when used; "optional" only means skippable).
- `temperature`, `temperatureUnit`, `heatLevel`, `safetyNote`, `spokenInstruction`, `condition`, `preparation` are never touched.
- `servings` missing or 0 on an old recipe → factor falls back to 1 (no scaling, no divide-by-zero).

**D3 — Rounding.** Scale, then round to the nearest 1/4 of the unit (½ cup × 1.5 → ¾ cup; 2 eggs × 1.5 → 3 eggs). Whole numbers stay whole; values ≥ 10 round to whole numbers. Rounding affects only the display copy — the stored value is never mutated. Fractions render as ¼/½/¾ via a small formatting helper.

**D4 — UI.** In the detail page's header card, next to the meta line: a stepper (`−` / `6 servings` / `+`), bounded 1–24, defaulting to the recipe's own servings. At the default the page renders exactly as stored (factor 1, no note). Off-default it shows the scaled quantities and one caption: "Scaled from 4 to 6 servings", with a note when any line was left unscaled ("Pinch/to-taste amounts shown as-is").

**D5 — Shape and testing.** A pure module `app/recipes/recipe-scaler.ts` (no React, node-testable), mirroring how `recipe-filter.ts` lives beside the page. Unit tests: linear multiplication, null-quantity passthrough, unit exemptions, rounding boundaries (0.25 steps, ≥10 whole), optional ingredients scale, factor fallback on missing servings, zero/negative target guard, timers untouched, idempotence at factor 1. Page test: the stepper renders, changing it rescales the ingredient lines, the caption appears, and Start still launches the base recipe. Lands with the detail page or as its own branch + PR.

## Files touched

- `app/api/cook/route.ts` — add the `get_recipe` case (+ the action to the allowed-actions list).
- `app/api/cook/route.test.ts` — route tests above.
- `app/recipes/[id]/page.tsx` (new) + `page.module.css` (new) + `page.test.tsx` (new).
- `app/recipes/page.tsx` — title becomes a link; `app/recipes/page.test.tsx` — link assertion.
