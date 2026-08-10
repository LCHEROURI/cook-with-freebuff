import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/ci-workflows.test.ts — lock the CI post-deploy surface contract.
//
// Mirrors the portfolio app's ci-workflows.test.ts discipline: read the REAL
// workflow files from disk (never fixtures) and assert the load-bearing
// steps still exist and are still gated on their secrets, so a future edit
// that silently drops a gate fails here instead of letting a green run
// masquerade as full verification.
//
// Architecture this locks (since 346e121): the push-triggered verify:live
// gate RACED the Vercel build (it often hit the previous deployment or a 502
// mid-deploy), so it was moved OUT of ci.yml into
// .github/workflows/verify-deployed.yml, which fires on Vercel's
// deployment_status event AFTER a successful production deploy. ci.yml keeps
// only the push-time validate contract; the LIVE contract lives in the
// post-deploy workflow. A future edit that reintroduces the racer into ci.yml
// (or drops the four-secret gating in verify-deployed.yml) fails here.
//
// Scope discipline (from the portfolio's vacuous-pass traps): assertions are
// scoped to job blocks where a job boundary exists, and the gating `if:` on
// each step is asserted too — an ungated step would still contain the script
// name, but would run where its secret is missing and the gate would silently
// no-op.
// ============================================================================

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const POST_DEPLOY = readFileSync('.github/workflows/verify-deployed.yml', 'utf8');

// The verify step's gating `if:` — the four secrets must ALL be present for
// the gate to run (a missing one skips-not-fails, but only on forks; the
// loud guard below turns that skip into a failure on production deploys).
const FOUR_SECRETS_GATE =
  "if: ${{ env.NEXT_PUBLIC_FIREBASE_API_KEY != '' && env.FIREBASE_SERVICE_ACCOUNT != '' && env.APP_OWNER_UID != '' && env.GOOGLE_AI_API_KEY != '' }}";
// Plain concatenation on purpose: a template literal containing the `${{`
// GitHub expression syntax would parse as a nested interpolation and throw.
const SECRET_WIRING = (name: string) => name + ': ${{ secrets.' + name + ' }}';

describe('.github/workflows/ci.yml · push-time validate contract', () => {
  // validate is now the ONLY job in ci.yml — the post-deploy gate moved out.
  // The block runs from the job key to end of file; a non-empty guard turns
  // a future restructure into a legible failure instead of confusing toContain
  // misses.
  const validateBlock = CI.slice(CI.indexOf('\n  validate:'));

  it('keeps the four push-time checks (typecheck · lint · test · build)', () => {
    expect(validateBlock.length).toBeGreaterThan(0);
    expect(validateBlock).toContain('name: Typecheck · Lint · Test · Build');
    expect(validateBlock).toContain('run: npm run typecheck');
    expect(validateBlock).toContain('run: npm run lint');
    expect(validateBlock).toContain('run: npm test');
    expect(validateBlock).toContain('run: npm run build');
    expect(validateBlock).toContain('timeout-minutes: 15');
  });

  it('does NOT run verify:live here anymore (the racer is gone — the gate moved to verify-deployed.yml)', () => {
    // The push-triggered verify:live job raced the Vercel build and was moved
    // to the deployment_status workflow (346e121). Reintroducing the racer —
    // a `run: npm run verify:live` line inside this file — fails here, so the
    // race bug can never silently return. The prose NOTE at the bottom of the
    // jobs section is what must document the move instead.
    expect(validateBlock).not.toContain('run: npm run verify:live');
    // The move must stay documented in the workflow, so a future edit that
    // re-adds the gate without consciously re-deciding fails here.
    expect(validateBlock).toContain('post-deploy verify:live gate NO LONGER lives here');
    expect(validateBlock).toContain('.github/workflows/verify-deployed.yml');
  });
});

