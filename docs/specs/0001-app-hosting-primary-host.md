# 0001 — Make Firebase App Hosting the primary production host

**Status**: Proposed

## Summary

This decision makes Firebase App Hosting the one production host and retires Vercel from the deploy pipeline. The app already runs fully on App Hosting today, proven after every deploy, and its public `/api/build-info` route reports the live commit with no token, which collapses the two hardest Vercel-specific pieces of the pipeline (the hash gate and the stale head guard) into plain HTTP checks. The post deploy verification moves into the deploy's own CI run, and the PR preview gate is dropped rather than rebuilt. The result is a Google-only pipeline with one canonical URL, two fewer secrets, and every gate tokenless.

## Context

The app's runtime has no Vercel dependency: every line of application code runs identically on Firebase App Hosting. Vercel is a pipeline dependency. It provides five things today:

1. Auto deploy on push to main, through the GitHub integration, with no CI needed.
2. The `deployment_status` event, which is what triggers the post deploy `verify-deployed.yml` workflow (post deploy smoke, hash gate, verify:live, teeth proof).
3. PR preview deployments, which back the `Verify PR preview deploy (hash gate)` required check.
4. The live commit resolution used by the stale head guards in `ci.yml`, through the Vercel API with `VERCEL_TOKEN`.
5. The canonical URL, which is the default target in about eight scripts, the `VERIFY_BASE_URL` default, and an authorized domain in the Firebase web app config.

Meanwhile App Hosting already has the facts that make the migration cheap:

- The app is proven to work there: the `[4b]` stage of verify:live asserts the App Hosting host serves the app and answers `/api/cook`, and it has been green after every deploy.
- The deploy already happens inside CI (`deploy-apphosting`), gated by `validate` and the emulator-compare smoke, and it stamps the pushed commit into the build via `write-commit.mjs`.
- The host's `/api/build-info` route reports `commitSha` publicly with no token. That one fact replaces the Vercel API, the token, the team resolution, and the CLI auth fallback for the entire hash and stale guard machinery.

Two timing facts shape the design. First, `firebase deploy --only apphosting` can return while the rollout is still queued or building (the existing 409 retry loop implies this), so the post deploy gate cannot trust the deploy job's exit code alone; it must poll the hosted URL until it serves the pushed commit. Second, the post deploy verify has always raced asynchronous host builds when event driven (the exact bug the `verify-deployed.yml` header documents); moving it inside the deploy's own CI run removes the race by construction.

The one genuine loss is the PR preview gate. It exists because Vercel builds previews for every PR head and the pipeline could prove the preview served the PR head commit. With Vercel gone there is no second build system to reconcile, so the gate's original purpose dies with the host.

## Requirements

Acceptance criteria (authored from the migration evaluation; confirm these before building):

- AC-1: The production canonical URL is the Firebase App Hosting URL. The app serves from it, and `/api/build-info` reports the pushed commit sha with no token.
- AC-2: Post deploy, verify:live runs in the same CI run as the deploy, only after `deploy-apphosting` succeeds, and its first step proves the host serves the pushed sha before exercising the app.
- AC-3: The hash gate and both stale head guards (push and PR) resolve the live commit from `/api/build-info` with no `VERCEL_TOKEN`, no Vercel CLI auth store, and no team resolution.
- AC-4: The `Verify PR preview deploy (hash gate)` check is removed from branch protection. Pull requests merge on `validate` plus the tokenless PR stale head guard.
- AC-5: Every Vercel dependency is retired: the `VERCEL_TOKEN` secret, `verify-deployed.yml` with its `deployment_status` trigger, the `verify-preview-deploy` job, the `.vercel/` directory, the Vercel URL defaults in scripts and workflows, and the Vercel domain in the Firebase authorized domains.
- AC-6: The contract test suites (`ci-workflows.test.ts`, `verify-deployed-hash.test.ts`, `verify-deployed-hash-gate.test.ts`, `verify-gate-stale-ci.test.ts`) lock the new topology, and the full suite plus typecheck pass.

## Decision

Make Firebase App Hosting the primary and only production host, and retire Vercel from the pipeline. The three named areas resolve as follows.

**The verify needs edge.** Move verify:live out of the event driven `verify-deployed.yml` and into `ci.yml` as a job with `needs: [deploy-apphosting]`. Its first step polls the App Hosting URL's `/api/build-info` until the reported sha equals the pushed sha (bounded wait, names the failing hop on timeout), then runs the post deploy smoke, then verify:live against the App Hosting URL. The `[4b]` second host comparison in verify:live collapses: the host being exercised is now the canonical host, so its serve plus `/api/cook` plus commit checks become the main proof rather than a side comparison. (basis: the app's own verify-deployed.yml header documenting the race it was built to fix, and the apphosting deploy already being a CI job)

