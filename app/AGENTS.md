# app/

## Overview

The Next.js App Router surface: every page the user sees and every API route the app talks to. Pages are thin client components that fetch through `/api/*` routes and render; the routes resolve the user server side, gate App Check, and delegate to the services in `lib/server/`. Pure decision logic that a page needs (filter, scale) lives beside the page so it is node-testable in isolation.

## Key files

| File | Owns |
|---|---|
| `layout.tsx` | Root layout: fonts, service worker registration, viewport metadata |
| `page.tsx` | Home screen (the voice-first entry point) |
| `cook/page.tsx` | The "Cook With Me" screen: starter flow (create a recipe from ingredients) + the active session rendered via `components/CookScreen`; `RecipeRowMeta` + `ConstraintDetails` live here |
| `recipes/page.tsx` | "My Recipes": summary rows, search/filter/sort (`recipe-filter.ts`), Start + Delete actions; `recipe-scaler.ts` is the servings scaler (spec 0003) |
| `recipes/[id]/page.tsx` | Read only recipe detail: header card + meta line, ingredients/equipment/steps/safety notes, allergen chips, and the servings stepper; Start hands off to `/cook` |
| `kitchen/page.tsx` | "My Kitchen": inspect and change pantry, grocery list, leftovers, dietary profile |
| `login/page.tsx` | Sign-in screen with the Google consent popup |
| `status/page.tsx` | Private status surface: live commit, build time, last verify:live verdict |
| `api/cook/route.ts` | Guided cooking dispatch: launch/done/repeat/back/pause/resume/timers/start_over/substitute/.../create_recipe/list_recipes/get_recipe/delete_recipe |
| `api/agent/route.ts` | One conversational turn through the orchestrator |
| `api/kitchen/route.ts` | Snapshot + mutations for the kitchen surface |
| `api/tools/route.ts` | Execute a named agent tool by validated name + arguments |
| `api/voice/token/route.ts` | Mint a Gemini Live ephemeral token (the browser never sees the API key) |
| `api/vision/scan/route.ts` | Scan a base64 photo for ingredients |
| `api/status/route.ts` | Auth-required build + verify:live facts from `deploy_status` |
| `api/build-info/route.ts` | Public commit SHA + emulator flag (no secrets) |

## Conventions

- Every page is a client component (`'use client'`) using the shared auth pattern: `useAuthSession` → loading gate → signed-out `router.replace('/login')` → `auth.error` branch → content. Reads go through `/api/*` routes, never a client-side Firestore query.
- Every API route resolves the Firebase ID token server side via `resolveUserId` — the client never supplies the user id. Quota-bearing routes gate App Check (`gateAppCheck`) before any model work.
- Route handlers are thin: parse → validate → call a `lib/server` service or tool → return `{ success: true, data }` or `{ success: false, error: { code, message, recoverable } }`.
- Errors mirror the repo shape: `INVALID_BODY` 400, `NOT_FOUND` 404, `UNAUTHENTICATED` 401 — with the matching HTTP status.
- Pure logic beside the page (node-testable, no React): `recipes/recipe-filter.ts`, `recipes/recipe-scaler.ts`. Page-level pieces the recipes/cook pages share live as small components in the page dir or in `components/`.
- Styling is per-page CSS modules (`page.module.css` or a named module like `kitchen.module.css`).
- Tests: `route.test.ts` (node env, mocked `resolveUserId`/`buildProductionContext`/`gateAppCheck` + in-memory stores) and `page.test.tsx` (`// @vitest-environment jsdom`).

## Gotchas

- `/cook` can mean two things: the starter (empty state, create-a-recipe input) or an active session via `CookScreen` — the page picks based on session state.
- `api/status` and `api/build-info` are different: status is auth-required and private; build-info is public by design (a commit SHA carries no secrets) and is what the deployed-hash gate reads.
- The recipe `get_recipe` / `delete_recipe` ownership check is server side — a page must never trust an id alone (spec 0003).
- Adding an action to `/api/cook` means touching BOTH the `ACTIONS` array and the switch; forgetting the array silently routes the action to the default status handling.

## Related specs

- `docs/specs/0003-recipe-detail-page.md` — the `/recipes/[id]` page and `get_recipe` read, landed (spec 0003)
- `docs/specs/0001-app-hosting-primary-host.md` — the deploy host the status/build-info surfaces report on

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
