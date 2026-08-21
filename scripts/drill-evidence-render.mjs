// ─────────────────────────────────────────────────────────────────────────────
// scripts/drill-evidence-render.mjs — the ONE code path for the drill evidence
// lines (the guard's NOTE, spare-FAIL, archive-OK, seam-FAIL, and RESULT).
//
// Before this module existed, the same evidence shapes were re-implemented in
// four places: verify-live.mjs's guard embeds them in note(...)/fail(...)
// templates, each comparator re-derives them in expandNote/expandFail/expandOk
// and its seam/RESULT golden expectations, and verify-live-classify.test.ts
// re-derives them again to pin the goldens. A rename in one drifted silently
// from the others until a drill caught it.
//
// These renderers are the canonical shape: verify-live.mjs's producers embed
// the same constants (BLOCKING_SESSION_PREFIX, SPARED_LIVE_SESSION_SIGNATURE,
// SIMULATED_REGRESSION_SIGNATURE), the comparators REGENERATE through these
// renderers (so the extraction→regenerate→compare loop and the goldens share
// one code path), and the tests derive the golden placeholders from them. A
// reworded guard message is caught by the comparator's regex extraction AND
// by the source-template lockstep pins in verify-live-classify.test.ts, which
// assert verify-live.mjs's own templates render to exactly these lines.
//
// The renderers mirror the guard's renderers in verify-live.mjs:
//   note() prefixes "- ", fail() prefixes "✗ FAIL: ", ok() prefixes "  ✓ "
//   (the comparators trim leading whitespace, so the golden lines carry the
//   prefix without the indent).
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLOCKING_SESSION_PREFIX,
  SIMULATED_REGRESSION_SIGNATURE,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';

// The NOTE line — the guard prints it unconditionally on a blocker (idle in
// <IDLE>s), naming the sessions it is about to archive.
export const renderNoteLine = ({ n, id, phase, recipe, idle }) =>
  `- owner has ${n} ${BLOCKING_SESSION_PREFIX} — archiving and retrying once: ${id}… (${phase}, ${recipe}, ${idle}s idle)`;

// The spare-FAIL line — the guard prints it when the archive retry failed to
// clear the owner (a genuinely live session survived the grace).
export const renderSpareFailLine = ({ n, id, phase, recipe, idle }) =>
  `✗ FAIL: owner still has ${n} ${SPARED_LIVE_SESSION_SIGNATURE}: ${id}… (${phase}, ${recipe}, ${idle}s idle)`;

// The archive-OK line — the corrective path: the retry archived the blocking
// session(s) and the owner is clean before the UI starter.
export const renderArchiveOkLine = ({ n }) =>
  `✓ archived ${n} blocking session(s) — retried, owner is clean before the UI starter`;

// The seam-FAIL line — the FORCE_VERIFY_LIVE_REGRESSION seam's fixed message
// (fully static, no drill-run variants).
export const renderSeamFailLine = () => `✗ FAIL: ${SIMULATED_REGRESSION_SIGNATURE}`;

// The RESULT line — the verify:live RESULT print for a non-crash failure
// shape (the drill's two-failure proof).
export const renderResultLine = (failureCount) => `RESULT: FAIL (${failureCount})`;
