# Scripts: deploy verification, the Codex review pipeline, and the landing path

## Overview

Everything that proves the deployed app and gates a merge. The verify:live drivers run a real end to end cooking flow against the deployed Firebase App Hosting host (and against local dev and the emulator) after every deploy; the Codex gate and monitor enforce that no PR merges with an unanswered bot finding; and land-pr.mjs automates the branch plus PR landing path. The area also carries the deploy-time SHA gates and the cleanup sweeps that keep probe data out of the production store.

## Key files

| File | Owns |
|---|---|
| `verify-live.mjs` | The main post-deploy E2E driver: stages [1] seed → [2] mint token → [2b] model resolution → [2c] login popup → [3] guided cook → [3c] settle → [3d]/[3e]/[3f] UI, voice, and kitchen-mic drivers → [4] agent turns → [4b] substitution (request → apply → exact-step resume, persisted) → [4c] grocery list (add → dedupe → list → remove, persisted) → [4d] vision scan (400 on a missing image + structured 200 on a generated label image), then cleanup. Exit 0 + `RESULT: PASS` is the contract |
| `verify-real-data.mjs` | Explicit production-only Firestore rules proof: two disposable authenticated users, owner pantry create/read/update/delete, cross-user denial, and unconditional Admin cleanup without printing secrets |
| `verify-live-classify.mjs` | Pure classifier that decides the run verdict: EXTERNAL only when the create_recipe root carries a Gemini credits signature and every failure is a known cascade, else FAIL. It feeds the `VERIFY_LIVE_VERDICT` written to GITHUB_ENV so the recorder and status page show the external state distinctly (pinned by `verify-live-classify.test.ts`) |
| `verify-live-local.mjs` | Boots `next dev` on its own process group, warms lazily compiled routes, runs verify-live against localhost, tears the group down on every exit path including SIGINT/SIGTERM handlers |
| `verify-live-emulator.mjs`, `verify-live-compare.mjs`, `verify-live-compare-emulator.mjs` | Emulator and guided-vs-live compare variants of the same check. The emulator-compare diff covers the seven guided-flow steps PLUS the ten deterministic pantry-turn lines (no model dependency — both stacks run them) |
| `drive-*.mjs` | Headless Chrome drivers, one per UI proof: `drive-login-popup.mjs` ([2c] OAuth popup), `drive-starter-prefs.mjs` ([3d] ready card), `drive-live-voice.mjs` ([3e] Gemini Live dictation + active mics), `drive-recipes-page.mjs`, `drive-kitchen.mjs` (Voice Everywhere mics), `drive-home-button.mjs`, `drive-ui-skin.mjs` |
| `verify-deployed-hash.mjs`, `verify-deployed-hash-gate.mjs`, `wait-for-deploy-sha.mjs`, `record-verify-status.mjs` | Deploy SHA gates: what the host is serving vs local HEAD, the push-time stale-guard, and recording verify results to `deploy_status` for the status page |
| `codex-review-pr-gate.mjs` | Required PR check: scans the bot's inline findings, blocks on open P0/P1, polls for the bot review, nudges and certifies per the conventions below |
| `codex-review-monitor.mjs` | Scheduled sweep that opens a labeled issue the first time a finding is seen, deduped by comment id |
| `reply-finding.mjs` | Resolves a bot finding's thread: posts the `Resolved ...` reply on the review-comments endpoint with the typed `in_reply_to` key (pinned by `reply-finding.test.ts`); the gate counts a finding open until a reply lands |
| `verify-live.mjs` `[2b.2]` | The model_source log smoke: reads the deployed server's startup `model_source` lines from Cloud Logging (SA-minted `logging.read` token), scoped to the deployed commit (`jsonPayload.commit` = `GITHUB_SHA`), and hard-asserts all five roles resolved from remote-config with the template model. Requires `roles/logging.viewer` on the deploy SA (`firebase-adminsdk-fbsvc@portfolio-app-freebuff2.iam.gserviceaccount.com`); the grant is live (applied 2026-08-17, project portfolio-app-freebuff2), so the smoke runs and passes on the current main. If the role is ever removed, the stage fails loudly naming the IAM gap, a deliberate gate, never a silent skip; the 403 is the signal that the grant has lapsed |
| `land-pr.mjs` | One-command branch → PR → auto-merge landing path; refuses to push to main |
| `write-commit.mjs` | Stamps the git commit into `commit-sha.txt` before every apphosting deploy (the build zip excludes `.git`) |
| `tidy-branches.mjs` | One-command branch tidy: prunes stale remote-tracking refs (`git remote prune origin`), deletes branches fully merged into the base (`git branch -d`), then closes the squash-merge blind spot by confirming merged PR head branches against GitHub (`gh pr list --state merged`, tip must equal the merged PR headRefOid) before any force delete — the only `-D` in the script is the gh-verified one, and a gh-unavailable run keeps instead of deleting; `--dry-run` previews; `--report <file>` is the READ-ONLY scan for `branch-tidy-weekly.yml` (adds a remote-branch pass since `delete_branch_on_merge` is off, writes the dated report to `docs/reviews/`, prints `FINDINGS: N`, touches nothing); pinned by `tidy-branches.test.ts` |
| `cleanup-correlation-markers.ts` | Bounds the `correlation_markers` collection via the repository boundary, never raw Firestore |
| `stub-server-only.mjs` | Preload that makes `server-only` a no-op so CLI scripts can import the server repository layer under plain node + tsx |
| `emulator-test-helper.ts`, `fixtures/` | Emulator test infra and the `dictation-speech.wav` fixture used by the voice driver |

