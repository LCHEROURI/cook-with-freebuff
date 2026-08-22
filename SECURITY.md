# Security

K9 Part B audit result. The audit (`lib/server/security.test.ts`) found and
fixed two real gaps; the isolation model below is now enforced and locked by
tests.

## Audit findings (fixed in K9)

1. **Recipe ownership** — `launchCookWithMe` fetched recipes by id with no
   owner check, and recipe reads go through the admin SDK (which bypasses
   Firestore rules), so user B could launch/read user A's recipe. Fixed:
   owner check at launch AND in `requireRecipe` (every subsequent read,
   defense in depth).
2. **Ownerless generated recipes** — `generate_recipe` persisted the
   provider's output without stamping `userId`, so generated recipes had no
   owner (and Firestore rules would block even their owner from reading them
   client-side). Fixed: the tool stamps `userId` before persisting.

## Isolation model

- **Auth** — every API route resolves the Firebase ID token server-side;
  the uid comes from the verified token, never the client.
- **Sessions** — owner-scoped; `resolveSession` rejects foreign sessions
  with `FORBIDDEN`.
- **Recipes** — owner-scoped (`recipe.userId === caller`).
- **Pantry** — `requireOwned` rejects foreign items with `FORBIDDEN`.
- **Dietary profiles** — keyed by uid; reading another user's is impossible
  by construction.
- **Timers/logs** — reachable only through owner-scoped sessions; tool
  failures carry the caller's uid into `agent_tool_logs`.
- **Firestore rules** — the shared-project union ruleset
  (portfolio + kitchen collections, owner-scoped, catch-all deny last).

## Data-write integrity

Every repository create and update validates the complete resulting document
against its canonical Zod schema before Firestore mutation. Partial updates are
merged with the stored document and then validated, so a valid-looking patch
cannot leave invalid persisted state. Repository policies also reject changes
to immutable identity, ownership, source, and creation fields. Optimistic
session versions and correlation-marker transaction semantics remain enforced.

Client rules independently prove owner, second-user, and anonymous outcomes.
The Cook clauses preserve ownership on updates, append-only collections reject
updates/deletes, and server-managed collections deny all client access. Because
`firestore.rules` is shared, `scripts/firestore-rules-scope.test.ts` preserves
the non-Cook union sections byte-for-byte and keeps the catch-all deny last.

## App Check boundary

For the quota-bearing `/api/agent`, `/api/cook`, `/api/tools`,
`/api/vision/scan`, and `/api/voice/token` routes, App Check runs before authentication and provider work. In production, `APP_CHECK_ENFORCED=1` fails
closed when the token, expected app ID, site key, or Admin credentials are
missing or invalid. Voice-token and vision requests consume single-use tokens;
standard routes verify ordinary attestation tokens.

The local Firebase emulator path retains its explicit App Check bypass so
development does not need production attestation. Monitor mode is rollout-only:
production acceptance requires an unattested HTTP 403 `APP_CHECK_FAILED` and
an attested authenticated success from the deployed verifier.

## Server-only surface

`lib/server/*` (admin credentials, Firestore, repositories, logger) is
guarded by `import 'server-only'`. A test scans client directories and fails
if any non-API component imports a server module (type-only imports are
erased at build and are safe). No privileged secret (service account,
Gemini key) can appear in a frontend bundle — they live only in
`FIREBASE_SERVICE_ACCOUNT` / `GOOGLE_AI_API_KEY` on the server.

## Observability (K9 Part C)

- **Structured logs** — `lib/server/logger.ts` emits one JSON line per event
  (`ts, level, event, correlationId, …`); info → stdout, warn/error → stderr
  for Google Cloud Logging.
- **Failure events** — `api.cook.error`, `api.agent.error`,
  `agent.provider.error` (model failures are logged structurally with the
  correlation id; the user still gets a calm message).
- **Durable trails** — `agent_tool_logs` (every tool call, latency, error
  code, correlation id) and `cooking_session_events` (append-only audit).
- **Correlation ids** — one id threads a conversation: voice request → agent
  → tool call → backend → database → response.
