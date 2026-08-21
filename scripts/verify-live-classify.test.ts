import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyVerifyVerdict,
  GEMINI_CASCADE_PREFIXES,
  GEMINI_CREDITS_SIGNATURES,
  SIMULATED_REGRESSION_SIGNATURE,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';

// ============================================================================
// scripts/verify-live-classify.test.ts — lock the Gemini-credits EXTERNAL
// classification in the post-deploy verify:live gate.
//
// When the Gemini API prepayment credits are depleted (HTTP 429, "Your
// prepayment credits are depleted"), create_recipe fails and every stage that
// waits on a generated recipe cascades (starter driver, constraints view,
// voice driver, agent model turn). That is a billing issue, not a deploy
// regression — the gate must report it EXTERNAL and pass the deploy check
// instead of reddening it (seen live on main deploys ca24b09 and f30ffb3:
// RESULT: FAIL (9) with the create_recipe root truncated at j()'s 160-char
// slice, hiding the true cause).
//
// Same discipline as the STALE_SOCKET_CODES allowlist in verify-live.mjs and
// the PROBE_GRACE_MS lockstep: the signatures are an explicit allowlist, and
// the mutation tests prove each entry is load-bearing (deleting one flips its
// case back to FAIL). The classifier is deliberately CONSERVATIVE — external
// only when the create_recipe root carries a credits signature AND every
// failure is a known cascade — so a real serve/API/kitchen regression can
// never be swallowed.
// ============================================================================

const LIVE = readFileSync('scripts/verify-live.mjs', 'utf8');

// The real shape the deployed route surfaced (the @google/generative-ai SDK
// embeds the API response body in its error message).
const creditsRoot = `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent: [429 Too Many Requests] Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing."}`;

const cascadeFailures = [
  creditsRoot,
  'UI starter driver → exit 1. Tail: typed the prompt',
  'no result after 120s (create_recipe did not return)',
  'constraints view: missing “details expanded (clicked the summary)” in the driver log',
  'constraints view: missing “constraint list shows “Servings: 4”” in the driver log',
  'live voice driver → exit 1. Tail: [6] Cleanup probe session + recipe',
  'voice driver: missing “spoken prompt filled the input” in the driver log',
  'voice driver: missing “LISTENING state: mic aria-pressed” in the driver log',
  'model turn → 400 {"code":"INTERNAL_ERROR","message":"credits"}',
];

