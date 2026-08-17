import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyVerifyVerdict,
  GEMINI_CASCADE_PREFIXES,
  GEMINI_CREDITS_SIGNATURES,
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
const creditsRoot = `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing."}`;

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
});

describe('scripts/verify-live-classify.mjs · mutation-proof allowlists', () => {
  it('pins the credits signature allowlist — deleting any entry flips its case back to FAIL', () => {
    expect(GEMINI_CREDITS_SIGNATURES).toEqual([
      'credits are depleted',
      'prepayment credits',
      'Your prepayment credits',
      'RESOURCE_EXHAUSTED',
    ]);
    // Each entry is load-bearing: a root that matches ONLY that signature
    // must classify external. Removing the entry from the allowlist (or
    // weakening the regex) fails this case.
    const rootsBySignature: Record<string, string> = {
      'credits are depleted': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... credits are depleted. Top up at ai.studio/projects."}`,
      'prepayment credits': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... Your prepayment credits are depleted."}`,
      'Your prepayment credits': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... Your prepayment credits are depleted. Please go to AI Studio."}`,
      'RESOURCE_EXHAUSTED': `create_recipe → 400 {"code":"INTERNAL_ERROR","message":"[GoogleGenerativeAI Error]: ... status RESOURCE_EXHAUSTED — quota exhausted."}`,
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

  it('pins the cascade prefix allowlist — a failure outside it stays FAIL', () => {
    expect(GEMINI_CASCADE_PREFIXES).toEqual([
      'create_recipe →',
      'UI starter driver',
      'no result after',
      'constraints view:',
      'live voice driver',
      'voice driver:',
      'model turn →',
    ]);
  });
});

describe('scripts/verify-live.mjs · wiring (the gate actually uses the classification)', () => {
  it('imports classifyVerifyVerdict and computes the verdict in the finally block', () => {
    expect(LIVE).toContain("import { classifyVerifyVerdict } from './verify-live-classify.mjs';");
    expect(LIVE).toContain('verdict = runExit === 0 ? classifyVerifyVerdict({ failures }) : { kind: \'fail\' };');
  });

  it('the [3b] create_recipe failure carries the FULL body, not the 160-char j() slice', () => {
    // j() truncates at 160 chars; the credits text lives ~250 chars in, so the
    // root failure must be built with jLong or the classifier can never see it
    // (the exact bug that hid the cause on the live failures).
    expect(LIVE).toContain('const jLong = (v) => JSON.stringify(v ?? null).slice(0, 800);');
    expect(LIVE).toContain(
      'fail(`create_recipe → ${starterCreated.status} ${jLong(starterCreated.body?.error ?? starterCreated.body)}`);',
    );
  });

  it('exits 0 on the external verdict and prints the distinct EXTERNAL report', () => {
    expect(LIVE).toContain('process.exit(verdict.kind === \'fail\' ? 1 : 0);');
    expect(LIVE).toContain('RESULT: EXTERNAL (Gemini credits — deploy check passes)');
    expect(LIVE).toContain('⚠ EXTERNAL: Gemini API prepayment credits are depleted (429)');
  });
});