**The tokenless hash gate.** `verify-deployed-hash.mjs` drops the Vercel API branch entirely. The existing `resolveAppHostingCommit` path, which reads `/api/build-info` from the target host with no credential, becomes the only resolution path. The Vercel token chain (env var, `.env.local`, CLI auth store), the team resolution, and the `.vercel/project.json` project id lookup are deleted. Exit codes and message shapes stay, so callers keep their behavior. The stale head guard and the teeth proof retarget to the same tokenless resolution. (basis: the repo's own `/api/build-info` route, already public by design and already used for App Hosting in the hash script)

**The PR preview decision.** Drop the `Verify PR preview deploy (hash gate)` required check and do not replace it with a new preview deploy on day one. The gate proved one thing: the Vercel preview build matched the PR head. With Vercel gone, `npm run build` inside `validate` covers "the app builds," and the `deploy-apphosting` job fails loudly if the App Hosting build of the merged main fails. Pull requests gate on `validate`, which now includes the tokenless PR stale head guard. The runner up, App Hosting branch deploys (per branch rollouts to branch URLs), is recorded as a follow up for the day PR time deploy proof becomes load bearing. (basis: strangler pattern for retiring a host, and the repo's existing division where the smoke is push only and PRs gate on validate)

## Design

### Target topology

```
push to main
   │
   ▼
ci.yml (one run, one concurrency group)
   ├─ validate            Typecheck · Lint · Test · Build
   │    └─ stale head guard (push)   tokenless, via /api/build-info
   ├─ emulator-compare     smoke vs live + emulator stack (push only, as today)
   └─ deploy-apphosting    needs [validate, emulator-compare]
        └─ verify:live     needs [deploy-apphosting]
             ├─ wait for sha    poll /api/build-info until commitSha == pushed
             ├─ post deploy smoke
             └─ verify:live driver (the app, Gemini, Firestore)
```

### The three gates after migration

**Post deploy verify.** Runs in the same workflow run as the deploy. Because `firebase deploy --only apphosting` can return while the rollout is queued, the gate's first step polls the hosted URL. Poll every 20 seconds, bounded at 15 minutes. On timeout, fail with a message naming the hop: "App Hosting rollout did not serve the pushed sha within 15 minutes." This is strictly stronger than today's event trust: the gate proves the target serves your commit before exercising it.

**Hash gate and stale guard.** Both become tokenless HTTP checks. Live commit equals what `/api/build-info` reports. The direction aware semantics of the stale guard stay exactly as they are today: a normal forward push passes here and is proven after deploy; a push whose head is not ahead of live fails. The PR variant with `--head` stays, also tokenless. Both become locally runnable without a `vercel login`.

**PR gate.** Branch protection's required checks list loses the preview entry and keeps `validate`. The smoke stays push only (it writes to the shared production backend), so nothing merges on a check that touches production.

### What is deleted

- `verify-deployed.yml` and its `deployment_status` trigger
- The `verify-preview-deploy` job
- The `VERCEL_TOKEN` secret and every loud guard that fails on a missing token
- The Vercel API and CLI auth machinery in `verify-deployed-hash.mjs`
- The `.vercel/` directory
- The Vercel URL defaults in the driver scripts, `verify-live.mjs`, and the mic regression workflow
- The Vercel domain in the Firebase authorized domains

## Build plan

Ordered as tracer bullet slices: the tokenless resolution is the foundation, everything else retargets onto it. The repo's de facto delivery pattern is contract-locked CI changes landed through branch plus PR, so every task carries its contract test update.

1. Tokenless live commit resolution. Rewrite `scripts/verify-deployed-hash.mjs` so the `/api/build-info` path is the only resolution; delete the token chain, team resolution, and project id lookup; keep the exit code contract (0 pass, 1 fail, 2 credential problem disappears with the token). Update `scripts/verify-deployed-hash.test.ts`. (satisfies AC-3)
2. Tokenless stale head guard. Retarget `scripts/verify-deployed-hash-gate.mjs` (both `--stale-guard` and `--head` modes) onto the tokenless resolution, preserving the direction aware semantics. Update `scripts/verify-deployed-hash-gate.test.ts`. (satisfies AC-3)
3. Tokenless teeth proof. Retarget `scripts/verify-gate-stale-ci.mjs` to the tokenless path and update `scripts/verify-gate-stale-ci.test.ts`. (satisfies AC-3)
4. Canonical URL switch. Change the default target from the Vercel URL to the App Hosting URL in the driver scripts (`drive-live-voice.mjs`, `drive-starter-prefs.mjs`, `drive-recipes-page.mjs`, `drive-ui-skin.mjs`, `drive-home-button.mjs`, `audit-a11y.mjs`), `verify-live.mjs`, and the mic regression workflow's `VERIFY_BASE_URL`. (satisfies AC-1)
5. Verify needs edge. In `ci.yml`, add the verify:live job with `needs: [deploy-apphosting]` and a 30 minute timeout; add the wait for sha poll step; fold in the post deploy smoke; drop the `VERCEL_TOKEN` wiring and loud guards. (satisfies AC-2)
6. Collapse the second host stage. Update verify:live's `[4b]` stage so the App Hosting host is the canonical proof (serve, `/api/cook`, commit sha) rather than a comparison to Vercel. (satisfies AC-1, AC-2)
7. Delete the event driven workflow and the preview job. Remove `verify-deployed.yml` and the `verify-preview-deploy` job; remove the `deployment_status` trigger. (satisfies AC-5)
8. Branch protection change. Remove `Verify PR preview deploy (hash gate)` from the required checks; keep `validate`. (satisfies AC-4)
9. Retire Vercel artifacts. Remove the `VERCEL_TOKEN` secret from the repo, delete `.vercel/`, remove the Vercel domain from the Firebase authorized domains, and update `DEPLOYMENT.md` and `README.md` to describe the App Hosting only topology. (satisfies AC-5)
10. Lock the new topology. Update `scripts/ci-workflows.test.ts` and any other contract tests that assert Vercel wiring, then run the full suite and typecheck. (satisfies AC-6)
11. Prove it live. Land the change through the branch plus PR path, then run a mic regression phase C batch against the new canonical URL and one post deploy verify:live, to confirm the two burst pass rate holds on App Hosting. (verifies AC-1, AC-2)

## Consequences

**What improves.** The pipeline loses its one non Google dependency. Two secrets go away (`VERCEL_TOKEN` and the CLI auth store dependency). Every gate becomes tokenless and locally runnable. The deploy is gated by validate plus the smoke before it starts, so broken code never deploys, and verify:live proves the host serves your commit before exercising it, which is strictly stronger than the event trust it replaces.

**What is traded away.** The canonical URL becomes a `hosted.app` subdomain until a custom domain is attached. Pull requests lose the deployed preview proof: a build that only works in the App Hosting backend but not in CI would surface as a red deploy job on main rather than a red PR. The deploy is no longer instant on push; it waits for validate and the smoke, and the wait for sha poll adds up to about 15 minutes before verify starts on a slow rollout. App Hosting cold starts are real (the same class as Vercel serverless; `minInstances` is 0 today and can be tuned).

**What stays the same.** The emulator-compare smoke stays push only and gates the deploy. The mic regression workflow keeps its 6 run batch, now pointed at the new canonical URL. The app code does not change at all.

## Follow-up

- [ ] Confirm the acceptance criteria list above before building (authored from the evaluation, not from a pre existing confirmed list).
- [ ] Attach a custom domain to App Hosting if one is owned, so the canonical URL is not a `hosted.app` subdomain.
- [ ] Add App Hosting branch deploys (the `branches` config in `apphosting.yaml`) if PR time deploy proof becomes load bearing; the PR preview gate is dropped today by decision.
- [ ] Remove the Vercel domain from the Firebase authorized domains as part of task 9, and verify the app still signs in on the App Hosting URL afterward.

## Options considered

**Primary host: keep Vercel canonical (status quo).** Everything works today; the cost is permanent dual host operation, a non Google dependency in the pipeline, and a `VERCEL_TOKEN` that must be kept fresh. Rejected because the migration is cheap and the tokenless facts on the App Hosting side are already proven.

**Primary host: App Hosting (chosen).** The app already runs there, the deploy is already a CI job gated by the smoke, and the public build info route collapses the two hardest pieces. The cost is the retargeting work in the build plan and the loss of the preview gate, both accepted.

**Primary host: Vercel preview only.** Keep Vercel for previews while production moves to App Hosting. Preserves the preview gate exactly but never retires Vercel, keeps the `deployment_status` machinery alive for previews, and contradicts the stated goal. Rejected.

**PR preview: drop the gate (chosen).** The gate's only claim dies with the second build system. `validate` builds the app and the deploy job fails loudly on a bad App Hosting build. Simplest honest option; matches the repo's existing division where PRs gate on validate.

**PR preview: App Hosting branch deploys (runner up).** Per branch rollouts to branch URLs would give PR time deploy proof without Vercel. Real work: branch config, rollout management, build budget per PR, and new check wiring. Disproportionate for a personal repo today; recorded as a follow up.

**PR preview: keep Vercel preview only.** Covered above; rejected for the same reason.

## Rationale

The decision rides on one verified fact: the repo already ships and verifies App Hosting after every deploy, and its build info route is public and tokenless. That makes the migration a retargeting exercise, not a rebuild. The verify needs edge is a strict improvement because the deploy already happens inside CI, so the gate can be a needs edge with a wait for sha poll instead of an event that can race the build. The PR preview gate is the only real loss, and it is a loss of a reconciliation check between two build systems; with one host there is nothing to reconcile. Retiring Vercel entirely, rather than keeping it for previews, avoids running two hosts and two pipelines forever for a single feature this repo deliberately ships without.

Reasoning and option detail: see the options considered sections above.
