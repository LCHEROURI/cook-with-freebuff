# Scripts: deploy verification, the Codex review pipeline, and the landing path

## Overview

Everything that proves the deployed app and gates a merge. The verify:live drivers run a real end to end cooking flow against the deployed Firebase App Hosting host (and against local dev and the emulator) after every deploy; the Codex gate and monitor enforce that no PR merges with an unanswered bot finding; and land-pr.mjs automates the branch plus PR landing path. The area also carries the deploy-time SHA gates and the cleanup sweeps that keep probe data out of the production store.

## Key files

| File | Owns |
|---|---|
| `verify-live.mjs` | The main post-deploy E2E driver: stages [1] seed → [2] mint token → [2b] model resolution → [2c] login popup → [3] guided cook → [3c] settle → [3d]/[3e] UI and voice drivers → [4] agent turns, then cleanup. Exit 0 + `RESULT: PASS` is the contract |
| `verify-live-local.mjs` | Boots `next dev` on its own process group, warms lazily compiled routes, runs verify-live against localhost, always tears the group down in a finally block |
| `verify-live-emulator.mjs`, `verify-live-compare.mjs`, `verify-live-compare-emulator.mjs` | Emulator and guided-vs-live compare variants of the same check |
| `drive-*.mjs` | Headless Chrome drivers, one per UI proof: `drive-login-popup.mjs` ([2c] OAuth popup), `drive-starter-prefs.mjs` ([3d] ready card), `drive-live-voice.mjs` ([3e] Gemini Live dictation + active mics), `drive-recipes-page.mjs`, `drive-home-button.mjs`, `drive-ui-skin.mjs` |
| `verify-deployed-hash.mjs`, `verify-deployed-hash-gate.mjs`, `wait-for-deploy-sha.mjs`, `record-verify-status.mjs` | Deploy SHA gates: what the host is serving vs local HEAD, the push-time stale-guard, and recording verify results to `deploy_status` for the status page |
| `codex-review-pr-gate.mjs` | Required PR check: scans the bot's inline findings, blocks on open P0/P1, polls for the bot review, nudges and certifies per the conventions below |
| `codex-review-monitor.mjs` | Scheduled sweep that opens a labeled issue the first time a finding is seen, deduped by comment id |
| `land-pr.mjs` | One-command branch → PR → auto-merge landing path; refuses to push to main |
| `write-commit.mjs` | Stamps the git commit into `commit-sha.txt` before every apphosting deploy (the build zip excludes `.git`) |
| `cleanup-correlation-markers.ts` | Bounds the `correlation_markers` collection via the repository boundary, never raw Firestore |
| `stub-server-only.mjs` | Preload that makes `server-only` a no-op so CLI scripts can import the server repository layer under plain node + tsx |
| `emulator-test-helper.ts`, `fixtures/` | Emulator test infra and the `dictation-speech.wav` fixture used by the voice driver |

## Commands

```bash
# The verify family (from repo root, via package.json)
npm run verify:live                  # deployed host, full E2E
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
- Every driver cleans up on EVERY exit path: the flow runs inside try/finally and SIGINT/SIGTERM/unhandledRejection/uncaughtException all route through the same cleanup-then-exit helper.
- Sweeps touch ONLY probe-prefixed data (`verify-live-`, `verify-live-voice-`, or a `--probe-prefix` override). A real cooking session can never be archived or deleted. Concurrent runs get disjoint namespaces.
- The grace durations live per driver with a rationale comment at each declaration: `PROBE_GRACE_MS` (15 min, shared by verify-live and drive-live-voice and pinned lockstep by a contract test), `ORPHAN_GRACE_MS` (30 min, verify-live only, the [3c]→[4] gap), `STALE_SESSION_MS` (10 min, voice only). No shared constants module (spec 0002).
- Chrome drivers launch headless Chrome with a fresh user-data dir and CDP, drive real mouse events, run on a budgeted timeout, and print `RESULT: PASS`. The login-popup driver proves the OAuth popup opens with no `auth/unauthorized-domain`.
- Landing is PR-only. Branch protection requires validate, the Codex P1 gate, and (on pushes) the emulator-compare smoke, with strict up-to-date mode. `land-pr.mjs` never touches a main ref.
- Codex findings are resolved by the repo convention: fix the code, then reply `Resolved ...` on the finding's thread. The gate treats a finding as open until a human reply lands on it.
- If the Codex bot skips a PR (no review within the wait window and the nudge is inert), certify with the `CODEX_GATE_BOT_SKIPPED_PRS` repo variable listing the PR number, then push a synchronize event; delete the variable after merge. The nudge path needs the `CODEX_NUDGE_TOKEN` PAT (Contents read+write).
- `deploy:apphosting` runs `write-commit.mjs` first; the stamped `commit-sha.txt` is how the deployed build reports its real commit.
- CLI scripts that import the server layer run under the `server-only` stub, never raw node.

## Gotchas

- Never change `PROBE_GRACE_MS` in only one driver: the shared value is a cross-file contract enforced by the lockstep test, and a silently weakened grace lets a concurrent run's sweep delete an in-flight probe (the `RECIPE_NOT_FOUND` relaunch failure this repo has actually seen).
- verify-live and drive-live-voice share the production owner, Firestore, and the probe namespace. Two overlapping runs are expected (deploy verify plus a manual re-run, or the weekly mic-regression monitor), so prefix and grace discipline is load bearing, not decoration.
- An empty Codex comment list is NOT a clean review: the gate's WAITING fallback blocks until the bot reviews, nudges, or fails. Certify a bot-skip only after confirming the bot genuinely is not going to review.
- `land-pr.mjs` expects a dirty tree on the base branch. A change already committed locally needs the branch-off-the-commit pattern (create the branch from that commit) so its exact tree becomes the PR head.
- The App Hosting build excludes `.git`, so any script relying on `git rev-parse` fails there; use the `commit-sha.txt` stamp instead.
- Chrome drivers need Chrome installed on the runner; the login-popup proof requires a fresh profile so a cached SDK origin rejection can never hide a real config failure.

## Related specs

- [0001](docs/specs/0001-app-hosting-primary-host.md): Firebase App Hosting as the primary host; the deploy gates this area implements
- [0002](docs/specs/0002-probe-grace-constants-source-of-truth.md): the per-driver grace declarations and the lockstep contract test

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
