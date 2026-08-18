# CI failure history — the verify:live era (Aug 13 → Aug 18, 2026)

**How this was surfaced:** the `emulator-compare` sweep has been green in **104
of 105** runs — its only red was a CI timeout, never a divergence — so the six
`verify:live` failures below are the real reds in the pipeline's history. All
are resolved; the current state is green across every gate.

## The six verify:live failures

| # | Date (UTC) | Run | Head commit | Failure signature | Root cause | Fix |
|---|---|---|---|---|---|---|
| 1 | Aug 13 14:37 | `31711117339` | `a047934` (#17, App Hosting migration) | Every stage red: UI starter (no input/button), constraints view missing, `create_recipe` timeout after 120s, voice driver 420s timeout ×2 (dictation never filled, no LISTENING) | The post-deploy gate **debuted on the migration commit** — rollout teething of the job + drivers on the new host, not a product bug | Same-day hardening: #18 (apphosting.yaml → real project), #19 (settle stale tool-free sessions); 3rd run green at 16:24 |
| 2 | Aug 13 15:49 | `31717497070` | `04132a6` (#18) | Same teething pattern (starter, constraints, `create_recipe` timeout, voice driver exit 1) | Still the debut hour of verify:live | #19 + the #20–#28 series (auth-settle race, /api/status auth gating, pause/resume correctness) |
| 3 | Aug 17 13:21 | `32034641235` | `7f0a230` (#124, Voice Everywhere) | `create_recipe → 400 INTERNAL_ERROR [GoogleGenerativeAI Error]` → cascades: `create_recipe` timeout, voice LISTENING/dictation never reached, UI starter red | **Gemini prepayment credits depleted** — external billing outage | `a87615c` (#128) + `cd79cb6d`: `classifyVerifyVerdict` marks the run **EXTERNAL** only when the `create_recipe` root carries a credits signature **and** every failure is a known Gemini cascade; deploy check passes on external; verdict recorded for the status page. Credits topped up. |
| 4 | Aug 17 13:47 | `32036710667` | `ca24b09` (#125) | Identical credits signature | Same | Same (#128) |
| 5 | Aug 17 17:38 | `32051251192` | `f30ffb3` (#127) | Identical credits signature | Same — this run's head **predates** #128 (pushed before the classify commit) | Same (#128) |
| 6 | Aug 17 23:09 | `32079207486` | `72365c1` (#135, model_source log smoke) | New smoke stage red: `Cloud Logging read failed (HTTP 403 — the deploy SA lacks Cloud Logging…)` ×6 + `no log entry for role {conversation,generation,live-voice,validation,vision}` ×5. **Voice stage passed.** | **IAM role lag** — the smoke shipped before `roles/logging.viewer` propagated to the deploy SA | External grant of `roles/logging.viewer` (recorded live in #137); next push (23:22, `32080179684`) green |

### Confirmed from the archived run logs (Aug 18)

The three credits-classified runs carry a byte-identical failure set:

| Run | Head | Every failure line |
|---|---|---|
| `32034641235` 13:21 | `7f0a230` (#124, Voice Everywhere feature) | `create_recipe → 400 …` (root) · `UI starter driver → exit 1` · `no result after 120s (create_recipe did not return)` · `constraints view: missing…` ×4 · `live voice driver → exit 1` · `voice driver: missing “spoken prompt filled the input”` · `voice driver: missing “LISTENING state: mic aria-pressed”` |
| `32036710667` 13:47 | `ca24b09` (#125, **docs/spec only**) | identical |
| `32051251192` 17:38 | `f30ffb3` (#127, **test-only**) | identical |

Every line is on `GEMINI_CASCADE_PREFIXES` (the allowlist the classifier was
built from) and the root is the GoogleGenerativeAI SDK wrapping the generation
API response — truncated in the workflow log exactly where the credits body
begins:

    ✗ FAIL: create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:gen…

The untruncated shape is preserved in `verify-live-classify.test.ts` (whose
header names these deploys): `…generateContent: [429 Too Many Requests] Your
prepayment credits are depleted. Please go to AI Studio at
https://ai.studio/projects to manage your project and billing.`

Why this closes the loop:

- **Three unrelated heads, one identical signature.** A feature, a docs-only,
  and a test-only commit cannot share a code regression; an external billing
  block can.
- **The failing voice markers are exactly the Gemini-dependent ones.** The
  driver's dictation mic tapped, token minted, Live WebSocket connected, and
  `setupComplete` arrived — the plumbing worked — but `inputTranscription`
  never filled the input and the active-screen Live mic never reached
  LISTENING. (The phase-B typed-turn reply rendering ✓ is the agent's
  non-Live path and does not contradict the block; the classifier fixture
  from the same incident also records a credits-bearing `model turn →`.)
- **Recovery without an app change.** The next deploy (`72365c1` 23:09) ran
  the same driver on the same code with both previously-missing markers green
  (`spoken prompt filled the input` ✓, `LISTENING` ✓, `RESULT: PASS`); its
  run red only on the unrelated IAM log-smoke. The top-up, not a code fix,
  is what unblocked it.

## What each failure drove

1. **#1/#2 — made the post-deploy gate real on the new host.** The App Hosting
   migration landed the same hour verify:live first ran; the fixes (#17→#28)
   turned the debut-day reds into a gate that passed every push thereafter.
2. **#3/#4/#5 — taught the gate to tell a billing outage from a deploy
   regression.** The credits classifier is deliberately conservative: EXTERNAL
   only for the exact Gemini-credits cascade, everything else stays FAIL — so a
   model-provider billing block can no longer redden deploys, but still shows
   distinctly on the status page (and requires a top-up + re-run, per
   scripts/AGENTS.md).
3. **#6 — hardened the model-source proof.** The new smoke (deployed server's
   own Cloud Logging boot logs, proving `model_source=remote-config`) exposed
   the SA's missing log-reader role; the IAM grant became a documented
   prerequisite (scripts/AGENTS.md smoke row) and the stage has been green
   since.

## Companion red (not verify:live)

- **`31796143643` — Aug 14 11:25** — the only `emulator-compare` failure ever:
  the marker-atomicity emulator test hit vitest's 5s default on the slow CI
  runner (`Test timed out in 5000ms`, rollback-resume.emulator.test.ts:107).
  The gate did its job — **the deploy was blocked** — and the fix was `79fc460`
  (#71): an explicit 60s per-test timeout for both emulator suites.
- **`32055098612` — Aug 17 18:28** — run-level failure with **no retrievable
  jobs** (GitHub API anomaly; head `cd79cb6d`, the credits-classification
  follow-up). Sits in the same batch; the next run (18:41) went green.

## Current state

- verify:live voice stages: **77 clean / 82** since the drain-stuck fix (5 reds
  — all pre-burst teething/credits, **0 two-burst drops**); 166 clean two-burst
  checks, 0 drops.
- emulator-compare: **104/105 green**, marker-atomicity + pantry-turn compare
  both locked by the emulator suites.
- Every failure above has a distinct, documented root cause; none was a silent
  product regression, and each one strengthened a gate.