describe('scripts/verify-live-classify.mjs · behavior', () => {
  it('classifies a credits-blocked run as EXTERNAL (root + every failure a Gemini cascade)', () => {
    expect(classifyVerifyVerdict({ failures: cascadeFailures }).kind).toBe('external');
  });

  it('passes an empty failure set', () => {
    expect(classifyVerifyVerdict({ failures: [] }).kind).toBe('pass');
  });

  it('labels a lone spared-live-session failure with the intentional-fail reason', () => {
    // The guard-spare drill (32229212858): the guard spared a genuinely live
    // session (inside LIVE_SESSION_GRACE_MS) and THIS run failed loudly naming
    // it. The verdict stays 'fail' (the run did fail) but the reason marks it
    // as intentional so the /status page can label it instead of a bare
    // failure. The survivor names + idle age in the message must not break the
    // classification.
    const spared = classifyVerifyVerdict({
      failures: [
        'owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      ],
    });
    expect(spared.kind).toBe('fail');
    expect(spared.reason).toBe('spared-live-session');
  });

  it('NEVER labels a spared-live-session failure as intentional when a real regression sits next to it', () => {
    // The reason exists to label a PURE drill/collision run. If any OTHER
    // failure is present the run is a real regression — the reason must never
    // mask a genuine failure next to the spare.
    const v = classifyVerifyVerdict({
      failures: [
        'owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
        'live voice driver → exit 1. Tail: boom',
      ],
    });
    expect(v.kind).toBe('fail');
    expect(v.reason).toBeUndefined();
  });

  it('NEVER labels the drill-injected simulated-regression shape as intentional', () => {
    // The third drill combines the spare path with FORCE_VERIFY_LIVE_REGRESSION,
    // which appends a second fail('SIMULATED regression test — voice driver
    // exercised with FORCE_VERIFY_LIVE_REGRESSION=true to prove sparing never
    // masks a real failure'). Classifying THIS shape with a reason would
    // silently mask a real regression that sits next to a spare. The
    // classifier must still return `{ kind: 'fail' }` with reason undefined.
    const v = classifyVerifyVerdict({
      failures: [
        'owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
        SIMULATED_REGRESSION_SIGNATURE,
      ],
    });
    expect(v.kind).toBe('fail');
    expect(v.reason).toBeUndefined();
  });

  it('NEVER swallows a real regression outside the Gemini cascade', () => {
    // A serve/API/kitchen failure next to the credits root stays FAIL.
    const v = classifyVerifyVerdict({
      failures: [creditsRoot, 'serve stage → HTTP 502 on /api/build-info'],
    });
    expect(v.kind).toBe('fail');
  });

  it('fails when the create_recipe root carries no credits signature (a real engine error)', () => {
    const v = classifyVerifyVerdict({
      failures: [
        'create_recipe → 400 {"code":"INTERNAL_ERROR","message":"recipe engine bug"}',
        'constraints view: missing “details expanded” in the driver log',
      ],
    });
    expect(v.kind).toBe('fail');
  });

  it('fails on cascade-only failures without the create_recipe credits root', () => {
    const v = classifyVerifyVerdict({
      failures: ['voice driver: missing “spoken prompt filled the input” in the driver log'],
    });
    expect(v.kind).toBe('fail');
  });

  it('keeps the credits phrase intact end to end even when it sits past the old 800-char cut', () => {
    // The jLong 800-char slice worked for the ~360-char SDK error seen live, but
    // that offset is not a contract. A deeper model id or a longer error body
    // pushes the depletion phrase past the cut; the [3b] root must serialize with
    // jFull (JSON.stringify, no slice) so the phrase still reaches
    // classifyVerifyVerdict and the run is EXTERNAL, not FAIL.
    const body = {
      code: 'INTERNAL_ERROR',
      message:
        '[GoogleGenerativeAI Error]: Error fetching from ' +
        `https://generativelanguage.googleapis.com/v1beta/models/${'m'.repeat(900)}:generateContent: ` +
        '[429 Too Many Requests] Your prepayment credits are depleted. ' +
        'Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
    };
    const serialized = JSON.stringify(body); // jFull: no slice
    expect(serialized).toContain('Your prepayment credits are depleted');
    expect(serialized.length).toBeGreaterThan(800);
    const root = `create_recipe → 400 ${serialized}`;
    expect(
      classifyVerifyVerdict({ failures: [root, 'voice driver: missing “x” in the driver log'] }).kind,
    ).toBe('external');
  });
});

describe('scripts/verify-live-classify.mjs · mutation-proof allowlists', () => {
  it('pins the credits signature allowlist — deleting any entry flips its case back to FAIL', () => {
    expect(GEMINI_CREDITS_SIGNATURES).toEqual([
      'credits are depleted',
      'prepayment credits',
      'Your prepayment credits',
    ]);
    // Each entry is load-bearing: a root that matches ONLY that signature
    // must classify external. Removing the entry from the allowlist (or
    // weakening the regex) fails this case.
    const rootsBySignature: Record<string, string> = {
      'credits are depleted': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... credits are depleted. Top up at ai.studio/projects."}`,
      'prepayment credits': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... Your prepayment credits are depleted."}`,
      'Your prepayment credits': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... Your prepayment credits are depleted. Please go to AI Studio."}`,
    };
    for (const sig of GEMINI_CREDITS_SIGNATURES) {
      const root = rootsBySignature[sig];
      expect(root, `missing synthetic root for signature “${sig}”`).toBeDefined();
      expect(
        classifyVerifyVerdict({ failures: [root, 'voice driver: missing “x” in the driver log'] }).kind,
        `signature “${sig}” must classify external`,
      ).toBe('external');
    }
  });

  it('REJECTS a generic quota status without a depletion phrase (a quota failure is NOT a credits block)', () => {
    // The generic RESOURCE_EXHAUSTED status (free-tier quota, rate limit) must
    // never trip the top-up-credits report — only depletion-specific phrases
    // classify external (Codex P1, PR #128 review).
    const genericQuotaRoot =
      'create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... status RESOURCE_EXHAUSTED — quota exceeded. Try again later."}'
    const v = classifyVerifyVerdict({
      failures: [genericQuotaRoot, 'voice driver: missing “x” in the driver log'],
    });
    expect(v.kind).toBe('fail');
  });

  it('pins the cascade prefix allowlist — a failure outside it stays FAIL', () => {
    expect(GEMINI_CASCADE_PREFIXES).toEqual([
      'create_recipe →',
      'UI starter driver',
      'no result after',
      'constraints view:',
      'live voice driver',
      'voice driver:',
      'model turn →',
      'vision scan →',
    ]);
  });

  it('pins the spared-live-session signature exactly so a typo/edit fails the suite', () => {
    expect(SPARED_LIVE_SESSION_SIGNATURE).toBe(
      'ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry',
    );
  });
});

describe('scripts/verify-live-classify.mjs · spared signature is mutation-proof', () => {
  it('every distinctive phrase of the spared signature is load-bearing — removing any flips the case back to plain fail', () => {
    // The signature is matched as a substring of the guard's fail(...) message
    // (`owner still has N ACTIVE/PAUSED session(s) blocking the UI starter
    // after the archive retry: …`). Every distinct phrase is load-bearing:
    // weakening any one (typo, rename, drop) silently turns a genuine
    // spared drill into a bare regression mislabel on the /status page.
    const sparedFailure =
      'owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)';
    expect(
      classifyVerifyVerdict({ failures: [sparedFailure] }).reason,
      'baseline spared failure must classify with reason spared-live-session',
    ).toBe('spared-live-session');

    const mutations: Array<{ name: string; mutated: string }> = [
      {
        name: 'drop "ACTIVE/PAUSED"',
        mutated: 'owner still has 1 session(s) blocking the UI starter after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      },
      {
        name: 'drop "blocking the UI starter"',
        mutated: 'owner still has 1 ACTIVE/PAUSED session(s) after the archive retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      },
      {
        name: 'drop "after the archive retry"',
        mutated: 'owner still has 1 ACTIVE/PAUSED session(s) blocking the UI starter: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s idle)',
      },
    ];
    for (const m of mutations) {
      const v = classifyVerifyVerdict({ failures: [m.mutated] });
      expect(v.kind, `${m.name}: kind must stay plain fail`).toBe('fail');
      expect(v.reason, `${m.name}: reason must NOT be spared-live-session`).toBeUndefined();
    }
  });
});

describe('scripts/verify-live.mjs · wiring (the gate actually uses the classification)', () => {
  it('imports classifyVerifyVerdict and computes the verdict in the finally block', () => {
    expect(LIVE).toContain("import { classifyVerifyVerdict, SIMULATED_REGRESSION_SIGNATURE } from './verify-live-classify.mjs';");
    expect(LIVE).toContain('verdict = runExit === 0 ? classifyVerifyVerdict({ failures }) : { kind: \'fail\' };');
  });

  it('the [3b] create_recipe failure carries the FULL untruncated body, not any slice', () => {
    // j() cuts at 160 and jLong() at 800; the credits signature's offset is not
    // contractually bounded, so the root must serialize with jFull (no slice) or
    // a longer SDK error hides the cause again (the exact bug the jLong fix only
    // papered over for the current ~360-char error).
    expect(LIVE).toContain('const jFull = (v) => JSON.stringify(v ?? null);');
    expect(LIVE).toContain(
      'fail(`create_recipe → ${starterCreated.status} ${jFull(starterCreated.body?.error ?? starterCreated.body)}`);',
    );
  });

  it('exits 0 on the external verdict and prints the distinct EXTERNAL report', () => {
    expect(LIVE).toContain('process.exit(verdict.kind === \'fail\' ? 1 : 0);');
    expect(LIVE).toContain('RESULT: EXTERNAL (Gemini credits — deploy check passes)');
    expect(LIVE).toContain('⚠ EXTERNAL: Gemini API prepayment credits are depleted (429)');
  });

  it('propagates the semantic verdict to the CI recorder via GITHUB_ENV (not the exit status)', () => {
    // P2 on PR #128: exiting 0 makes steps.verify.outcome == 'success', so the
    // recorder would persist 'success' and /status would claim full
    // verification. verify-live must forward the mapped verdict (external /
    // success / failure) through GITHUB_ENV for the record step to read.
    expect(LIVE).toContain("const recordVerdict = verdict.kind === 'pass' ? 'success' : verdict.kind === 'external' ? 'external' : 'failure';");
    expect(LIVE).toContain('process.env.GITHUB_ENV');
    expect(LIVE).toContain('writeFileSync(process.env.GITHUB_ENV');
  });

  it('has the FORCE_VERIFY_LIVE_REGRESSION drill seam right after the guard so spare + regression is exercisable end to end', () => {
    // The third drill injects a simulated real failure AFTER the pre-stage
    // guard, so the classifier receives failures.length === 2 (a spare +
    // the SIMULATED regression fail). A future edit that lets the guard fail
    // silently or moves the seam somewhere that wouldn't combine with the
    // spare would break the round-trip proof.
    const seamIdx = LIVE.indexOf('FORCE_VERIFY_LIVE_REGRESSION');
    expect(seamIdx).toBeGreaterThan(-1);
    // Must read the env var, branch on === 'true', and call fail() with the
    // SHARED constant — never a hard-coded literal (single source of truth;
    // the codegen contract below pins golden === constant).
    expect(LIVE).toContain("if (process.env.FORCE_VERIFY_LIVE_REGRESSION === 'true')");
    expect(LIVE).toContain('fail(SIMULATED_REGRESSION_SIGNATURE)');
    expect(LIVE).toContain("import { classifyVerifyVerdict, SIMULATED_REGRESSION_SIGNATURE } from './verify-live-classify.mjs';");
    // Position: must sit AFTER the guard's `fail(\`owner still has`, so a
    // spared live session can pair with the simulated regression. (The guard
    // block at the archive-retry path is the only producer of a spare failure.)
    const spareFailIdx = LIVE.indexOf('owner still has ');
    expect(spareFailIdx).toBeGreaterThan(-1);
    expect(seamIdx).toBeGreaterThan(spareFailIdx);
  });

  it('pins the third drill evidence shape — the source-produced spare + seam pair must record reason=null', () => {
    // The no-mask guarantee is a CONTRACT between the drill seam
    // (verify-live.mjs) and the classifier (verify-live-classify.mjs). The
    // seam message is the exported SIMULATED_REGRESSION_SIGNATURE (single
    // source of truth — the wiring pin above proves the seam passes THIS
    // constant to fail()); the guard's spare-fail template is extracted from
    // the source so a rename there is caught by the extraction itself.

    // 1. The seam message — the shared constant, by construction.

    // 2. The guard's spare-fail template — extracted verbatim and rendered
    //    with the real drill payload (run 32429029312: one live blocker at
    //    13s idle). The rendered line must still carry the load-bearing
    //    signature, or the pair would be unlabeled for the WRONG reason (a
    //    missed match instead of the no-mask rule).
    const guardMatch = LIVE.match(
      /fail\(`owner still has \$\{remaining\.length\} ACTIVE\/PAUSED session\(s\) blocking the UI starter after the archive retry: \$\{survivors\}`\)/,
    );
    expect(guardMatch, 'the guard spare-fail template must be present in verify-live.mjs').not.toBeNull();
    const spareLine = guardMatch![0]
      .replace('fail(`', '')
      .replace('`)', '')
      .replace('${remaining.length}', '1')
      .replace('${survivors}', 'drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 13s idle)');
    expect(spareLine).toContain(SPARED_LIVE_SESSION_SIGNATURE);

    // 3. Positive control: the rendered spare ALONE is a genuine spared
    //    failure. This proves the template is faithful — the pair below is
    //    unlabeled only BECAUSE a second failure sits next to it.
    expect(classifyVerifyVerdict({ failures: [spareLine] }).reason).toBe('spared-live-session');

    // 4. The third-drill shape: spare + simulated regression → plain fail,
    //    and the reason must be undefined — sparing NEVER masks a real
    //    failure. (Live drill 32429029312 recorded exactly this: RESULT:
    //    FAIL (2) → verdict failure, reason null.)
    const v = classifyVerifyVerdict({ failures: [spareLine, SIMULATED_REGRESSION_SIGNATURE] });
    expect(v.kind).toBe('fail');
    expect(v.reason).toBeUndefined();
  });
});

describe('scripts/verify-live-classify.mjs · the seam message is one source of truth (codegen)', () => {
  // The seam's SIMULATED message used to live as separate literals in
  // verify-live.mjs (the fail() call), guard-regression-drill.mjs (the
  // SEAM_FAIL_RE), the golden, and the tests — four copies that could
  // silently diverge. Now the exported constant is the single source of
  // truth; these pins prove every consumer derives from it and nothing
  // hard-codes a second copy.

  it('exports the exact SIMULATED regression message as the constant', () => {
    expect(SIMULATED_REGRESSION_SIGNATURE).toBe(
      'SIMULATED regression test — voice driver exercised with FORCE_VERIFY_LIVE_REGRESSION=true to prove sparing never masks a real failure',
    );
  });

  it('verify-live.mjs emits the constant — never a hard-coded literal', () => {
    // The seam must pass the exported constant to fail(). A future edit that
    // inlines the literal again (or rewords it here without updating the
    // constant) breaks this pin.
    expect(LIVE).toContain('fail(SIMULATED_REGRESSION_SIGNATURE)');
    expect(LIVE).toContain("import { classifyVerifyVerdict, SIMULATED_REGRESSION_SIGNATURE } from './verify-live-classify.mjs';");
    expect(LIVE).not.toContain("fail('SIMULATED regression test");
  });

  it('the regression comparator derives its seam regex from the constant', () => {
    const DRILL = readFileSync('scripts/guard-regression-drill.mjs', 'utf8');
    expect(DRILL).toContain("import { SIMULATED_REGRESSION_SIGNATURE } from './verify-live-classify.mjs';");
    // The regex must be built from the constant — not a hard-coded alternation
    // of the message. escapeRegExp + template literal is the canonical shape.
    expect(DRILL).toMatch(/escapeRegExp\(SIMULATED_REGRESSION_SIGNATURE\)/);
    expect(DRILL).not.toContain('SIMULATED regression test — voice driver exercised');
  });

  it('the committed golden seam line equals ✗ FAIL: + the constant', () => {
    const golden = readFileSync('scripts/__golden__/guard-regression-drill.txt', 'utf8');
    const seamLine = golden.split('\n').find((l) => l.includes('SIMULATED regression test'));
    expect(seamLine).toBe(`✗ FAIL: ${SIMULATED_REGRESSION_SIGNATURE}`);
  });

  it('the classifier no-mask rule and the seam constant live in the same module (one home for the drill shape)', () => {
    const CLASSIFY = readFileSync('scripts/verify-live-classify.mjs', 'utf8');
    expect(CLASSIFY).toContain('export const SIMULATED_REGRESSION_SIGNATURE');
    expect(CLASSIFY).toContain('failures.length === 1 && failures[0].includes(SPARED_LIVE_SESSION_SIGNATURE)');
    expect(CLASSIFY.indexOf('SIMULATED_REGRESSION_SIGNATURE')).toBeLessThan(CLASSIFY.indexOf('classifyVerifyVerdict'));
  });
});
