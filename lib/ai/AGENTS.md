# AI layer (lib/ai)

## Overview

The AI layer is the provider boundary between business logic and the model SDKs. Every AI capability (recipe generation, validation, conversation, vision, substitutions) is an interface in `provider.ts`; concrete Gemini implementations register by name and are injected through that boundary. Business logic never imports a model SDK directly, so a provider can be swapped without touching its callers.

## Key files

| File | Owns |
|---|---|
| `provider.ts` | The provider interfaces (RecipeGenerator, RecipeValidator, ConversationAgent, SubstitutionService) and the name keyed registry |
| `register.ts` | Bootstrap: registers the Gemini providers under `default` when `GOOGLE_AI_API_KEY` is set, and no-ops otherwise |
| `gemini.ts` | Recipe generation and validation (structured JSON, zod checked), the model resolution helper, and the `pruneNulls` / `extractJson` helpers |
| `conversation.ts` | The conversational agent: it proposes tool calls, the backend executes them |
| `gemini-vision.ts` | Ingredient recognition from photos |
| `tool-declarations.ts` | The tool surface as pure JSON, no SDK imports, shared by the server agent and the browser Live client |
| `model-roles.ts` | The single source of truth for which model each role resolves to (Remote Config, then env, then default) |
| `types.ts` | Shared AI request and result types |
| `index.ts` | Barrel export (types plus provider) |

## Conventions

- Every AI capability is an interface in `provider.ts`; concrete providers register by name and are looked up by name (falling back to `default`).
- Business logic never imports a model SDK directly; it goes through the provider registry.
- The model is only ever asked for structured JSON, which is zod validated before it enters the system.
- Gemini emits `null` for optional fields (for example `description: null`), so `pruneNulls` drops null optional keys before schema parsing, except `quantity` and `unit` which may legally be null.
- Model names resolve from `model-roles.ts` in the order Remote Config, then env var, then hardcoded default; call sites never hardcode a model name.
- Model names are currency guarded by `model-roles.test.ts`: it pins the exact defaults AND the Remote Config template (`remote_config.json`) to current names, and any deprecated `gemini-2.*` value fails CI (the 2.5 family shuts down October 2026), so a model bump moves the pins together.
- Remote Config is provisioned and authoritative for model names (the five params in `remote_config.json` matching the current defaults). Changing a model is zero deploy: edit `remote_config.json`, run `firebase deploy --only remoteconfig`, and the app picks the new value up within the 5 minute cache TTL (`CACHE_TTL_MS` in `lib/server/model-config.ts`) — no app deploy needed.
- Live voice is preview only on the Gemini Developer API: `gemini-3.1-flash-live-preview` is the current name and there is no stable 3.x live name on that provider yet (the only stable live name lives on Agent Platform, a different provider path). Preview models retire within weeks or months of their stable release, so the migration trigger is a stable 3.x live name appearing in the Gemini API changelog: flip the `live_voice_model` RC param (zero deploy, no app redeploy) and move the code default, the guard pins, the verify-live mirror, AND the voice client's own `DEFAULT_LIVE_MODEL` fallback in `lib/voice/gemini-live.ts` in the same change — `model-roles.test.ts` flags any stable 3.x live name in a configured source (default, RC template, or voice fallback) as the prompt to do exactly that.
- Tool declarations are pure JSON with no SDK imports so the server agent and the browser Live client share the same tool surface.
- Providers register only when `GOOGLE_AI_API_KEY` is present; without it, generation and validation report unavailable, while the deterministic substitution engine always works (no key needed).

## Gotchas

- Gemini function-declaration schemas reject union types like `['number', 'null']`; nullable fields must use the `nullable: true` flag instead.
- `model-roles.ts` must stay free of server-only imports: the browser voice client also links against it.
- The provider registry is module-level state; tests must call `resetProviders()` to avoid leaking registrations across tests.
- `registerGeminiProviders()` is safe to call on every server boot: it no-ops when the key is missing.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
