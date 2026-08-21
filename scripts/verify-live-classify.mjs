// ============================================================================
// scripts/verify-live-classify.mjs — classify verify:live failure sets.
//
// The post-deploy verify:live gate runs the full app surface after every
// deploy. Most failures are regressions and must redden the deploy check.
// One class is EXTERNAL and must not: the Gemini API prepayment-credits
// block (HTTP 429, "Your prepayment credits are depleted"). When that block
// hits, create_recipe fails, and every later stage that waits on a generated
// recipe (UI starter driver, constraints view, voice driver, agent model
// turn) cascades. Failing the deploy check for a billing issue is noise: the
// deployed app itself is healthy.
//
// The rule is deliberately CONSERVATIVE: the run is classified external ONLY
// when (a) the [3b] create_recipe failure itself carries a credits signature
// (the root cause), AND (b) EVERY failure matches a known Gemini-cascade
// prefix. Any failure outside that surface (a real serve/API/kitchen
// regression) flips the verdict back to FAIL, so the classification can never
// swallow a genuine app regression.
//
// The signature list is an explicit allowlist (same discipline as
// STALE_SOCKET_CODES in verify-live.mjs): the exact phrases observed in the
// field. The @google/generative-ai SDK embeds the API response body in its
// error message, so the deployed route surfaces
// "[429 Too Many Requests] Your prepayment credits are depleted…" verbatim.
// ============================================================================

// The exact depletion phrases observed in the Gemini API 429 response body
// (and the SDK error that embeds it). DELIBERATELY depletion specific: the
// generic quota status RESOURCE_EXHAUSTED is NOT here, because an unrelated
// quota failure (free tier, rate limit) must never trip the top-up-credits
// report. Each entry is load-bearing: deleting one flips its case back to
// FAIL, which the mutation test pins.
export const GEMINI_CREDITS_SIGNATURES = [
  'credits are depleted',
  'prepayment credits',
  'Your prepayment credits',
];

export const GEMINI_CREDITS_RE = new RegExp(
  GEMINI_CREDITS_SIGNATURES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

// Failure prefixes that the credits block explains. The [3b] root is
// `create_recipe →`; the rest wait on a generated recipe (starter UI,
// constraints view, voice driver), the [4] agent model turn, or the [4d]
// vision scan (a scan of any image also calls Gemini).
export const GEMINI_CASCADE_PREFIXES = [
  'create_recipe →',
  'UI starter driver',
  'no result after',
  'constraints view:',
  'live voice driver',
  'voice driver:',
  'model turn →',
  'vision scan →',
];

// The guard-spare failure (a genuinely live concurrent run's session inside
// LIVE_SESSION_GRACE_MS survived the archive retry, so THIS run failed loudly
// instead of yanking the other run's /cook session). It is an INTENTIONAL
// fail — a drill or an overlapping-run collision — not a regression, so the
// /status page can label it instead of showing a bare failure. Matched as a
// substring of the guard's `fail(...)` message, so the survivor names and idle
// age in the message never break the classification.
//
// This constant is the single source of truth for the spare path (mirror of
// SIMULATED_REGRESSION_SIGNATURE): verify-live.mjs embeds it in the guard's
// fail(...) message, the spare/regression comparators derive their FAIL_RE
// regexes from it via escapeRegExp, and the goldens embed it — so a reworded
// signature updates one constant and every producer/consumer tracks it.
export const SPARED_LIVE_SESSION_SIGNATURE =
  'ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry';

// The guard's NOTE line phrases the same blocker differently — it says
// "blocking the UI starter — archiving and retrying once" (the retry is
// upcoming), while the fail line says "after the archive retry" (the retry
// already failed). The shared prefix is the signature minus its " after the
// archive retry" tail, derived here so a reworded signature updates the note
// prefix in lockstep too.
export const BLOCKING_SESSION_PREFIX = SPARED_LIVE_SESSION_SIGNATURE.replace(
  ' after the archive retry',
  '',
);

// The seam's SIMULATED regression message — verify-live.mjs passes THIS
// constant to fail() when FORCE_VERIFY_LIVE_REGRESSION=true. It is the
// single source of truth for the drill's evidence shape: the seam
// (producer), the regression-drill comparator's SEAM_FAIL_RE (verifier), the
// classifier's no-mask tests, and the committed golden all derive from this
// one constant, so a reworded message can no longer silently diverge across
// files. The classifier's no-mask rule (`failures.length === 1`) sits next
// to it in the same module: a run carrying this message PLUS a spare is
// exactly the two-failure shape that must record reason=null.
export const SIMULATED_REGRESSION_SIGNATURE =
  'SIMULATED regression test — voice driver exercised with FORCE_VERIFY_LIVE_REGRESSION=true to prove sparing never masks a real failure';

/**
 * Classify a verify:live failure set into a verdict.
 *
 * @param {{ failures: string[] }} opts — the verify:live failure messages.
 * @returns {{ kind: 'pass' | 'external' | 'fail', reason?: 'spared-live-session' }}
 */
export function classifyVerifyVerdict({ failures }) {
  if (failures.length === 0) return { kind: 'pass' };
  const creditsRoot = failures.some(
    (m) => m.startsWith('create_recipe →') && GEMINI_CREDITS_RE.test(m),
  );
  const allCascades = failures.every((m) =>
    GEMINI_CASCADE_PREFIXES.some((p) => m.startsWith(p)),
  );
  if (creditsRoot && allCascades) return { kind: 'external' };
  // A spared-live-session failure is the ONLY failure in a drill/collision
  // run (the guard fails loudly, then the run reports it). If any OTHER
  // failure is present the run is a real regression — the reason must never
  // mask a genuine failure next to the spare.
  const sparedLive =
    failures.length === 1 && failures[0].includes(SPARED_LIVE_SESSION_SIGNATURE);
  if (sparedLive) return { kind: 'fail', reason: 'spared-live-session' };
  return { kind: 'fail' };
}
