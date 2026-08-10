# Agent Tools

The tool registry (`lib/server/tools/index.ts`) is the ONLY way the
conversational model touches application state. `executeTool` validates args
(zod), executes, sanitizes, logs to `agent_tool_logs`, and returns a
structured envelope. Gemini's function declarations mirror this list
(`lib/ai/conversation.ts`, `nullable: true` — never union-type arrays).

## Tool surface

**Ingredients (K5)**
- `save_available_ingredients` / `update_available_ingredients` /
  `confirm_available_ingredients`

**Session (K2)**
- `start_cooking_session` / `get_cooking_session` / `get_current_step` /
  `complete_current_step` / `repeat_current_step` / `previous_step` /
  `pause_cooking_session` / `resume_cooking_session` / `end_cooking_session`

**Timers (K2)**
- `start_timer` / `get_active_timers` / `cancel_timer` / `complete_timer`

**Recipes (K4/K7)**
- `generate_recipe` / `validate_recipe` / `resize_recipe` /
  `find_substitution` / `replace_ingredient`

**Guided cooking (K6/K7)**
- `cook_with_me` / `check_timers` / `request_substitution` /
  `apply_substitution` / `correct_ingredient` / `recover_session`

**Pantry + dietary profile (K8)**
- `get_pantry` / `add_pantry_item` / `update_pantry_item` /
  `remove_pantry_item` / `confirm_pantry_item` /
  `confirm_pending_pantry_items` / `get_dietary_profile` /
  `update_dietary_profile`

## Deterministic command router

`lib/agent/commands.ts` maps natural phrases to intents (short-circuiting the
model for high-confidence commands): `NEXT`, `REPEAT`, `PREVIOUS`, `PAUSE`,
`RESUME`, `STOP`, `TIMER_STATUS`, `CURRENT_STEP`, `SUBSTITUTE`,
`USE_SUBSTITUTE`, `CORRECT`, `CONFIRM` (fallback chain: pending pantry → 
collected ingredients → advance step), `COOK`, `PANTRY_ADD`, `PANTRY_GET`,
`PANTRY_REMOVE`, `HELP`. Everything else falls through to ingredient
extraction or the provider.

## Honest-failure rule

A tool that fails is reported as `{ success: false, error: { code, message,
recoverable } }` — the agent says "Sorry, that did not work: …" and never
claims an action happened.
