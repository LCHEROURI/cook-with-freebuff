# 0002. Keep probe grace durations per driver with a lockstep contract test

**Date**: 2026-08-16
**Status**: Accepted

## Summary

Three probe cleanup durations guard the verify and voice drivers against deleting a concurrent run's live probe. Two of the three exist in only one driver; the shared fifteen minute seed grace exists in both. This decision keeps each duration declared in its own driver with an explanatory comment, and adds one contract test that asserts the shared value stays identical across the two files. No shared module, no import graph, no build step.

## Context

`verify-live.mjs` and `drive-live-voice.mjs` are standalone Node scripts. They share the production Firestore, the owner uid, and by convention the probe prefix scheme, so two runs with the same prefix can overlap (a deploy verify plus a manual re-run, or the weekly mic regression monitor plus a re-run). Each driver runs a pre-run sweep that archives orphaned probe sessions and deletes orphaned probe recipes. That sweep must never delete a live run's in-flight probe.

Three durations implement the guard. `PROBE_GRACE_MS` (15 minutes) exists in both drivers and protects the seed to launch window. `ORPHAN_GRACE_MS` (30 minutes) exists only in `verify-live.mjs` because its [3c] to [4] gap includes the minutes long Chrome driver stages. `STALE_SESSION_MS` (10 minutes) exists only in `drive-live-voice.mjs` as the idle threshold for "is this session still alive", matching the idle rule verify-live's settle already uses.

The consequences of drift are real and were observed in this repo: before the grace guards existed, a concurrent run's sweep deleted an in-flight seed and failed the relaunch with `RECIPE_NOT_FOUND`. The current code already carries the rationale comments at each declaration, landed in commit `37855a0`. What is missing is enforcement that the shared fifteen minute value cannot silently diverge between the two files.

This repo has no `docs/scope/` directory, so this is a standalone decision spec. The build approach is not recorded in `AGENTS.md` (marked TBD); the repo's de facto delivery pattern, stated in spec 0001, is contract-locked changes landed through branch plus PR, and this spec's small build plan follows it.

## Requirements

**User stories**:
- As a maintainer editing a probe grace duration, I want CI to fail if I change the shared seed grace in only one driver, so the concurrent-run guard never silently weakens.
- As a future driver author, I want to add a new probe-seeding driver without a build step or import graph, so it stays consistent with the standalone driver pattern.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: Each of the three grace durations is declared at its driver's top with a comment stating why the value exists and how it relates to the other durations.
- **AC-2**: A contract test reads both driver sources and asserts the `PROBE_GRACE_MS` declaration is identical in the two files, so drift fails CI.
- **AC-3**: Both drivers stay standalone `.mjs` scripts runnable by Node directly, with no new module, import, or build step.
- **AC-4**: The full test suite and typecheck pass after the change.

## Options considered

### Option 1: Shared constants module (single runtime source of truth)

Extract the three durations into one module (for example `scripts/probe-constants.mjs`) imported by both drivers.

**Pros**:
- One place to change; a value edit can never touch only one driver.
- Enforced by the runtime itself, not by a test.

**Cons**:
- Couples the standalone drivers through an import graph, which no other standalone script has.
- Only one of the three values is actually shared; the other two are driver specific, so the module is a weak single-value abstraction.
- Contradicts the deliberate "each driver is a self contained script" pattern and adds ceremony for a future driver author.

### Option 2: Per driver with rationale comments only (status quo after `37855a0`)

Keep each declaration in its own driver with the rationale comment, and nothing more.

**Pros**:
- Simplest option; zero coupling, zero new code.
- Matches the existing standalone style exactly.

**Cons**:
- Drift is caught only by review; nothing fails when the two fifteen minute values diverge.
- The exact hazard this decision exists to prevent (a silently weakened concurrent-run guard) has no automated backstop.

### Option 3: Per driver with rationale plus a lockstep contract test (chosen)