describe('.github/workflows/verify-deployed.yml · deployment_status post-deploy gate', () => {
  it('triggers on deployment_status (+ workflow_dispatch) and only on successful production deploys with a URL', () => {
    expect(POST_DEPLOY).toMatch(/^on:\s*\n\s*deployment_status:/m);
    expect(POST_DEPLOY).toContain('workflow_dispatch:');
    expect(POST_DEPLOY).toContain("github.event_name == 'workflow_dispatch'");
    expect(POST_DEPLOY).toContain("github.event.deployment_status.state == 'success'");
    expect(POST_DEPLOY).toContain("github.event.deployment_status.environment == 'Production'");
    expect(POST_DEPLOY).toContain("github.event.deployment_status.target_url != ''");
  });

  it('still runs verify:live, gated on the four secrets', () => {
    // An ungated step would still contain the script name — the gating `if:`
    // is the load-bearing half. Dropping either fails here.
    expect(POST_DEPLOY).toContain('name: Verify deployed app end to end (verify:live)');
    expect(POST_DEPLOY).toContain('run: npm run verify:live');
    expect(POST_DEPLOY).toContain(FOUR_SECRETS_GATE);
  });

  it('wires all four secrets into the job env, the loud guard, AND the verify step env (3 wirings each)', () => {
    // Counting (not a bare toContain) catches a wiring dropped on any ONE of
    // the three places that need it: the job-level env (feeds the step `if`),
    // the loud-guard env, and the verify step's own env.
    for (const name of [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'FIREBASE_SERVICE_ACCOUNT',
      'APP_OWNER_UID',
      'GOOGLE_AI_API_KEY',
    ]) {
      expect(POST_DEPLOY.match(new RegExp(SECRET_WIRING(name).replace(/[$\\{\\}]/g, '\\$&'), 'g'))).toHaveLength(3);
    }
  });

  it('keeps the loud-secret guard so a missing secret fails instead of silently skipping', () => {
    // The gated steps skip-not-fail when a secret is absent; the loud guard
    // is what stops that skip from masquerading as a green post-deploy check
    // on a real production deploy. It must cover ALL five secrets (the four
    // verify credentials + VERCEL_TOKEN for the hash gate). Manual
    // workflow_dispatch re-runs stay exempt (operator-initiated, skipped steps
    // are visible to the operator).
    expect(POST_DEPLOY).toContain('name: Fail loudly if a verify secret is missing (production deploy)');
    expect(POST_DEPLOY).toContain('::error::Required GitHub Actions secret(s) missing on production deploy:');
    expect(POST_DEPLOY).toContain("github.event_name != 'workflow_dispatch'");
    expect(POST_DEPLOY).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(POST_DEPLOY).toContain("env.APP_OWNER_UID == ''");
    expect(POST_DEPLOY).toContain("env.VERCEL_TOKEN == ''");
    expect(POST_DEPLOY).toContain('exit 1');
  });

  it('still resolves the deployment commit and matches it to the pushed head (hash gate)', () => {
    // The exact-deployment assertion: the deployment the event describes
    // (target_url) must record the commit the push recorded (deployment.sha —
    // a TOP-level event field). Dropping the step — or the --expect wiring —
    // would let a build Vercel serves that isn't the pushed head go green.
    expect(POST_DEPLOY).toContain('name: Verify deployed commit matches the pushed head');
    expect(POST_DEPLOY).toContain('node scripts/verify-deployed-hash.mjs');
    expect(POST_DEPLOY).toContain('--url "${{ github.event.deployment_status.target_url }}"');
    expect(POST_DEPLOY).toContain('--expect "${{ github.event.deployment.sha }}"');
    // Gated on VERCEL_TOKEN and only meaningful on real deploy events (no
    // deployment_status context exists for a manual dispatch).
    expect(POST_DEPLOY).toContain("if: ${{ env.VERCEL_TOKEN != '' && github.event_name != 'workflow_dispatch' }}");
    // Block-scalar run: a plain scalar would fold the trailing backslash-newline
    // into a literal backslash-space and the script would never parse --url.
    expect(POST_DEPLOY).toContain('run: |');
  });

  it('keeps the alias-routing drift watch proving the canonical URL serves the same commit', () => {
    // The user-facing contract: "the canonical URL serves the commit the
    // deployment_status event describes" — proven by comparing the canonical
    // alias's deployment against the deployment-specific target_url.
    expect(POST_DEPLOY).toContain('name: Alias-routing drift watch (production)');
    expect(POST_DEPLOY).toContain('--compare-url "https://cook-with-freebuff.vercel.app"');
    expect(POST_DEPLOY).toContain("if: ${{ env.VERCEL_TOKEN != '' && github.event_name != 'workflow_dispatch' }}");
  });

  it('wires VERCEL_TOKEN into the job env, the loud guard, and BOTH hash steps (4 wirings)', () => {
    // Counting (not a bare toContain) catches a wiring dropped on any ONE of
    // the four places that need it: job env (feeds step `if`s), loud-guard
    // env, and the two hash steps' envs.
    expect(POST_DEPLOY.match(new RegExp(SECRET_WIRING('VERCEL_TOKEN').replace(/[$\{\}]/g, '\\$&'), 'g'))).toHaveLength(4);
  });

  it('targets the public canonical production URL (deployment subdomains are Vercel-protected)', () => {
    // The deployment-specific target_url 401s with "Protected deployment";
    // the canonical alias is public and the event ordering (job starts only
    // after a successful production deploy, checkout + npm ci outlast the
    // alias promotion) still guarantees verify:live exercises the new build.
    expect(POST_DEPLOY).toContain('VERIFY_BASE_URL: https://cook-with-freebuff.vercel.app');
    // The decision must stay documented, so a future edit that re-targets a
    // protected URL without re-deciding fails here.
    expect(POST_DEPLOY).toContain('Deployment Protection');
  });

  it('keeps the run-safety envelope (concurrency, 10-minute budget, Node 22)', () => {
    expect(POST_DEPLOY).toContain('group: verify-deployed-${{ github.ref }}');
    expect(POST_DEPLOY).toContain('cancel-in-progress: false');
    expect(POST_DEPLOY).toContain('timeout-minutes: 10');
    expect(POST_DEPLOY).toMatch(/node-version: 22/);
  });
});
