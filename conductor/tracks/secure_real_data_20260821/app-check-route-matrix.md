# Phase 3 App Check Route Matrix

This inventory is limited to Cook With Freebuff request handlers that can
spend external AI quota. Every gate executes before authentication, request
body parsing, context construction, model resolution, provider invocation, or
upstream token minting.

| Route | Method | Attestation | Protected quota boundary | Rationale |
| --- | --- | --- | --- | --- |
| `/api/agent` | POST | Standard cached token | Conversation-agent provider lookup and turn processing | A conversational turn can invoke Gemini and state tools |
| `/api/cook` | POST | Standard cached token | Guided action dispatch (`create_recipe` can call the generator) | The same endpoint carries quota and non-quota actions, so the whole POST surface is gated consistently |
| `/api/tools` | POST | Standard cached token | Tool execution | Direct dispatch includes quota-bearing AI tools |
| `/api/vision/scan` | POST | Consumed single-use token | Gemini vision scan | An image scan is expensive and non-polled |
| `/api/voice/token` | POST | Consumed single-use token | Gemini Live upstream token mint | A minted session token grants a new live session |

## Explicit non-quota exclusions

- `/api/cook` GET reads current cooking status only.
- `/api/kitchen` performs authenticated state/service operations without a
  model or external quota provider.
- `/api/status` reads deployment and verification state.
- `/api/build-info` returns build identity.

If any excluded handler begins provider or quota work, it must first be added
to `scripts/app-check-route-contract.ts`, gated at the top of the handler, and
covered by the blocked-request runtime contract.
