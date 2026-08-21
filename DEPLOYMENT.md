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
- **Auth / Data** — Firebase Auth + Firestore use **one shared union ruleset**
  (see `firestore.rules`). A rules release is blocked until the separately
  maintained sibling rules file is verified byte-identical. This repository's
  implementation work does not access or modify that sibling application.
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

Two checks are required before anything merges, plus a push-only smoke:

| Check | Runs on | Gates |
|---|---|---|
| `Typecheck · Lint · Test · Build` | every PR + push | merge (includes the tokenless push + PR stale-head guards) |
| `Codex P1 gate` | every PR + review events | merge (blocks open P0/P1; P2 too when `CODEX_GATE_INCLUDE_P2=true`) |
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

### Codex review gate

The `chatgpt-codex-connector[bot]` posts inline review comments shortly after a
PR opens — often after the first checks complete. The gate re-runs on
review-comment (created and deleted) and review events, so a late finding
still reddens the required check. A finding is **open** until a human replies
on its thread (the resolution-note convention: fix, then reply `Resolved …`);
a red gate also keeps a bot-style summary on the PR thread — one per head,
edited in place as the finding set changes, resolved when the gate goes
green. Exit codes: `0` clean, `1` waiting-for-review or open findings block,
`2` usage error.

| Knob | Where | Effect |
|---|---|---|
| Wait timeout | `CODEX_GATE_WAIT_SECONDS` env (script-level, default `360`) | how long the gate polls for a Codex review of the current head before failing with a WAITING verdict — an empty comment list is *not* a clean review |
| P2 strict bar | `CODEX_GATE_INCLUDE_P2` repo variable (`true`) | blocks on open P2 findings too (default: P0/P1 only) |
| Bot-skipped certification | `CODEX_GATE_BOT_SKIPPED_PRS` repo variable (comma-separated PR numbers) | certifies a PR the bot is not going to review; only this path satisfies the required merge gate (a `workflow_dispatch` check never enters the PR status rollup) |

Exact commands:

```bash
# Local dry-run of the gate against a PR (exit 0 = clean, 1 = blocked):
node scripts/codex-review-pr-gate.mjs --pr 42

# Shorter wait window for a local run:
CODEX_GATE_WAIT_SECONDS=60 node scripts/codex-review-pr-gate.mjs --pr 42

# Stricter bar (P2 blocks) — repo-wide, persistent:
gh variable set CODEX_GATE_INCLUDE_P2 --body "true"
gh variable delete CODEX_GATE_INCLUDE_P2          # revert to P0/P1 only

# Certify a PR the bot skipped: set the variable, push any commit to re-run
# the gate via a synchronize event, then remove it after the merge.
gh variable set CODEX_GATE_BOT_SKIPPED_PRS --body "42"
git commit --allow-empty -m "certify: bot skipped review" && git push
gh variable delete CODEX_GATE_BOT_SKIPPED_PRS
```

`--include-p2` and `--allow-no-review` are the local/CLI forms of the two
variables above (`CODEX_GATE_ALLOW_NO_REVIEW=true` is the env form). The
`workflow_dispatch` run of the workflow also takes `pr` and `allow_no_review`
inputs, but its check never enters the PR status rollup — use the repo
variables for anything that must actually gate a merge.

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

- `firestore.rules` — the shared **union** ruleset. The Cook clauses are
  owner-isolated, append-only collections stay append-only, server-managed
  collections remain client-denied, and the catch-all deny stays last.
- `scripts/firestore-rules-scope.test.ts` pins the non-Cook prefix and catch-all
  suffix byte-for-byte. Run `npm run test:rules` for the emulator owner matrix
  and `npm test -- scripts/firestore-rules-scope.test.ts` for the scope lock.
- **Release prerequisite:** before any rules deployment, use a separately
  authorized release workflow to copy the final union file to the sibling
  rules repository and verify the two files are byte-identical. Do not deploy
  this changed union ruleset while that synchronization is pending. This is a
  release coordination gate, not permission for this track to edit another app.
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
| Firestore reads/writes fail client-side | Rules not deployed / drifted | Verify the sibling synchronization prerequisite, then deploy the canonical union ruleset through the authorized release workflow |
| CI validate fails at lint | ESLint config drift | `npm run lint` locally first |

## Docs

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture (Mermaid)
- [`DATA_MODEL.md`](./DATA_MODEL.md) — collections, shapes, ownership
- [`AGENT_TOOLS.md`](./AGENT_TOOLS.md) — the tool surface the AI can call
- [`STATE_MACHINE.md`](./STATE_MACHINE.md) — session phases + transitions
- [`VOICE_ARCHITECTURE.md`](./VOICE_ARCHITECTURE.md) — voice pipeline + provider boundary
- [`SECURITY.md`](./SECURITY.md) — isolation model, audit findings
- [`TESTING.md`](./TESTING.md) — test layout, E2E scenarios, mobile QA matrix
