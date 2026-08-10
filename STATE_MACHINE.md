# Cooking Session State Machine

Formal definition in `lib/domain/session.ts` (`SESSION_PHASES`,
`ALLOWED_TRANSITIONS`). The database — not conversational memory — is the
source of truth: a refresh or reconnect restores the user to the same phase
and step via `CookingSession.resumableState`.

## Phases

```
IDLE → COLLECTING_INGREDIENTS → CONFIRMING_INGREDIENTS →
COLLECTING_REQUIREMENTS → GENERATING_RECIPE → VALIDATING_RECIPE →
RECIPE_READY → PREP_GUIDANCE → COOKING_GUIDANCE → PLATING → COMPLETED
```

Interruptions (each records a resumable state):

```
PREP_GUIDANCE / COOKING_GUIDANCE / WAITING_FOR_TIMER
  → PAUSED → (resume) → same phase
  → SUBSTITUTION_REQUIRED → (apply) → same phase
  → USER_CORRECTION → (persist) → same phase or COLLECTING_REQUIREMENTS
PREP_GUIDANCE / COOKING_GUIDANCE → SAFETY_WARNING → (acknowledge) → same step
Any operational failure → ERROR_RECOVERY (bounded retry / question / reload)
COMPLETED → IDLE (start over)
```

## Transition reasons

`USER_INPUT` · `AGENT_TOOL` · `TIMER_COMPLETED` · `RECOVERY` · `SYSTEM` —
recorded on every transition so recovery can restore the exact previous
context.

## Key invariants (proven by tests)

- A step can never be skipped or duplicated (version-conflict protection).
- Timers are never duplicated; completion of a `WAITING_FOR_TIMER` step
  recovers to the exact step.
- The recipe is never altered by navigation — only by explicit substitution /
  correction (which revalidates).
- The safety gate never advances a step until explicitly acknowledged.