## Commands

```bash
# The verify family (from repo root, via package.json)
npm run verify:live                  # deployed host, full E2E
npm run verify:live -- --require-app-check-enforced  # release App Check proof
npm run verify:real-data -- --expected-sha "$APPROVED_COOK_COMMIT_SHA"  # guarded production CRUD/isolation proof
npm run verify:live:local            # same check against a local dev server (port 3100, VERIFY_LOCAL_PORT to override)
npm run verify:live:emulator         # against the Firestore emulator
npm run verify:live:compare          # guided flow vs live app comparison
npm run verify:deployed-hash         # the local pre-deploy SHA gate
npm run verify:teeth-proofs          # CI-proof-of-failure variants (gate-fail, stale-guard, gate-stale, hook-block)

# Landing and emulator tests
npm run land:pr -- --message "fix: ..."
npm run test:emulator                # RUN_EMULATOR_TESTS=1 vitest --no-file-parallelism

# Server-importing CLI scripts need the server-only stub
node --import ./scripts/stub-server-only.mjs --import tsx scripts/cleanup-correlation-markers.ts
```

## Conventions

- Drivers are standalone `.mjs` files runnable directly by node. The success contract is exit code 0 plus a printed `RESULT: PASS`; failure is exit 1 with `✗ FAIL:` lines. Logging helpers are `ok()` / `note()` / `fail()`.
- Contract tests read the REAL scripts from disk with `readFileSync` (never a fixture) and pin exact declarations as text. If an edit changes a load-bearing line, the contract test goes red. This is the repo's contract-locked culture; see `scripts/verify-live-cleanup.test.ts` and `scripts/verify-live-voice.test.ts`.
- `verify-real-data.mjs` must use the client SDK for asserted CRUD and denial outcomes; the Admin SDK is cleanup-only for the asserted document lifecycle. Keep unique per-run document/user IDs, the canonical-project guard, emulator refusal, token-safe logging, signal handlers, and `finally` cleanup pinned by its real-file contract test.
- Cleanup guarantees are per driver, not blanket. `verify-live.mjs` and `drive-live-voice.mjs` implement the full exit-path guarantee (try/finally plus SIGINT/SIGTERM/unhandledRejection/uncaughtException handlers), pinned by their contract tests. `verify-live-local.mjs` guarantees its dev-server process-group teardown on every exit path, including SIGINT/SIGTERM handlers that kill the detached group so an interrupted run never orphans `next dev` on the port. `verify-live-emulator.mjs` tears its emulator/dev groups down on expected control paths only, not on signals. Other Chrome drivers kill Chrome and drop their profile on the handlers they register, and rename probe data to sweep-compatible prefixes, so an interrupted run's leftover is still caught by the next run's pre-run sweep.
- Sweeps touch ONLY probe-prefixed data (`verify-live-`, `verify-live-voice-`, or a `--probe-prefix` override). A real cooking session can never be archived or deleted. Concurrent runs get disjoint namespaces.
- The grace durations live per driver with a rationale comment at each declaration: `PROBE_GRACE_MS` (15 min, shared by verify-live and drive-live-voice and pinned lockstep by a contract test), `ORPHAN_GRACE_MS` (30 min, verify-live only, the [3c]→[4] gap), `STALE_SESSION_MS` (10 min, voice only). No shared constants module (spec 0002).
- Chrome drivers launch headless Chrome with a fresh user-data dir and CDP, drive real mouse events, run on a budgeted timeout, and print `RESULT: PASS`. The login-popup driver proves the OAuth popup opens with no `auth/unauthorized-domain`.
- Landing is PR-only. Branch protection requires validate, the Codex P1 gate, and (on pushes) the emulator-compare smoke, with strict up-to-date mode. `land-pr.mjs` never touches a main ref.
- Codex findings are resolved by the repo convention: fix the code, then reply `Resolved ...` on the finding's thread with `node scripts/reply-finding.mjs --pr <n> --comment <id>` (the reply must use the review-comments endpoint with the typed `in_reply_to` key; `in_reply_to_id` 422s and `issues/{n}/comments` never resolves a thread, both pinned by `scripts/reply-finding.test.ts`). The gate treats a finding as open until a human reply lands on it.
- If the Codex bot skips a PR (no review within the wait window and the nudge is inert), certify with the `CODEX_GATE_BOT_SKIPPED_PRS` repo variable listing the PR number, then push a synchronize event; delete the variable after merge. The nudge path needs the `CODEX_NUDGE_TOKEN` PAT (Contents read+write).
- The weekly `branch-tidy-weekly.yml` scan opens its report PR with the `WEEKLY_TIDY_TOKEN` PAT (repo scope), never `GITHUB_TOKEN`: a PR created with the runner token does NOT trigger the pull_request workflows, so the report PR would never run validate/gate and could not merge. The loud guard in the workflow fails the job on the canonical repo when the PAT is missing.
- A cancelled gate run can leave the merge evaluation stale (BLOCKED even when green, PR #113). A green gate in a canonical pull_request run self-heals it by re-running its own check through the Actions API (`actions: write`, no PAT); the re-run posts a fresh check run that re-evaluates the merge. Only run_attempt 1 self-heals, so the re-run itself cannot loop.
- `deploy:apphosting` runs `write-commit.mjs` first; the stamped `commit-sha.txt` is how the deployed build reports its real commit.
- `deploy_status/verify_live` is single-slot: the recorder overwrites the fixed doc on every run, so the status page always shows the newest verification — a newer deploy's verify replaces the previous record (the record step only runs when verify:live actually ran, so a skipped pre-flight never overwrites the last real result). `deploy_status/last_external` is the sticky companion: the recorder writes it ONLY when the verdict is `external` (the Gemini-credits block), so a later green run cannot erase the last outage — the /status page reads both and shows when the billing outage last hit.
- CLI scripts that import the server layer run under the `server-only` stub, never raw node.
- Voice Everywhere (spec 0004) uses browser Web Speech for transcription and browser SpeechSynthesis for output. It never round-trips through a model outside the existing cook-session path. Every voice control has a typed fallback and voice never auto-submits.
- Live voice UI proofs use the repository's raw-CDP driver helpers (`evaluate`, `ok`, `fail`); do not use Puppeteer `page.*` APIs unless the harness itself is migrated first.

## Gotchas

- Never change `PROBE_GRACE_MS` in only one driver: the shared value is a cross-file contract enforced by the lockstep test, and a silently weakened grace lets a concurrent run's sweep delete an in-flight probe (the `RECIPE_NOT_FOUND` relaunch failure this repo has actually seen).
- The weekly `deploy-health-weekly.yml` probe runs the identical post-deploy gate against the canonical host on a clock (Wednesdays 06:30 UTC), so deploy health is proven even on a week with no commits. It posts the verdict twice: a run summary step, then `record-verify-status.mjs` with `--source scheduled-weekly`, recording the sha the host SERVES (captured by its pre-flight smoke from `/api/build-info`), never the schedule trigger ref. Two weekly-probe specifics: the smoke FAILS the run when the served sha differs from the intended revision (`github.sha`) so the write-capable probe never runs against a stale host (same guarded-revision rule as post-deploy), and the verify command passes `--model-source-window-min 10080` (one week) so a warm host's startup `model_source` lines stay in scope — the 30-minute deploy-window default would fail all five roles on a no-deploy week. It shares the `live-voice-probe` concurrency group with ci.yml's verify-live job and mic-regression.yml so the three probes queue, never overlap.
- verify-live and drive-live-voice share the production owner, Firestore, and the probe namespace. Two overlapping runs are expected (deploy verify plus a manual re-run, or the weekly mic-regression monitor), so prefix and grace discipline is load bearing, not decoration.
- Never run write-capable production probes until `/api/build-info` reports the intended guarded revision and the unattested App Check preflight returns 403 `APP_CHECK_FAILED`; a stale SHA or 401 is a hard prerequisite blocker.
- An empty Codex comment list is NOT a clean review: the gate's WAITING fallback blocks until the bot reviews, nudges, or fails. Certify a bot-skip only after confirming the bot genuinely is not going to review.
- `CODEX_NUDGE_TOKEN` must be an Actions secret (repository or organization level), never an environment secret: the `codex-gate` job has no `environment:` block, so `secrets.CODEX_NUDGE_TOKEN` resolves only from the Actions secret scope. A Preview or Production environment secret can never satisfy the nudge, and the scope guard in `scripts/codex-review-pr-gate.test.ts` pins exactly that.
- The Gemini API prepayment-credits block (HTTP 429, `Your prepayment credits are depleted`) is an EXTERNAL failure, not a deploy regression: create_recipe fails and every stage that waits on a generated recipe cascades. verify-live classifies a run external (and passes the deploy check) only when the create_recipe root carries a credits signature AND every failure is a known Gemini cascade (`scripts/verify-live-classify.mjs`, pinned by `scripts/verify-live-classify.test.ts`). Top up credits at ai.studio/projects, then re-run verify:live. The classifier must stay conservative: a failure outside the cascade surface always stays FAIL.
- `land-pr.mjs` expects a dirty tree on the base branch. A change already committed locally needs the branch-off-the-commit pattern (create the branch from that commit) so its exact tree becomes the PR head.
- The App Hosting build excludes `.git`, so any script relying on `git rev-parse` fails there; use the `commit-sha.txt` stamp instead.
- Chrome drivers need Chrome installed on the runner; the login-popup proof requires a fresh profile so a cached SDK origin rejection can never hide a real config failure.

## Related specs

- [0001](docs/specs/0001-app-hosting-primary-host.md): Firebase App Hosting as the primary host; the deploy gates this area implements
- [0002](docs/specs/0002-probe-grace-constants-source-of-truth.md): the per-driver grace declarations and the lockstep contract test
- [0004](docs/specs/0004-voice-everywhere.md): browser Web Speech transcription + SpeechSynthesis output; the `drive-recipes-page.mjs`/`drive-kitchen.mjs` mic proofs pinned by `drive-voice-everywhere.test.ts`

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
