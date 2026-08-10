# Deployment — Cook with Freebuff

How this app is built, deployed, and verified, and what to do when something breaks.

## Topology

```
push/PR ──► GitHub Actions (validate: typecheck · lint · test · build)
                 │
                 ▼
        Vercel production deploy (cook-with-freebuff)
                 │
                 ▼
        deployment_status: verify-deployed (verify:live against https://cook-with-freebuff.vercel.app)
```

- **Hosting** — Vercel. Production branch `main`. Preview deploys for PRs.
- **Auth / Data** — Firebase Auth + Firestore, shared with the portfolio app under **one union ruleset**
  (see `firestore.rules`). Both apps deploy the same rules file; keep them in sync in one commit.
- **Admin SDK** — server-side only, service-account credentials from `FIREBASE_SERVICE_ACCOUNT`
  (inline JSON in `.env.local` / Vercel env / GitHub secret).

## Required environment

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Vercel, GitHub secret | Client Firebase auth |
| `FIREBASE_SERVICE_ACCOUNT` | `.env.local`, Vercel, GitHub secret | Admin SDK (inline JSON) |
| `APP_OWNER_UID` | `.env.local`, Vercel, GitHub secret | Owner identity for verify:live + admin flows |
| `GOOGLE_AI_API_KEY` | `.env.local`, Vercel, GitHub secret | Gemini provider (recipe gen, conversation) |

Local dev reads `.env.local`; CI reads GitHub secrets; Vercel reads its env store.
The values must stay in sync across all three stores.

## Deploying

```bash
# 1. Validate locally
npm run typecheck && npm test && npm run build

# 2. Commit + push (triggers validate job)
git push origin main

# 3. Vercel auto-deploys the main branch

# 4. Verify the deployed app end to end
npm run verify:live                 # seeds owner recipe → guided flow → safety gate →
                                    # timer → pantry confirm → Gemini turn → cleanup
```

`verify:live` also runs automatically in CI after every main deploy
(`verify-deployed` job), secret-gated on the four vars above with a loud
guard: a missing secret on a main push **fails** the run instead of silently
skipping.

## Verify:live contract

`scripts/verify-live.mjs` proves the whole stack against the live build:

1. Seeds an owner-scoped recipe via the Admin SDK
2. Mints an owner ID token (`createCustomToken` → identitytoolkit exchange)
3. Drives the guided flow on `/api/cook`:
   launch → prep step → done → next step → **safety gate surfaced**
   (step preserved) → acknowledge → **timer auto-start**
4. Drives `/api/agent` turns: `add_pantry_item` → `"yes"` →
   `confirm_pending_pantry_items` → read-back asserts (pending list cleared,
   confidence → 1) → free-form greeting proves the Gemini provider answers
5. Cleans up every seeded doc (recipe, session, events, timers, pantry probe)

Any failure exits non-zero; the CI job fails, so a broken deploy can't go green.

```bash
npm run verify:live                       # deployed default
npm run verify:live -- --app http://localhost:3100   # local dev server
```

## Firestore rules & indexes

- `firestore.rules` — the **union** ruleset shared with the portfolio app
  (9 portfolio + 8 kitchen collections, owner-isolated, catch-all deny last).
  Deploy with `npm run deploy:rules` from the **portfolio** repo (both projects).
- `firestore.indexes.json` — composite indexes; deploy alongside rules.

## Rollback

```bash
# Vercel: promote a previous deployment via the dashboard, or
vercel rollback <deployment-url>
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| verify:live fails at seed | `FIREBASE_SERVICE_ACCOUNT` stale/missing | Re-sync all three stores |
| verify:live fails at Gemini turn | `GOOGLE_AI_API_KEY` missing on Vercel | Add to Vercel env, redeploy |
| `/api/*` returns 401 | ID token rejected | Check `NEXT_PUBLIC_FIREBASE_API_KEY` matches project |
| Firestore reads/writes fail client-side | Rules not deployed / drifted | Re-deploy union ruleset from portfolio repo |
| CI validate fails at lint | ESLint config drift | `npm run lint` locally first |

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture (Mermaid)
- [`DATA_MODEL.md`](./DATA_MODEL.md) — collections, shapes, ownership
- [`AGENT_TOOLS.md`](./AGENT_TOOLS.md) — the tool surface the AI can call
- [`STATE_MACHINE.md`](./STATE_MACHINE.md) — session phases + transitions
- [`VOICE_ARCHITECTURE.md`](./VOICE_ARCHITECTURE.md) — voice pipeline + provider boundary
- [`SECURITY.md`](./SECURITY.md) — isolation model, audit findings
- [`TESTING.md`](./TESTING.md) — test layout, E2E scenarios, mobile QA matrix