Keep each declaration in its own driver with the rationale comment, and add one cross-file contract assertion that the shared `PROBE_GRACE_MS` declaration is identical in both sources.

**Pros**:
- Single source of truth is enforced at CI time with zero runtime coupling.
- Matches this repo's contract-locked culture, where tests already pin the exact declarations of both drivers.
- A future driver is covered by extending the test's scanned file list by one line, no runtime ceremony.
- Reverts cleanly; deleting the test restores the status quo.

**Cons**:
- The value still physically exists in two files; an edit must change both (or the test fails).
- The assertion is a source-text scan, a heuristic, though it is the exact pattern the repo's other contract tests already use.

## Decision

**Chosen option**: Option 3: Per driver with rationale plus a lockstep contract test.

Keep each grace duration declared in its own driver with its rationale comment, and add one cross-file contract assertion that the `PROBE_GRACE_MS` declaration is identical in `verify-live.mjs` and `drive-live-voice.mjs`. Do not create a shared constants module.

## Rationale

The force that shaped this choice is that only one of the three durations is actually shared. A module built to hold one shared value and two driver specific values is an abstraction with weak cohesion, and it would introduce the first import graph between scripts that are deliberately standalone. The contract test delivers the property the module exists to provide (the shared value cannot drift) without paying the coupling cost, which fits how this repo already enforces its invariants: contract tests that read driver sources as text and pin exact declarations.

The drift hazard is not hypothetical. This repo experienced a concurrent run's sweep deleting an in-flight seed, failing the relaunch with `RECIPE_NOT_FOUND`, before the grace guards existed. The rationale comments (already shipped in `37855a0`) tell the next editor why the numbers differ; the lockstep test tells CI when they have drifted. Option 2 was rejected because it leaves the hazard with no automated backstop, and Option 1 because its coupling and weak cohesion are disproportionate for a single shared value.

## Design

The enforcement lives in `scripts/verify-live-cleanup.test.ts`, which already owns the sweep and grace contract for `verify-live.mjs`. Add one test that reads the `drive-live-voice.mjs` source the same way the suite reads its target source (as text) and asserts that the full `const PROBE_GRACE_MS = ...;` declaration line is identical in the two files. Asserting the full declaration, not just the numeric value, means a value change or a rename in one file fails loudly.

The existing per-file pins stay as they are: `verify-live-cleanup.test.ts` pins `verify-live.mjs`'s constants and `verify-live-voice.test.ts` pins the voice driver's. The new test only adds the cross-file equality; it does not replace either per-file contract.

## Build plan

1. Add the cross-file lockstep assertion to `scripts/verify-live-cleanup.test.ts` (reads both driver sources, asserts identical `PROBE_GRACE_MS` declarations), satisfies **AC-2**, **AC-3**
2. Run the verify contract tests and typecheck, then the full suite, satisfies **AC-4**
3. Land through the branch plus PR path under the required checks and confirm the deploy's verify:live passes, satisfies **AC-3**, **AC-4**

## Consequences

**Positive**:
- Drift of the shared seed grace fails CI instead of silently weakening the concurrent-run guard.
- No coupling is introduced; the standalone driver pattern is preserved.
- A future probe-seeding driver needs only a one line test update to be covered.

**Negative / tradeoffs**:
- The fifteen minute value still physically exists in two files; changing it means editing both places (or accepting a red CI).
- The lockstep assertion is a source-text scan, a heuristic rather than a compile time check, consistent with the repo's other contract tests but still a convention that must be maintained.

**Neutral**:
- The rationale comments shipped in `37855a0` already satisfy AC-1; the net-new work is the single lockstep test.
- This spec is a standalone decision record; with no `docs/scope/` it is the source of truth for the convention.

## Follow-up

- [ ] When a third probe-seeding driver appears, extend the lockstep test's scanned file list by one line and give the new driver the same rationale comment convention.
- [ ] Record the grace-constant convention in `AGENTS.md` via /sync once the lockstep test lands, since root `AGENTS.md` has no scripts-area convention yet.
