# Deployment — Cook with Freebuff

How this app is built, deployed, and verified, and what to do when something breaks.

## Topology

```
push/PR ──► GitHub Actions (validate: typecheck · lint · test · build
             │            + tokenless stale-head guards)
             │
             ├──► emulator-compare smoke
             │         │
             │         ▼
             └──► deploy-apphosting (App Hosting — PRIMARY production host)
                       │
                       ▼
                   verify:live (same run: wait-for-sha → smoke → full E2E)
```

- **Hosting** — Firebase App Hosting (Cloud Run, SSR). Production branch `main`.
  Canonical URL: `https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app`.
- **Auth / Data** — Firebase Auth + Firestore, shared with the portfolio app under **one union ruleset**
  (see `firestore.rules`). Both apps deploy the same rules file; keep them in sync in one commit.
- **Admin SDK** — server-side only, service-account credentials from `FIREBASE_SERVICE_ACCOUNT`
  (inline JSON in `.env.local` / GitHub secret).

## Required environment

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | GitHub secret | Client Firebase auth |
| `FIREBASE_SERVICE_ACCOUNT` | `.env.local`, GitHub secret | Admin SDK (inline JSON) |
| `APP_OWNER_UID` | `.env.local`, GitHub secret | Owner identity for verify:live + admin flows |
| `GOOGLE_AI_API_KEY` | `.env.local`, GitHub secret | Gemini provider (recipe gen, conversation) |

Local dev reads `.env.local`; CI reads GitHub secrets. The values must stay in
sync across both stores.

## Deploying

```bash
# 1. Validate locally
npm run typecheck && npm test && npm run build

# 2. Land to main (protected — see "Landing changes (strict flow)" below):
#    owner   git push origin main                                     # bypass-with-recording
#    anyone  npm run land:pr -- --message "fix: ..." --wait           # branch + PR + merge-when-green

# 3. CI deploys the main branch to App Hosting (after validate + smoke pass)

# 4. CI verifies the deployed app end to end (same run, after the rollout
#    serves the pushed commit):
#    npm run verify:live            # seeds owner recipe → guided flow → safety gate →
                                    # timer → pantry confirm → Gemini turn → cleanup
```

`verify:live` also runs automatically in CI in the same run as every main
deploy (`verify:live` job, needs-edge of the deploy), secret-gated on the
four vars above with a loud guard: a missing secret on a main push **fails**
the run instead of silently skipping. Its first step polls the host's
`/api/build-info` until it serves the pushed commit (tokenless), so it can
never race the deploy.

## Landing changes (strict flow)

`main` has **strict** branch protection: up-to-date is required, merges are
PR-only (zero required approvals for the solo maintainer), and the repository
owner may push directly with **bypass-with-recording** (`enforce_admins` is
off — the push is allowed and marked "Bypassed rule violations"). Everyone
else must land through a pull request.

### Required checks

One check is required before anything merges, plus a push-only smoke:

| Check | Runs on | Gates |
|---|---|---|
| `Typecheck · Lint · Test · Build` | every PR + push | merge (includes the tokenless push + PR stale-head guards) |
| `Emulator-compare smoke (guided flow vs live)` | main pushes (push-only job) | the App Hosting deploy (`needs: [validate, emulator-compare]`) |

There is **no PR preview deploy check** — App Hosting is the only host and
builds no Vercel-style previews. The old `Verify PR preview deploy (hash
gate)` check was removed with Vercel: with a single host there is no second
build system to reconcile, `validate` proves the app builds, and a bad App
Hosting build of the merged main fails the `deploy-apphosting` job loudly.

The smoke reports **skipped** on PRs by design — its deployed leg writes to the
shared production backend, so per-PR runs would burn the owner-verify write
budget. A skipped required check does not block an auto-merge (verified live:
PRs #13 and #14 merged with the smoke skipped).

### Merge-when-green (the one-command path)

```bash
npm run land:pr -- --message "fix: ..." --wait
```

`scripts/land-pr.mjs` does the whole dance in one step: guards (clean tree /
wrong base), feature branch, staged-only commit (hunk-split trees stay
clean), push of the feature branch **only** (it never touches a main ref), PR
against `main`, auto-merge armed (squash + delete branch), and with `--wait`
it blocks until the PR actually merges (default timeout 600s, tune with
`--wait-timeout`) and reports the outcome. Auto-merge fires the moment the
required checks go green — merge-when-green without babysitting.
`--no-merge` stops at PR creation.

### The bootstrap path (historical)

Between "strict checks + admin enforcement" and PR-only, there was a
bootstrap deadlock: a brand-new commit's checks cannot run until the commit
exists, and the commit cannot land until its checks pass — GitHub rejects the
first push with `N/N required status checks are expected`. The escape was to
push the same commits to a temporary branch, open a **bootstrap PR** so the
checks ran on the exact commit, then direct-push to `main` (check runs are
keyed per commit, so the green/skipped runs satisfied the required checks).
That dance is obsolete: PR-only + auto-merge replaced it, and the owner's
bypass-with-recording makes the direct push itself unblocked.

## Verify:live contract

`scripts/verify-live.mjs` proves the whole stack against the live App Hosting
build:

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

App Hosting keeps prior rollouts; to roll back, promote a previous rollout via
the Firebase console (App Hosting → rollouts) or redeploy an earlier commit.
There is no second host to switch to — the App Hosting rollout history IS the
rollback surface.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| verify:live fails at seed | `FIREBASE_SERVICE_ACCOUNT` stale/missing | Re-sync all three stores |
| verify:live fails at Gemini turn | `GOOGLE_AI_API_KEY` missing | Add to GitHub secrets (and `apphosting.yaml` for runtime), redeploy |
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
