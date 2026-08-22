import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/ci-workflows.test.ts — lock the CI deploy + verify surface contract.
//
// Mirrors the portfolio app's ci-workflows.test.ts discipline: read the REAL
// workflow files from disk (never fixtures) and assert the load-bearing
// steps still exist and are still gated correctly, so a future edit that
// silently drops a gate fails here instead of letting a green run masquerade
// as full verification.
//
// Architecture this locks (the App Hosting primary migration): the post-deploy
// verify:live gate lives in ci.yml as a needs-edge of deploy-apphosting —
// it runs in the SAME run as the deploy, so it can never race the host build
// the way the old event-driven workflow could. The first step polls the host's
// /api/build-info (tokenless) until it serves the pushed commit, then the
// post-deploy smoke and verify:live run against that host. verify-deployed.yml
// (the Vercel deployment_status workflow) is deleted, and every gate is
// tokenless — VERCEL_TOKEN appears nowhere.
//
// Scope discipline (from the portfolio's vacuous-pass traps): assertions are
// scoped to job blocks where a job boundary exists, and the gating `if:` on
// each step is asserted too.
// ============================================================================

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const MIC_REGRESSION = readFileSync('.github/workflows/mic-regression.yml', 'utf8');
const CODEX_MONITOR = readFileSync('.github/workflows/codex-review-monitor.yml', 'utf8');
const SPARE_DRILL_NIGHTLY = readFileSync('.github/workflows/spare-drill-nightly.yml', 'utf8');
const GUARD_DRILLS_WEEKLY = readFileSync('.github/workflows/guard-drills-weekly.yml', 'utf8');
const BRANCH_TIDY = readFileSync('.github/workflows/branch-tidy-weekly.yml', 'utf8');
const COMPARE_WEEKLY = readFileSync('.github/workflows/compare-live-weekly.yml', 'utf8');

// The verify step's gating `if:` — the five inputs must ALL be present for
// the deep gates to run (a missing one skips-not-fails, but only on forks;
// the loud guard below turns that skip into a failure on main deploys).
const FIVE_INPUTS_GATE =
  "if: ${{ env.NEXT_PUBLIC_FIREBASE_API_KEY != '' && env.FIREBASE_SERVICE_ACCOUNT != '' && env.APP_OWNER_UID != '' && env.GOOGLE_AI_API_KEY != '' && env.NEXT_PUBLIC_FIREBASE_APP_ID != '' }}";
// Plain concatenation on purpose: a template literal containing the `${{`
// GitHub expression syntax would parse as a nested interpolation and throw.
const SECRET_WIRING = (name: string) => name + ': ${{ secrets.' + name + ' }}';

describe('.github/workflows/ci.yml · push-time validate contract', () => {
  // validate is the FIRST job in ci.yml; the emulator-compare smoke is the
  // SECOND. The block runs from the validate key to the emulator-compare key
  // so the smoke job's push-gated steps are never read as part of validate; a
  // non-empty guard turns a future restructure into a legible failure instead
  // of confusing toContain misses.
  const smokeStart = CI.indexOf('\n  emulator-compare:');
  const validateBlock = CI.slice(CI.indexOf('\n  validate:'), smokeStart === -1 ? undefined : smokeStart);

  it('runs the ONE canonical local gate (npm run check) so CI and local validate identically', () => {
    expect(validateBlock.length).toBeGreaterThan(0);
    expect(validateBlock).toContain('name: Typecheck · Lint · Test · Build');
    // The whole validate surface is one command — the same `npm run check` an
    // engineer runs locally (typecheck → lint → test → build), so a green
    // local check means a green validate job and vice versa. The four checks
    // must never drift back into separate steps with different flags.
    expect(validateBlock).toContain('run: npm run check');
    expect(validateBlock).not.toContain('run: npm run typecheck');
    expect(validateBlock).not.toContain('run: npm run lint');
    expect(validateBlock).not.toContain('run: npm test');
    expect(validateBlock).not.toContain('run: npm run build');
    expect(validateBlock).toContain('timeout-minutes: 15');
  });

  it('does NOT run verify:live as a validate STEP (it is its own needs-edge job)', () => {
    // verify:live is a separate job after deploy-apphosting — it must never
    // come back as a validate step (that was the original racer shape).
    expect(validateBlock).not.toContain('run: npm run verify:live');
    expect(validateBlock).not.toContain('wait-for-deploy-sha');
  });

  it('runs the push-time stale-head guard TOKENLESS, on push only', () => {
    // The push-time stale-head protection: verify-deployed-hash with
    // --stale-guard (direction-aware — a forward push passes, only a
    // rollback/diverged HEAD fails) so a stale push fails CI before the
    // deploy even starts. The gating `if:` is the load-bearing half: the step
    // must run ONLY on `push` events (a PR head is legitimately behind live
    // main and would falsely block), and it must need NO token — the live
    // commit comes from the host's public /api/build-info.
    expect(validateBlock).toContain('name: Verify pushed head is not stale vs live (stale-guard)');
    expect(validateBlock).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard');
    expect(validateBlock).toContain("if: ${{ github.event_name == 'push' }}");
    // Negative: no secret gate, no loud guard, no VERCEL_TOKEN anywhere.
    expect(validateBlock).not.toContain('VERCEL_TOKEN');
    expect(validateBlock).not.toContain('Fail loudly if VERCEL_TOKEN is missing');
  });

  it('keeps the PR stale-guard step strictly PR-only, tokenless, and pinned to the PR head', () => {
    const prStepStart = validateBlock.indexOf('name: Verify PR head is not stale vs live (stale-guard)');
    const prStepEnd = validateBlock.indexOf('\n  #', prStepStart);
    const prStepBlock = validateBlock.slice(prStepStart, prStepEnd === -1 ? undefined : prStepEnd);
    expect(prStepBlock.length).toBeGreaterThan(0);
    expect(prStepBlock).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard --head "${{ github.event.pull_request.head.sha }}"');
    // Tokenless like the push step; canonical-repo only (a fork's origin does
    // not carry the live commit on upstream main, so the ancestry check
    // cannot run there).
    expect(prStepBlock).toContain("if: ${{ github.event_name == 'pull_request' && github.repository == 'LCHEROURI/cook-with-freebuff' }}");
    expect(prStepBlock).not.toContain('VERCEL_TOKEN');
    // Negative locks: the PR step must not be push-gated and must not run
    // without --head (a --head-less copy would compare against the checkout
    // HEAD — the merge ref — and make every stale PR pass).
    expect(prStepBlock).not.toMatch(/github\.event_name\s*==\s*'push'/);
    expect(prStepBlock).not.toMatch(/verify-deployed-hash-gate\.mjs --stale-guard$/m);
  });

  it('keeps the stale-guard step strictly push-only — it can never fire on pull_request', () => {
    expect(CI).toContain('pull_request:'); // validate still runs on PRs
    // Exactly ONE push-time stale-guard invocation (no --head) in validate.
    expect(validateBlock.match(/verify-deployed-hash-gate\.mjs --stale-guard$/m)).toHaveLength(1);

    const stepStart = validateBlock.indexOf('name: Verify pushed head is not stale vs live (stale-guard)');
    const prStart = validateBlock.indexOf('\n      # PR-time stale-head guard');
    const stepEnd = prStart === -1 ? undefined : prStart;
    const stepBlock = validateBlock.slice(stepStart, stepEnd);
    expect(stepBlock).toContain("if: ${{ github.event_name == 'push' }}");
    // Negative locks: no literal pull_request, no negated event gate, and no
    // other event name — the ONLY event this step can ever run on is push.
    expect(stepBlock).not.toContain('pull_request');
    expect(stepBlock).not.toMatch(/github\.event_name\s*!==?[=]?\s*'/);
    expect(stepBlock).not.toContain('workflow_dispatch');
    expect(stepBlock).not.toContain('deployment_status');
  });

  it('has NO VERCEL_TOKEN anywhere in ci.yml (the whole file is tokenless)', () => {
    // The App Hosting primary migration removed the last Vercel dependency
    // from the push pipeline. Any VERCEL_TOKEN return fails here.
    expect(CI).not.toContain('VERCEL_TOKEN');
    expect(CI).not.toContain('vercel.app');
  });
});

describe('.github/workflows/ci.yml · deploy-apphosting job', () => {
  // App Hosting is the PRIMARY production host; this job deploys after
  // validate passes, authenticating with a FIREBASE_TOKEN refresh token from
  // `firebase login:ci` (OWNER auth) — `firebase deploy --only apphosting`
  // provisions resources that need owner-level IAM, which the restricted
  // Admin SDK SA must never be widened to.
  const deployStart = CI.indexOf('\n  deploy-apphosting:');
  const deployBlock = CI.slice(deployStart, CI.indexOf('\n  verify-live:'));

  it('deploys after validate AND the emulator-compare smoke pass — real main pushes only, never PRs or queue branches', () => {
    expect(deployBlock.length).toBeGreaterThan(0);
    expect(deployBlock).toContain('name: Deploy Firebase App Hosting');
    expect(deployBlock).toContain('needs: [validate, emulator-compare]');
    expect(deployBlock).toContain("(github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch'");
    expect(deployBlock).not.toContain('pull_request');
    expect(deployBlock).toContain('refs/heads/main');
  });

  it('triggers on the merge-queue branches so queued PRs run the required checks', () => {
    expect(CI).toContain("branches: [main, 'gh-readonly-queue/**']");
  });

  it('authenticates with a FIREBASE_TOKEN (owner login:ci) and stamps the commit', () => {
    expect(deployBlock).toContain('FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}');
    expect(deployBlock).toContain('node scripts/write-commit.mjs');
    expect(deployBlock).toContain('npx -y firebase-tools@latest deploy --only apphosting --non-interactive --project portfolio-app-freebuff2');
    expect(deployBlock).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
    // FIREBASE_SERVICE_ACCOUNT is present in the job env now (it drives the
    // authorize-domain step), but it must never be what AUTHENTICATES the
    // deploy — the deploy step onward stays FIREBASE_TOKEN only.
    const deployStepStart = deployBlock.indexOf('name: Deploy to Firebase App Hosting');
    const deployStepBlock = deployBlock.slice(deployStepStart);
    expect(deployStepBlock).not.toContain('FIREBASE_SERVICE_ACCOUNT');
  });

  it('authorizes the canonical host for Firebase Auth (idempotent self-heal) on every deploy', () => {
    // The App Hosting migration added scripts/authorize-domain.mjs but never
    // ran it against production, so the canonical host fell out of the
    // project's authorized domains and Google sign-in broke with
    // auth/unauthorized-domain. The step runs the idempotent script (GET the
    // config, PATCH only when missing) on every deploy so the host self-heals
    // and a future domain drop cannot silently break sign-in again.
    expect(deployBlock).toContain('name: Authorize the canonical host for Firebase Auth');
    expect(deployBlock).toContain('run: npm run authorize:domain');
    expect(deployBlock).toContain('FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
    // Gated on the credential (skip-not-fail on forks / unconfigured repos);
    // canonical main pushes cannot skip it silently because emulator-compare
    // (a needs-edge) already fails loudly when the SA is missing there.
    expect(deployBlock).toContain("if: ${{ env.FIREBASE_SERVICE_ACCOUNT != '' }}");
  });

  it('runs the emulator-compare smoke before the deploy with Java 21 + owner creds', () => {
    const smokeStart = CI.indexOf('\n  emulator-compare:');
    expect(smokeStart).toBeGreaterThan(0);
    const smokeBlock = CI.slice(smokeStart, CI.indexOf('\n  deploy-apphosting:', smokeStart));
    expect(smokeBlock).toContain('name: Emulator-compare smoke (guided flow vs live)');
    expect(smokeBlock).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    expect(smokeBlock).not.toContain('pull_request');
    expect(smokeBlock).toContain('actions/setup-java@v5');
    expect(smokeBlock).toContain("java-version: '21'");
    expect(smokeBlock).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
    expect(smokeBlock).toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(smokeBlock).toContain('APP_OWNER_UID');
    expect(smokeBlock).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(smokeBlock).toContain('npm run verify:live:compare:emulator');
  });

  it('retries the deploy on a 409 queue-conflict with backoff (never on other errors)', () => {
    expect(deployBlock).toContain('unable to queue the operation');
    expect(deployBlock).toContain("grep -qE '409|unable to queue the operation'");
    expect(deployBlock).toContain('max_attempts=5');
    expect(deployBlock).toContain('wait_s=$((attempt * 30))');
    expect(deployBlock).toContain('sleep "$wait_s"');
    expect(deployBlock).toContain('attempt=$((attempt + 1))');
    expect(deployBlock).toContain('still 409-conflicted after');
    expect(deployBlock).toContain('non-409 error');
  });

  it('gates on FIREBASE_TOKEN with a loud guard on the canonical repo', () => {
    expect(deployBlock).toContain('name: Fail loudly if FIREBASE_TOKEN is missing (main push)');
    expect(deployBlock).toContain("env.FIREBASE_TOKEN == ''");
    expect(deployBlock).toContain('FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}');
  });

  it('reports whether a rollout actually ran so verify-live can skip when it did not', () => {
    // The deploy STEP is skipped (not failed) when FIREBASE_TOKEN is missing;
    // the job still succeeds. The `deployed` output lets verify-live skip that
    // case instead of polling the canonical host for a sha that never arrives.
    expect(deployBlock).toContain("outputs:\n      deployed: ${{ steps.deploy.outcome == 'success' }}");
    expect(deployBlock).toContain('id: deploy');
    expect(deployBlock).toContain('if: ${{ env.FIREBASE_TOKEN != \'\' }}');
  });
});

// The string-input contract for the force_verify_live_regression drill
// input, factored out so the mutation drill below can prove it FAILS on a
// reverted boolean input by invoking this exact assertion (same discipline
// as the verify-live-cleanup mutation proofs — an independent check would
// keep passing if this assertion were later weakened or removed).
const expectStringDrillInput = (workflowSource: string) => {
  const inputsBlock = workflowSource.slice(workflowSource.indexOf('workflow_dispatch:'));
  const inputsEnd = inputsBlock.indexOf('\nconcurrency:');
  const inputs = inputsBlock.slice(0, inputsEnd);
  expect(inputs).toContain('force_verify_live_regression:');
  // String input (NOT type: boolean) so `inputs.force_verify_live_regression == 'true'`
  // matches under every dispatch method — a boolean-typed input exposes a JSON
  // boolean and `true == 'true'` is false in GitHub expressions, which left the
  // env empty in all three dispatch attempts (32266697726/32267874575/32268919307).
  expect(inputs).not.toMatch(/type: boolean/);
  expect(inputs).toMatch(/default: 'false'/);
};

// The env-threading contract for the FORCE_VERIFY_LIVE_REGRESSION drill env,
// factored out so the mutation drill below can prove it FAILS on a hard-coded
// or dropped-input mutation by invoking this exact assertion (same discipline
// as expectStringDrillInput — an independent check would keep passing if this
// assertion were later weakened or removed).
const expectDrillEnvThreading = (workflowSource: string) => {
  const verifyStepStart = workflowSource.indexOf('name: Verify deployed app end to end (verify:live)');
  const verifyStepEnd = workflowSource.indexOf('\n      - name:', verifyStepStart + 1);
  const verifyStep = workflowSource.slice(verifyStepStart, verifyStepEnd === -1 ? workflowSource.length : verifyStepEnd);
  expect(verifyStep).toContain('FORCE_VERIFY_LIVE_REGRESSION');
  // The env must READ inputs.force_verify_live_regression — never a literal.
  expect(verifyStep).toMatch(/FORCE_VERIFY_LIVE_REGRESSION:\s*\$\{\{\s*inputs\.force_verify_live_regression/);
  // Must default to empty string so the seam stays inert on push runs.
  expect(verifyStep).toMatch(/==\s*'true'\s*&&\s*'true'\s*\|\|\s*''/);
};

describe('.github/workflows/ci.yml · post-deploy verify:live needs-edge', () => {
  // verify:live moved INTO ci.yml as a needs-edge of deploy-apphosting (the
  // App Hosting primary migration). Because `firebase deploy --only
  // apphosting` can return while the rollout is still building, the gate's
  // first step polls /api/build-info until the host serves the pushed commit
  // — the gate PROVES the target serves your commit before exercising it.
  const verifyStart = CI.indexOf('\n  verify-live:');
  const verifyBlock = CI.slice(verifyStart);

  it('runs in the same CI run as the deploy, only after a rollout actually started', () => {
    expect(verifyBlock.length).toBeGreaterThan(0);
    expect(verifyBlock).toContain('name: Verify deployed app after deploy (verify:live)');
    expect(verifyBlock).toContain('needs: [deploy-apphosting]');
    // deploy-apphosting only runs on real main pushes + workflow_dispatch; a
    // skipped or failed deploy skips this job too. On top of the needs edge,
    // the job is gated on the deploy job's `deployed` output so a fork or
    // secretless dispatch (deploy step skipped, job still success) skips
    // verification instead of polling the canonical host for 15 minutes and
    // failing. Never `if: always()` — that would run it after a failed deploy.
    const jobHeader = verifyBlock.slice(0, verifyBlock.indexOf('\n    steps:'));
    expect(jobHeader).toContain("if: ${{ needs.deploy-apphosting.outputs.deployed == 'true' }}");
    expect(jobHeader).not.toContain('always()');
    expect(jobHeader).not.toContain('if: ${{ always() }}');
    // 45 minutes: the SHA poll can consume up to 15 of the budget on a slow
    // rollout, and verify:live itself is documented for 20-30 minute runs — a
    // 30-minute cap could cancel a healthy verification mid-flight.
    expect(verifyBlock).toContain('timeout-minutes: 45');
  });

  it('waits for the App Hosting rollout to serve the pushed commit BEFORE anything else', () => {
    // The wait-for-sha step is the load-bearing half of the migration: it
    // converts the old event-trust (deployment_status fired → assume the
    // build is ready) into proof (the host's build-info reports github.sha).
    expect(verifyBlock).toContain('name: Wait for the App Hosting rollout to serve the pushed commit');
    expect(verifyBlock).toContain('node scripts/wait-for-deploy-sha.mjs --url "https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app" --expect "${{' + ' github.sha }}"');
    // Tokenless — the wait step itself must carry no secret wiring and no
    // secret-gated `if:` (the job env has secrets for the steps below, but
    // the wait step needs none).
    const waitStart = verifyBlock.indexOf('wait-for-deploy-sha.mjs');
    const waitStepEnd = verifyBlock.indexOf('\n\n      # Post-deploy smoke');
    const waitStep = verifyBlock.slice(verifyBlock.lastIndexOf('\n      - name: Wait', waitStart), waitStepEnd);
    expect(waitStep).not.toContain('secrets.');
    expect(waitStep).not.toMatch(/if: \$\{\{/);
    // It must precede the smoke and verify:live steps.
    const smokeStart = verifyBlock.indexOf('name: Post-deploy smoke');
    const verifyStepStart = verifyBlock.indexOf('name: Verify deployed app end to end (verify:live)');
    expect(waitStart).toBeGreaterThan(-1);
    expect(smokeStart).toBeGreaterThan(waitStart);
    expect(verifyStepStart).toBeGreaterThan(waitStart);
  });

  it('runs a post-deploy smoke before verify:live — app up + build-info answers, naming the failing hop', () => {
    const smokeStart = verifyBlock.indexOf('name: Post-deploy smoke');
    const verifyStepStart = verifyBlock.indexOf('name: Verify deployed app end to end (verify:live)');
    expect(smokeStart).toBeGreaterThan(0);
    expect(verifyStepStart).toBeGreaterThan(smokeStart); // ordered BEFORE verify:live — it guards that step
    const smokeBlock = verifyBlock.slice(smokeStart, verifyStepStart);
    // The canonical URL and the build-info probe are wired via the `base`
    // variable inside the step (no new env/secret needed to reach them).
    expect(smokeBlock).toContain('base="https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app"');
    expect(smokeBlock).toContain('"$base/api/build-info"');
    // Gated identically to verify:live, so a fork that skips the deep run also
    // skips its pre-flight (both stay skip-not-fail on forks).
    expect(smokeBlock).toContain(FIVE_INPUTS_GATE);
    expect(smokeBlock).toContain('exit 1'); // loud failure, never a silent skip
    expect(smokeBlock).toContain('::error::'); // names the failing hop in the log
    // "Needs nothing new": the smoke must not introduce a secret wiring or an
    // env block the job didn't already have.
    expect(smokeBlock).not.toContain('secrets.');
    expect(smokeBlock).not.toMatch(/^\s+env:/m);
  });

  it('installs Chrome and threads CHROME_PATH into the verify step (UI starter driver)', () => {
    expect(verifyBlock).toContain('name: Install Chrome for the UI starter driver');
    expect(verifyBlock).toContain('uses: browser-actions/setup-chrome@v2');
    expect(verifyBlock).toContain('chrome-version: stable');
    expect(verifyBlock).toContain('id: chrome');
    const verifyStepStart = verifyBlock.indexOf('name: Verify deployed app end to end (verify:live)');
    const verifyStepBlock = verifyBlock.slice(verifyStepStart);
    expect(verifyStepBlock).toContain('CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}');
  });

  it('targets the canonical App Hosting URL for verify:live', () => {
    const verifyStepStart = verifyBlock.indexOf('name: Verify deployed app end to end (verify:live)');
    const verifyStepBlock = verifyBlock.slice(verifyStepStart);
    expect(verifyStepBlock).toContain('run: npm run verify:live -- --require-app-check-enforced');
    expect(verifyStepBlock).toContain(FIVE_INPUTS_GATE);
    expect(verifyStepBlock).toContain('VERIFY_BASE_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    // No second-host env anymore — verify:live's [4b] stage was collapsed.
    expect(verifyStepBlock).not.toContain('VERIFY_APPHOSTING_URL');
  });

  it('wires all five required inputs into the job env, loud guard, and verify step (3 wirings each)', () => {
    for (const name of [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'FIREBASE_SERVICE_ACCOUNT',
      'APP_OWNER_UID',
      'GOOGLE_AI_API_KEY',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
    ]) {
      expect(verifyBlock.match(new RegExp(SECRET_WIRING(name).replace(/[$\\{\\}]/g, '\\$&'), 'g'))).toHaveLength(3);
    }
  });

  it('makes the App Check app id a loud main-deploy prerequisite', () => {
    const guardStart = verifyBlock.indexOf('name: Fail loudly if a verify secret is missing (main deploy)');
    const guardBlock = verifyBlock.slice(guardStart, verifyBlock.indexOf('name: Wait for the App Hosting rollout'));
    expect(guardBlock).toContain('NEXT_PUBLIC_FIREBASE_APP_ID');
    expect(guardBlock).toContain('mints the App Check token for verify:live');
  });

  it('records the verify:live verdict to Firestore after the verify step (runs even on failure)', () => {
    // The status page needs the last verify:live result at a glance. The
    // record step reads the verdict from the verify step's own outcome (so a
    // skipped pre-flight never overwrites the last real result), runs with
    // `if: always()` so a RED run is recorded too, and needs NO new secret
    // wiring — it reads FIREBASE_SERVICE_ACCOUNT from the job env.
    expect(verifyBlock).toContain('id: verify');
    expect(verifyBlock).toContain('name: Record verify:live result for the status page');
    expect(verifyBlock).toContain("always() && (steps.verify.outcome == 'success' || steps.verify.outcome == 'failure')");
    expect(verifyBlock).toContain('node scripts/record-verify-status.mjs');
    // The verdict comes from VERIFY_LIVE_VERDICT (set by verify:live itself via
    // GITHUB_ENV) so the distinct 'external' Gemini-credits state survives;
    // the step outcome is only the fallback for runs that never wrote it.
    // Shell fallback (not an Actions ternary) on purpose: a ternary's colon
    // breaks the plain YAML scalar, and the shell form reads the GITHUB_ENV
    // variable with zero doubt about expression-context visibility.
    expect(verifyBlock).toContain('--verdict "${VERIFY_LIVE_VERDICT:-${{ steps.verify.outcome }}}"');
    expect(verifyBlock).toContain('--commit "${{ github.sha }}"');
    expect(verifyBlock).toContain('--run-url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"');
    // The recorder also receives the optional spared-live-session reason
    // (VERIFY_LIVE_REASON, set by verify:live via GITHUB_ENV) so a drill /
    // overlap failure is labeled intentional on the status page, never a bare
    // failure. Empty-default: a normal run passes an empty reason that the
    // recorder omits from the doc.
    expect(verifyBlock).toContain('--reason "${VERIFY_LIVE_REASON:-}"');
    // Negative: the record step must not introduce another secret wiring.
    const recordStart = verifyBlock.indexOf('name: Record verify:live result for the status page');
    const recordBlock = verifyBlock.slice(recordStart);
    expect(recordBlock).not.toContain('secrets.');
  });

  it('keeps the loud-secret guard so a missing secret fails instead of silently skipping (no VERCEL_TOKEN)', () => {
    expect(verifyBlock).toContain('name: Fail loudly if a verify secret is missing (main deploy)');
    expect(verifyBlock).toContain('::error::Required GitHub Actions secret(s) missing on main deploy:');
    expect(verifyBlock).toContain("github.event_name != 'workflow_dispatch'");
    expect(verifyBlock).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(verifyBlock).toContain("env.APP_OWNER_UID == ''");
    expect(verifyBlock).not.toContain('VERCEL_TOKEN');
    expect(verifyBlock).toContain('exit 1');
  });

  it('has NO deployment_status trigger and no verify-deployed.yml anywhere', () => {
    expect(CI).not.toContain('deployment_status');
    expect(CI).not.toContain('verify-deployed.yml');
  });

  it('exposes the force_verify_live_regression drill input and threads it through to the verify:live step', () => {
    // Third drill: combine a guard spare with a synthetic real regression.
    // The input must be a STRING defaulting to 'false' (so push + scheduled
    // runs are unaffected AND `inputs.force_verify_live_regression == 'true'`
    // matches under every dispatch method), and the verify:live step must
    // read inputs.force_verify_live_regression — never a literal 'true' — so
    // the seam stays inert by default. A future edit that drops the input,
    // reverts it to type: boolean, or hard-codes the env would silently
    // disarm the round-trip proof.
    expectStringDrillInput(CI);
    expectDrillEnvThreading(CI);
  });

  it('proves the string-input pin catches a reverted boolean input (mutation)', () => {
    // The string-input pin must have discriminating power, not pass
    // vacuously. Mutate ONLY the input declaration in an in-memory copy of
    // the REAL workflow source (never on disk) — revert it to the old
    // type: boolean shape that left FORCE_VERIFY_LIVE_REGRESSION empty under
    // every dispatch method (32266697726/32267874575/32268919307) — and
    // invoke the ACTUAL contract assertion (expectStringDrillInput) on the
    // mutated copy: it must throw, i.e. fail. If a future edit weakens or
    // removes the pin, this mutation test goes red with it instead of
    // passing on an independent check.
    // Direction 1 — the full historical revert (type: boolean + default:
    // false, the exact shape that left the env empty in every dispatch).
    const reverted = CI.replace(
      "        required: false\n        default: 'false'",
      '        type: boolean\n        default: false',
    );
    expect(reverted, 'the boolean revert must actually land').not.toBe(CI);
    expect(() => expectStringDrillInput(reverted)).toThrow();

    // Direction 2 — reintroduce ONLY type: boolean while keeping the string
    // default. This breaks just the `not.toMatch(/type: boolean/)` pin, so a
    // future edit that deletes THAT single assertion flips this leg green
    // and the mutation test goes red with it — each pin is individually
    // load-bearing, not just the pair.
    const reintroduced = CI.replace(
      "        required: false\n        default: 'false'",
      "        type: boolean\n        default: 'false'",
    );
    expect(reintroduced, 'the boolean reintroduction must actually land').not.toBe(CI);
    expect(() => expectStringDrillInput(reintroduced)).toThrow();
  });

  it('proves the env-threading pin catches a hard-coded or dropped-input mutation', () => {
    // The env expression must read inputs.force_verify_live_regression AND
    // keep the `== 'true' && 'true' || ''` shape — a hard-coded 'true' would
    // make the seam fire on EVERY push (breaking the push-run inertness),
    // and a dropped input would silently disarm the drill. Mutate ONLY the
    // env line in in-memory copies of the REAL workflow source (never on
    // disk) and invoke the ACTUAL contract assertion (expectDrillEnvThreading)
    // on each: it must throw. Each direction breaks exactly one pin so a
    // future edit that deletes a single assertion flips the corresponding
    // leg green and this mutation test goes red with it.

    // Direction 1 — hard-coded 'true': the env no longer reads the input at
    // all and the seam would fire on every run. Breaks both pins.
    const hardcoded = CI.replace(
      "FORCE_VERIFY_LIVE_REGRESSION: ${{ inputs.force_verify_live_regression == 'true' && 'true' || '' }}",
      "FORCE_VERIFY_LIVE_REGRESSION: 'true'",
    );
    expect(hardcoded, 'the hard-coded mutation must actually land').not.toBe(CI);
    expect(() => expectDrillEnvThreading(hardcoded)).toThrow();

    // Direction 2 — dropped input: the expression reads a DIFFERENT input,
    // keeping the `== 'true' && 'true' || ''` shape. Breaks ONLY the
    // inputs-reference pin.
    const droppedInput = CI.replace(
      "inputs.force_verify_live_regression == 'true'",
      "inputs.force_crash_no_summary == 'true'",
    );
    expect(droppedInput, 'the dropped-input mutation must actually land').not.toBe(CI);
    expect(() => expectDrillEnvThreading(droppedInput)).toThrow();

    // Direction 3 — truthy shape: drops the `== 'true'` comparison while
    // still reading the input. Breaks ONLY the expression-shape pin.
    const truthy = CI.replace(
      "FORCE_VERIFY_LIVE_REGRESSION: ${{ inputs.force_verify_live_regression == 'true' && 'true' || '' }}",
      "FORCE_VERIFY_LIVE_REGRESSION: ${{ inputs.force_verify_live_regression && 'true' || '' }}",
    );
    expect(truthy, 'the truthy-shape mutation must actually land').not.toBe(CI);
    expect(() => expectDrillEnvThreading(truthy)).toThrow();
  });
});

describe('.github/workflows/mic-regression.yml · weekly two-burst pass-rate monitor', () => {
  // Scheduled weekly monitor for the phase-C two-burst mic path (dropped the
  // second burst at a 33% rate before the drain-stuck fix). The load-bearing
  // contracts: it runs WEEKLY (not just manually), it runs the phase-C-only
  // driver in a 6-run batch against the LIVE deploy, a dropped burst fails
  // the job loudly, and the run is fork-safe like the other workflows — a
  // missing credential must never masquerade as a green weekly pass.

  it('runs weekly on a schedule (plus manual dispatch)', () => {
    expect(MIC_REGRESSION).toMatch(/^name: Mic regression \(weekly phase-C pass rate\)/m);
    expect(MIC_REGRESSION).toContain('schedule:');
    expect(MIC_REGRESSION).toContain("- cron: '0 6 * * 1'");
    expect(MIC_REGRESSION).toContain('workflow_dispatch:');
  });

  it('runs the phase-C-only driver in a 6-run batch against the live App Hosting deploy', () => {
    expect(MIC_REGRESSION).toContain('name: Phase-C two-burst batch (6 runs)');
    expect(MIC_REGRESSION).toContain('node scripts/drive-live-voice.mjs --phase-c-only');
    // The weekly monitor isolates its probe namespace from the post-deploy
    // verify:live voice stage (same owner, same driver) so neither can sweep
    // the other's in-flight probe (Codex P1, PR #6).
    expect(MIC_REGRESSION).toContain('--phase-c-only --probe-prefix mic-regression- --out');
    expect(MIC_REGRESSION).toContain('for i in 1 2 3 4 5 6; do');
    expect(MIC_REGRESSION).toContain('VERIFY_BASE_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    expect(MIC_REGRESSION).toContain('timeout-minutes: 30');
  });

  it('shares the live-voice-probe concurrency group with verify:live so overlapping runs queue, never collide', () => {
    // Both drivers run as the same APP_OWNER_UID and the /cook active session
    // picks the newest active/paused session for that user, so a distinct
    // probe prefix alone is not enough — the runs must serialize (Codex P2,
    // PR #98 review).
    expect(MIC_REGRESSION).toContain('group: live-voice-probe');
    expect(CI).toContain('group: live-voice-probe');
  });

  it('keeps the concurrency-cancel guidance so the latest-green run is the one to check', () => {
    // A superseded push cancels the in-progress ci.yml run (cancel-in-progress:
    // true) — the c2e3b2b run showed `cancelled` mid-deploy when fd7b379
    // landed. The docs must keep telling readers to check the LATEST completed
    // run, never a cancelled one; deleting this guidance silently turns a
    // cancelled CI run into a confusing dead end. The note is a wrapped YAML
    // comment, so each pin matches within a single line of it.
    expect(CI).toContain('cancel-in-progress: true');
    expect(CI).toContain('This is EXPECTED behavior, not a');
    expect(CI).toContain('the LATEST completed run on the');
    expect(CI).toContain('cancelled one — the cancelled run');
    expect(CI).toContain('re-run in full by the newer push');
  });

  it('installs Chrome and threads CHROME_PATH into the batch step (CDP driver)', () => {
    expect(MIC_REGRESSION).toContain('browser-actions/setup-chrome@v2');
    expect(MIC_REGRESSION).toContain('id: chrome');
    expect(MIC_REGRESSION).toContain('CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}');
  });

  it('wires the three owner credentials and keeps the run fork-safe', () => {
    for (const name of ['NEXT_PUBLIC_FIREBASE_API_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'APP_OWNER_UID']) {
      expect(MIC_REGRESSION.match(new RegExp(SECRET_WIRING(name).replace(/[$\\{\\}]/g, '\\$&'), 'g'))).toHaveLength(1);
    }
    expect(MIC_REGRESSION).toContain('if: ${{ env.NEXT_PUBLIC_FIREBASE_API_KEY != \'\' && env.FIREBASE_SERVICE_ACCOUNT != \'\' && env.APP_OWNER_UID != \'\' }}');
    expect(MIC_REGRESSION).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(MIC_REGRESSION).toContain('::error::Owner-credential secrets missing');
    expect(MIC_REGRESSION).toContain('exit 1');
  });

  it('fails the job loudly when any run drops a burst, and uploads the artifacts', () => {
    expect(MIC_REGRESSION).toContain('::error::phase-C batch:');
    expect(MIC_REGRESSION).toContain('exit 1');
    expect(MIC_REGRESSION).toContain('actions/upload-artifact@v4');
    expect(MIC_REGRESSION).toContain('if: always()');
    expect(MIC_REGRESSION).toContain('phase-c-runs');
  });

  it('opens a GitHub issue on a red week, deduped against an open issue', () => {
    expect(MIC_REGRESSION).toContain('issues: write');
    expect(MIC_REGRESSION).toContain('Open a GitHub issue on a red week');
    // always(): the batch step exits 1 on a red week, so a status-less
    // condition would be implicitly success() and never run (Codex P1, PR #11).
    expect(MIC_REGRESSION).toContain("always() && steps.batch.outputs.result != ''");
    expect(MIC_REGRESSION).toContain('gh issue list');
    expect(MIC_REGRESSION).toContain('--label "mic-regression" --state open');
    expect(MIC_REGRESSION).toContain('gh label create "mic-regression" --force');
    expect(MIC_REGRESSION).toContain('gh issue create');
    expect(MIC_REGRESSION).toContain('--body "The weekly phase-C two-burst check went red');
    expect(MIC_REGRESSION).toContain('$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/${{ github.run_id }}');
    expect(MIC_REGRESSION).toContain('skipping (dedupe)');
  });

  it('red-week issue body carries the run URL, artifact URL, and drop-classification guidance', () => {
    // A genuine red alert must give the responder everything needed to find
    // and diagnose the failing run from the issue alone: the run link, the
    // artifacts link (blob + screenshot), and how to read the blob's
    // drop-classification verdict. Each is pinned so a future edit cannot
    // silently strip the diagnosis path from the alert.
    // Run URL — built from the canonical env vars and linked in the body.
    expect(MIC_REGRESSION).toContain('run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/${{ github.run_id }}"');
    expect(MIC_REGRESSION).toContain('- **Run:** $run_url');
    // Artifact URL — derived from the run URL and linked in the body.
    expect(MIC_REGRESSION).toContain('artifact_url="$run_url/artifacts"');
    expect(MIC_REGRESSION).toContain('- **Artifacts (phase-c-runs — the failing run\'s copy-voice-details blob + screenshot):** $artifact_url');
    // Drop-classification guidance — tells the responder which layer dropped
    // the mic, and where the latency evidence lives when nothing dropped.
    expect(MIC_REGRESSION).toContain('drop-classification verdict (queue / network / audio-graph) pinpoints which layer dropped the mic');
    expect(MIC_REGRESSION).toContain('phase-c-latency blob + screenshot show the state at the violation');
  });

  it('forgives transient runs up to a CONFIGURABLE flake budget but NEVER budgets the mic-contract failures', () => {
    // The session-launch 503 that reddened a real batch (5/6) must not open a
    // false-positive issue. The budget is kind-aware: a failed run is a HARD
    // failure (never budgeted) when its log carries a monitored-contract
    // signature — two-burst drop, stuck queue, latency violation, an undrained
    // second reply, or an uncapturable blob — and a FLAKE otherwise (pre-mic /
    // infra, e.g. launch 503). Hard failures redden the very first week, so a
    // true regression cannot hide behind the budget; only flakes are forgiven
    // up to MIC_REGRESSION_FLAKE_BUDGET (workflow_dispatch input, default 1).
    expect(MIC_REGRESSION).toContain('flake_budget:');
    expect(MIC_REGRESSION).toContain("default: '1'");
    expect(MIC_REGRESSION).toContain("flake_budget=\"${MIC_REGRESSION_FLAKE_BUDGET:-1}\"");
    expect(MIC_REGRESSION).toContain("MIC_REGRESSION_FLAKE_BUDGET: ${{ inputs.flake_budget || '1' }}");
    // The hard-signature classifier — a failed run matching ANY of the
    // driver's hard-failure strings is never a flake. The log-grep alternation
    // is DERIVED from HARD_SIGNATURES_GREP (single source of truth), so no
    // hardcoded list survives here either.
    expect(MIC_REGRESSION).toContain('HARD_SIGNATURES_GREP');
    expect(MIC_REGRESSION).toContain('${hard_signatures}');
    expect(MIC_REGRESSION).not.toContain('reports a stuck queue|transcription');
    // The structured archive is the authoritative signal — a hard
    // phase-c-summary.json outcome is never budgeted, with the log grep kept
    // as a fallback for a crash that predates the summary write. The outcome
    // alternation is DERIVED from HARD_PHASE_C_OUTCOMES (single source of
    // truth), so no hardcoded list survives here.
    expect(MIC_REGRESSION).toContain('summary="${RUNNER_TEMP}/phase-c/run-$i/phase-c-summary.json"');
    expect(MIC_REGRESSION).toContain('HARD_PHASE_C_OUTCOMES.join("|")');
    expect(MIC_REGRESSION).toContain('${hard_outcomes}');
    expect(MIC_REGRESSION).not.toContain('(stuck|undrained|unverifiable|latency|drop)');
    // Hard failures redden unconditionally (no budget path exists for them).
    expect(MIC_REGRESSION).toContain('hard failure(s):${hard_failed} (never budgeted)');
    // Over-budget flakes redden; a forgiven week is a NOTICE that sets no
    // `result` output, so the issue step stays silent on a flaky-but-green
    // week (a single transient run cannot open a false-positive issue).
    expect(MIC_REGRESSION).toContain('exceed the flake budget ${flake_budget}');
    expect(MIC_REGRESSION).toContain('within budget ${flake_budget} (forgiven — no issue)');
    // A non-numeric budget falls back to 1 loudly rather than crashing the
    // numeric comparison.
    expect(MIC_REGRESSION).toContain('is not a number — defaulting to 1');
  });

  it('escalates a same-flake streak to an alert even when each week stays within budget', () => {
    // The flake budget forgives a transient per week; the SAME flake within
    // budget every week must NOT be forgiven forever. The batch exposes the
    // flaked run indices, and a dedicated step runs the escalation script
    // (which compares the current signature against the two most recent prior
    // weeks and opens its own deduped issue) — gated off when the week already
    // went red (the red alert covers it) or there were no flakes.
    expect(MIC_REGRESSION).toContain('echo "flake_indices=${flake_failed}" >> "$GITHUB_OUTPUT"');
    expect(MIC_REGRESSION).toContain('echo "flake_count=${flake_count}" >> "$GITHUB_OUTPUT"');
    expect(MIC_REGRESSION).toContain('Escalate a same-flake streak (3 weeks running)');
    expect(MIC_REGRESSION).toContain('id: escalate');
    // The flake indices must be read with the Actions expression syntax
    // (${{ steps... }}), not bash ${steps...} — dots are illegal in a bash
    // variable name, and the bad substitution made the step die with exit 1
    // the first time the drill exercised it.
    expect(MIC_REGRESSION).toContain('node scripts/mic-flake-escalate.mjs --out "${RUNNER_TEMP}/phase-c" --flake-indices "${{ steps.batch.outputs.flake_indices }}" $drill_flag');
    expect(MIC_REGRESSION).not.toContain('"${steps.batch.outputs.flake_indices}"');
    expect(MIC_REGRESSION).toContain("steps.batch.outputs.result == ''");
    // The step runs on CLEAN weeks too (no flake_indices gate) so the
    // escalation script can auto-close a healed streak instead of leaving the
    // alert open after the outage ends.
    expect(MIC_REGRESSION).not.toContain("steps.batch.outputs.flake_indices != ''");
  });

  it('wires the force_stuck_blob drill input and keeps it OFF for scheduled runs', () => {
    // The artifact-upload drill: dispatch with force_stuck_blob=true to inject
    // the documented stuck signature into every run and prove the red-week
    // evidence chain (verdict → fail → blob + screenshot artifacts) end to
    // end. The input defaults to false and the env is empty on schedule runs,
    // so the scheduled weekly monitor NEVER injects.
    expect(MIC_REGRESSION).toContain('force_stuck_blob:');
    expect(MIC_REGRESSION).toContain("default: 'false'");
    expect(MIC_REGRESSION).toContain("PHASE_C_FORCE_STUCK: ${{ inputs.force_stuck_blob == 'true' && '1' || '' }}");
  });

  it('wires the force_flake_streak drill input — one injected flake, seeded streak, self-cleaning', () => {
    // The escalation drill: dispatch with force_flake_streak=true to fail run
    // 1 with a synthetic pre-mic flake (--force-flake-streak) and seed the two
    // prior weeks with the same signature (--drill-streak), so the batch flake
    // classification → escalate step → escalation-issue path fires in ONE
    // dispatch. Defaults to false so the scheduled monitor never injects.
    expect(MIC_REGRESSION).toContain('force_flake_streak:');
    // The seam must be armed on run 1 ONLY via the CLI flag. A step-wide
    // PHASE_C_FORCE_FLAKE_STREAK env would arm the driver's process.env check
    // on EVERY run and redden the week with 6 flakes (caught by the first
    // force_flake_streak drill) — assert that env arming is absent.
    expect(MIC_REGRESSION).not.toContain('PHASE_C_FORCE_FLAKE_STREAK:');
    expect(MIC_REGRESSION).toContain('flake_flag="--force-flake-streak"');
    expect(MIC_REGRESSION).toContain('[ "$i" -eq 1 ] && [ "${{ inputs.force_flake_streak }}" = "true" ]');
    expect(MIC_REGRESSION).toContain('--drill-streak');
    expect(MIC_REGRESSION).toContain('inputs.force_flake_streak == \'true\'');
  });

  it('wires the force_crash_no_summary drill seam — run 1 fails with the stuck signature but skips its summary, so the log-grep fallback fires', () => {
    // Branch 3 (the log-grep fallback from HARD_SIGNATURES_GREP) only fires
    // on a run that fails BEFORE archiving its summary — force_stuck_blob
    // alone always writes the summary at the shared exit, so that branch was
    // only provable via the codegen contract. The seam arms run 1 ONLY with
    // --force-stuck-blob --skip-phase-c-summary, so the batch classifies it
    // via the log grep on a real failing run. Defaults to false so the
    // scheduled monitor never exercises it.
    expect(MIC_REGRESSION).toContain('force_crash_no_summary:');
    expect(MIC_REGRESSION).toContain("default: 'false'");
    // Armed per-run via the CLI flag, exactly like the flake seam — a
    // step-wide env would arm EVERY run (six crash-before-summary hard
    // failures, not one). Assert env arming is absent.
    expect(MIC_REGRESSION).not.toContain('PHASE_C_FORCE_SKIP_SUMMARY:');
    expect(MIC_REGRESSION).toContain('crash_flag="--force-stuck-blob --skip-phase-c-summary"');
    expect(MIC_REGRESSION).toContain('[ "$i" -eq 1 ] && [ "${{ inputs.force_crash_no_summary }}" = "true" ]');
    // The drill must be self-cleaning like the other drill inputs.
    expect(MIC_REGRESSION).toContain("inputs.force_crash_no_summary == 'true'");
  });

  it('keeps the crash seam INERT on scheduled runs — the summary archive can never be silently disabled', () => {
    // The weekly monitor runs on the `schedule` trigger, where NO
    // workflow_dispatch input exists — `inputs.force_crash_no_summary` is
    // empty there, so the archive must stay on for every run. A future edit
    // that makes the seam reachable on schedule (a non-false default, an env
    // arm, or the flag outside the run-1-only guard) would silently stop
    // archiving summaries and corrupt the trend's drops column.
    // The schedule trigger is the canonical weekly path.
    expect(MIC_REGRESSION).toContain('schedule:');
    expect(MIC_REGRESSION).toMatch(/cron: '0 6 \* \* 1'/);
    // Default false: a bare dispatch (no input) never arms the seam.
    expect(MIC_REGRESSION).toContain('force_crash_no_summary:');
    expect(MIC_REGRESSION).toMatch(/force_crash_no_summary:[\s\S]*?default: 'false'/);
    // NO env arming anywhere in the workflow — the driver's
    // PHASE_C_FORCE_SKIP_SUMMARY env check must never be reachable from the
    // workflow, on schedule or dispatch (the flake seam's env is absent for
    // the same reason).
    expect(MIC_REGRESSION).not.toContain('PHASE_C_FORCE_SKIP_SUMMARY');
    // The flag can ONLY appear inside the run-1-only guard — it must never
    // ride in the shared driver invocation line, or any run could skip its
    // summary. Order in the workflow: guard → assignment → invocation, with
    // the guard BEFORE the assignment (the assignment is its then-branch).
    const guardAt = MIC_REGRESSION.indexOf('[ "$i" -eq 1 ] && [ "${{ inputs.force_crash_no_summary }}" = "true" ]');
    const crashFlagAt = MIC_REGRESSION.indexOf('crash_flag="--force-stuck-blob --skip-phase-c-summary"');
    const invocationAt = MIC_REGRESSION.indexOf('--phase-c-only --probe-prefix mic-regression-');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(crashFlagAt).toBeGreaterThan(guardAt);
    expect(invocationAt).toBeGreaterThan(crashFlagAt);
    // On a schedule run the input is empty, so the guard is false and the
    // driver command carries only $flake_flag + $crash_flag (both empty) —
    // every run archives its summary. Pin the empty-default semantics.
    expect(MIC_REGRESSION).toContain('$flake_flag $crash_flag 2>&1 | tee "$log"');
  });
});

describe('.github/workflows/compare-live-weekly.yml · weekly stack-divergence compare', () => {
  // Between deploys the LIVE stack can drift without any push (Firestore
  // data, Remote Config, indexes, rules), and the emulator-compare normally
  // only runs as ci.yml's pre-deploy gate — so this scheduled run re-runs
  // the full compare (whose deployed leg touches production) weekly. The
  // load-bearing contracts: it runs on a schedule + dispatch, runs the real
  // compare command, shares the live-voice-probe concurrency group with the
  // voice monitor, pins the canonical host, and keeps the skip-not-fail fork
  // discipline.

  it('runs weekly on a schedule (plus manual dispatch) in a slot clear of the other monitors', () => {
    expect(COMPARE_WEEKLY).toMatch(/^name: Compare live vs emulator \(weekly divergence\)/m);
    expect(COMPARE_WEEKLY).toContain('schedule:');
    expect(COMPARE_WEEKLY).toContain("- cron: '30 6 * * 4'");
    expect(COMPARE_WEEKLY).toContain('workflow_dispatch:');
  });

  it('runs the real compare against the live deployed host', () => {
    expect(COMPARE_WEEKLY).toContain('npm run verify:live:compare:emulator');
    expect(COMPARE_WEEKLY).toContain('VERIFY_BASE_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    // The emulator leg boots the Firestore emulator — Java 21 is required.
    expect(COMPARE_WEEKLY).toContain('actions/setup-java@v5');
    expect(COMPARE_WEEKLY).toContain("java-version: '21'");
  });

  it('shares the live-voice-probe concurrency group with the voice monitor (same discipline)', () => {
    expect(COMPARE_WEEKLY).toContain('group: live-voice-probe');
    expect(COMPARE_WEEKLY).toContain('cancel-in-progress: false');
  });

  it('wires the three owner credentials and keeps the run fork-safe', () => {
    for (const name of ['NEXT_PUBLIC_FIREBASE_API_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'APP_OWNER_UID']) {
      expect(COMPARE_WEEKLY.match(new RegExp(SECRET_WIRING(name).replace(/[$\\{\\}]/g, '\\$&'), 'g'))).toHaveLength(1);
    }
    expect(COMPARE_WEEKLY).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(COMPARE_WEEKLY).toContain('::error::Owner-credential secrets missing');
    expect(COMPARE_WEEKLY).toContain("if: ${{ env.NEXT_PUBLIC_FIREBASE_API_KEY != '' && env.FIREBASE_SERVICE_ACCOUNT != '' && env.APP_OWNER_UID != '' }}");
  });
  it('creates the per-run log dir before tee and authenticates the red-week alert', () => {
    // The tee race (proven by the force-stuck drill): the driver creates its
    // --out dir at startup, but tee opens the log first — without an explicit
    // mkdir the log is never written, the classifier's grep finds nothing, and
    // a hard stuck-queue failure is misclassified as a flake.
    expect(MIC_REGRESSION).toContain('mkdir -p "${RUNNER_TEMP}/phase-c/run-$i"');
    // gh inside Actions is NOT authenticated by default — without GH_TOKEN the
    // red-week issue step dies on every gh call and the alert never opens
    // (the drill reddened the batch but the issue step failed with "set the
    // GH_TOKEN environment variable").
    expect(MIC_REGRESSION).toContain('GH_TOKEN: ${{ github.token }}');
  });
  it('makes drill runs self-cleaning — the drill issue is closed and its artifacts deleted', () => {
    // A force_stuck_blob run must not leave residue in the alert history: the
    // alert step captures the exact issue it created, and a cleanup step
    // closes THAT issue (never a real open one) and deletes this run's
    // phase-c-runs artifact. Gated on the drill input, so a genuine red week
    // keeps its issue + artifacts.
    expect(MIC_REGRESSION).toContain('id: alert');
    expect(MIC_REGRESSION).toContain('created_issue=${issue_url##*/}');
    expect(MIC_REGRESSION).toContain('Clean up drill residue (close issues + delete artifacts)');
    expect(MIC_REGRESSION).toContain("inputs.force_stuck_blob == 'true' || inputs.force_flake_streak == 'true'");
    expect(MIC_REGRESSION).toContain('-X DELETE "repos/$GITHUB_REPOSITORY/actions/artifacts/$id"');
    // The cleanup can only close the issue this run created — a blanket close
    // could silently swallow a real open mic-regression issue.
    expect(MIC_REGRESSION).toContain('steps.alert.outputs.created_issue');
    // The flake-streak drill's escalation issue is cleaned the same way.
    expect(MIC_REGRESSION).toContain('steps.escalate.outputs.created_issue');
    // Deleting artifacts needs the actions scope; the scheduled monitor never
    // exercises it (the drill input defaults to false, keeping cleanup off).
    expect(MIC_REGRESSION).toContain('actions: write');
  });

  it('alert + drill-cleanup scripts are syntactically valid bash', () => {
    // The alert step wraps gh issue create in a $( ) command substitution to
    // capture the created issue number for the drill cleanup. A missing close
    // paren breaks the WHOLE step at parse time — the step fails before any
    // line runs, so the drill opens no issue and the rehearsal silently
    // degrades (caught live by the first self-cleaning drill: "unexpected EOF
    // while looking for matching ')'"). bash -n both scripts so this class of
    // break is a suite failure, not a CI surprise.
    const scriptOf = (anchor: string): string => {
      const from = MIC_REGRESSION.indexOf(anchor);
      expect(from, `anchor ${anchor} missing`).toBeGreaterThan(-1);
      const runIdx = MIC_REGRESSION.indexOf('run: |', from);
      const nextStep = MIC_REGRESSION.indexOf('\n      - name:', runIdx);
      const end = nextStep === -1 ? MIC_REGRESSION.length : nextStep;
      return MIC_REGRESSION
        .slice(runIdx + 'run: |'.length, end)
        .split('\n')
        .map((l) => l.replace(/^          /, ''))
        .join('\n');
    };
    for (const script of [
      scriptOf('id: alert'),
      scriptOf('id: escalate'),
      scriptOf('Clean up drill residue (close issues + delete artifacts)'),
    ]) {
      execFileSync('bash', ['-n'], { input: script });
    }
  });

});

describe('.github/workflows/branch-tidy-weekly.yml · weekly branch tidy', () => {
  it('runs weekly on a schedule (plus manual dispatch), same slot as the mic monitor', () => {
    expect(BRANCH_TIDY).toContain('schedule:');
    expect(BRANCH_TIDY).toContain("- cron: '0 6 * * 1'");
    expect(BRANCH_TIDY).toContain('workflow_dispatch:');
  });

  it('runs tidy-branches in READ-ONLY report mode and branches the PR on the FINDINGS line', () => {
    expect(BRANCH_TIDY).toContain('node scripts/tidy-branches.mjs --report');
    expect(BRANCH_TIDY).toContain('FINDINGS: ');
    expect(BRANCH_TIDY).toContain("findings=${findings:-0}");
    // The workflow must NEVER delete anything — it opens a PR, cleanup stays
    // local. No branch/prune mutation command may appear.
    expect(BRANCH_TIDY).not.toContain('branch -D');
    expect(BRANCH_TIDY).not.toContain('remote prune origin');
    expect(BRANCH_TIDY).not.toContain('push origin --delete');
  });

  it('opens a dated report PR only when something accumulated, deduped against an open PR AND a leftover remote branch', () => {
    expect(BRANCH_TIDY).toContain("steps.detect.outputs.findings != '0'");
    expect(BRANCH_TIDY).toContain('gh pr create');
    expect(BRANCH_TIDY).toContain('docs/reviews/');
    expect(BRANCH_TIDY).toContain('--body-file "$report"');
    expect(BRANCH_TIDY).toContain('weekly tidy PR already open on $branch — skipping (dedupe)');
    expect(BRANCH_TIDY).toContain('gh pr list');
    // A merged/closed PR leaves its branch on origin — the dedupe must catch
    // that too or a same-date re-dispatch collides with the stale remote
    // branch (Codex P2, PR #141 review).
    expect(BRANCH_TIDY).toContain('git ls-remote --heads origin "$branch"');
    expect(BRANCH_TIDY).toContain('remote branch $branch already exists — skipping (dedupe)');
  });

  it('creates the PR with a PAT so its checks run, and fails loudly when it is missing', () => {
    // A PR created with GITHUB_TOKEN does NOT trigger the pull_request
    // workflows (GitHub suppresses runs for events created by that token), so
    // the report PR would never run validate/gate and could not merge. The PR
    // step must use the WEEKLY_TIDY_TOKEN PAT, with a loud guard on the
    // canonical repo (Codex P1, PR #141 review).
    expect(BRANCH_TIDY).toContain('WEEKLY_TIDY_TOKEN: ${{ secrets.WEEKLY_TIDY_TOKEN }}');
    expect(BRANCH_TIDY).toContain('GH_TOKEN: ${{ secrets.WEEKLY_TIDY_TOKEN }}');
    expect(BRANCH_TIDY).toContain('Fail loudly if WEEKLY_TIDY_TOKEN is missing (canonical repo)');
    expect(BRANCH_TIDY).toContain('::error::WEEKLY_TIDY_TOKEN secret missing');
    expect(BRANCH_TIDY).toContain('exit 1');
  });

  it('writes the report into docs/reviews/ and keeps the scan tokenless', () => {
    expect(BRANCH_TIDY).toContain('docs/reviews/');
    // The SCAN (detect step) stays tokenless git + gh with the runner token;
    // only the PR creation needs the PAT. No Firebase/owner secrets anywhere.
    expect(BRANCH_TIDY).toContain('GH_TOKEN: ${{ github.token }}');
    expect(BRANCH_TIDY).not.toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(BRANCH_TIDY).not.toContain('GOOGLE_AI_API_KEY');
  });
});

const MIC_TREND = readFileSync('.github/workflows/mic-trend-weekly.yml', 'utf8');
describe('.github/workflows/mic-trend-weekly.yml · regenerable trend report', () => {
  it('runs Tuesday 06:30 UTC after the Monday batch (plus manual dispatch)', () => {
    expect(MIC_TREND).toContain("cron: '30 6 * * 2'");
    expect(MIC_TREND).toContain('workflow_dispatch:');
    expect(MIC_TREND).toContain('group: mic-trend-weekly');
    expect(MIC_TREND).toContain('cancel-in-progress: false');
  });

  it('regenerates the report with the committed CLI and the runner token', () => {
    expect(MIC_TREND).toContain('node scripts/refresh-mic-trend.mjs');
    expect(MIC_TREND).toContain('GH_TOKEN: ${{ github.token }}');
    // The regenerated artifact is gated IN THE SAME JOB before any PR can be
    // opened — a red week fails the refresh itself.
    expect(MIC_TREND).toContain('node scripts/mic-trend-gate.mjs');
    expect(MIC_TREND.indexOf('node scripts/mic-trend-gate.mjs')).toBeLessThan(MIC_TREND.indexOf('Open a PR when the report changed'));
    // The gather is read-only GitHub queries — no owner/Firebase secrets may
    // ever be wired into this job (it only reads Actions history).
    expect(MIC_TREND).not.toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(MIC_TREND).not.toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
    expect(MIC_TREND).not.toContain('GOOGLE_AI_API_KEY');
  });

  it('fails the weekly job when the clean-check total has not grown for two weeks', () => {
    // Zero drops is not enough — the monitor must still be producing fresh
    // evidence. The staleness gate reads the regenerated JSON twin and fails
    // when the trailing 14-day window holds no clean two-burst checks.
    expect(MIC_TREND).toContain('node scripts/mic-trend-staleness.mjs');
    // Order matters: after the zero-drop gate (so a red week still fails
    // first with its drops message), before any PR is opened.
    expect(MIC_TREND.indexOf('node scripts/mic-trend-gate.mjs')).toBeLessThan(
      MIC_TREND.indexOf('node scripts/mic-trend-staleness.mjs'),
    );
    expect(MIC_TREND.indexOf('node scripts/mic-trend-staleness.mjs')).toBeLessThan(
      MIC_TREND.indexOf('Open a PR when the report changed'),
    );
  });

  it('alerts when the zero-drop gate has not run in ci.yml for 14 days', () => {
    // A disabled gate (step removed from ci.yml, or never reaching it) must
    // fail the weekly job — the report cannot keep publishing unguarded. The
    // check queries ci.yml push-run history, so it needs the runner token.
    expect(MIC_TREND).toContain('node scripts/mic-trend-gate-presence.mjs');
    // Order: after the zero-drop gate and staleness, before any PR opens.
    expect(MIC_TREND.indexOf('node scripts/mic-trend-staleness.mjs')).toBeLessThan(
      MIC_TREND.indexOf('node scripts/mic-trend-gate-presence.mjs'),
    );
    expect(MIC_TREND.indexOf('node scripts/mic-trend-gate-presence.mjs')).toBeLessThan(
      MIC_TREND.indexOf('Open a PR when the report changed'),
    );
    const presenceStep = MIC_TREND.slice(
      MIC_TREND.indexOf('Fail when the zero-drop gate has not run in ci.yml for 14 days'),
      MIC_TREND.indexOf('Fail loudly if WEEKLY_TIDY_TOKEN is missing'),
    );
    expect(presenceStep).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('gates the committed artifact on every push from ci.yml validate', () => {
    // The report is a monitored artifact: ci.yml's validate job must keep
    // running the zero-drop gate, so a commit carrying a red report fails
    // before deploy.
    expect(CI).toContain('Verify the mic trend report shows zero drops (artifact gate)');
    expect(CI).toContain('node scripts/mic-trend-gate.mjs');
    // The gate is tokenless (it only reads the committed markdown) — no
    // owner/Firebase secrets may be wired into it.
    const gateStep = CI.slice(CI.indexOf('Verify the mic trend report shows zero drops'), CI.indexOf('Push-time stale-head guard'));
    expect(gateStep).not.toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(gateStep).not.toContain('GH_TOKEN');
  });

  it('opens a PR only when the diff changed, deduped against an open PR and a leftover remote branch', () => {
    expect(MIC_TREND).toContain('git diff --exit-code --quiet docs/mic-regression-trend.md');
    expect(MIC_TREND).toContain('report unchanged — no PR needed');
    expect(MIC_TREND).toContain('gh pr create');
    expect(MIC_TREND).toContain('trend PR already open on $branch — skipping (dedupe)');
    expect(MIC_TREND).toContain('git ls-remote --heads origin "$branch"');
    expect(MIC_TREND).toContain('remote branch $branch already exists — skipping (dedupe)');
  });

  it('creates the PR with the WEEKLY_TIDY_TOKEN PAT so its checks run, and fails loudly when it is missing', () => {
    // Same discipline as branch-tidy-weekly.yml: a GITHUB_TOKEN-created PR
    // does not trigger the pull_request workflows, so the trend PR could
    // never merge without the PAT (Codex P1, PR #141 review).
    expect(MIC_TREND).toContain('WEEKLY_TIDY_TOKEN: ${{ secrets.WEEKLY_TIDY_TOKEN }}');
    expect(MIC_TREND).toContain('GH_TOKEN: ${{ secrets.WEEKLY_TIDY_TOKEN }}');
    expect(MIC_TREND).toContain('Fail loudly if WEEKLY_TIDY_TOKEN is missing (canonical repo)');
    expect(MIC_TREND).toContain('::error::WEEKLY_TIDY_TOKEN secret missing');
    expect(MIC_TREND).toContain('exit 1');
  });

  it('never auto-merges — the PR is the record, merge to publish', () => {
    expect(MIC_TREND).not.toContain('gh pr merge');
    expect(MIC_TREND).not.toContain('--merge');
  });
});

describe('.github/workflows/codex-review-monitor.yml · the daily Codex sweep', () => {
  it('runs on a daily schedule and supports manual dispatch', () => {
    expect(CODEX_MONITOR).toContain("cron: '0 7 * * *'");
    expect(CODEX_MONITOR).toContain('workflow_dispatch');
  });

  it('runs the sweep script with the minimal permission set', () => {
    expect(CODEX_MONITOR).toContain('node scripts/codex-review-monitor.mjs');
    expect(CODEX_MONITOR).toContain('permissions:');
    expect(CODEX_MONITOR).toContain('issues: write');
    expect(CODEX_MONITOR).toContain('pull-requests: read');
    // gh inside Actions needs the token wired explicitly — without it the
    // sweep dies on the very first API call (proven by the dispatch run).
    expect(CODEX_MONITOR).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('keeps the concurrency guard so overlapping sweeps never double-report', () => {
    expect(CODEX_MONITOR).toContain('group: codex-review-monitor');
    expect(CODEX_MONITOR).toContain('cancel-in-progress: false');
  });
});

describe('.github/workflows/spare-drill-nightly.yml · nightly spare-path golden comparator', () => {
  // Spare-drill comparator on a daily slot. The workflow dispatches ci.yml,
  // seeds + keep-alive touches drill-live-session through the guard window,
  // fetches the verify-live log, and diffs the captured NOTE/FAIL lines
  // against scripts/__golden__/guard-spare-drill.txt. Drift in the source
  // fail(...) shape or the regex shows up as non-zero exit on its own the
  // next morning — no manual dispatch required.

  it('runs on a daily 08:00 UTC schedule and supports manual dispatch', () => {
    // 08:00 UTC sits well clear of every other nightly slot: mon 06:00
    // (mic-regression + branch-tidy), tue/thu/sat 06:30 (mic-trend /
    // compare-live / marker-cleanup), and the daily 07:00 (codex). A future
    // contributor who shifts it earlier than 07:30 or later than 10:00
    // contests another job OR moves out of business hours — fail CI here
    // so the move is deliberate.
    expect(SPARE_DRILL_NIGHTLY).toMatch(/cron:\s*['"`]?\s*0\s+8\s+\*\s+\*\s+\*\s*['"`]?/);
    expect(SPARE_DRILL_NIGHTLY).toContain('workflow_dispatch:');
  });

  it('keeps the queued-run discipline so a manual rerun never overwrites a fresh in-flight compare', () => {
    // Same discipline as codex-review-monitor + mic-regression: a parallel
    // dispatch queues behind the in-flight comparator instead of cancelling
    // it, so the latest completed run is always authoritative. A cancel-
    // in-progress: true swap would orphan a fresh-drift detection mid-poll.
    expect(SPARE_DRILL_NIGHTLY).toContain('group: spare-drill-nightly');
    expect(SPARE_DRILL_NIGHTLY).toContain('cancel-in-progress: false');
  });

  it('runs scripts/guard-spare-drill.mjs end to end with the full credential set', () => {
    // The comparator needs GH_TOKEN to dispatch ci.yml + poll + fetch the
    // log, and the three Firestore credentials the drill-session helper
    // needs to seed/touch (next_public_firebase_app_id is the matching
    // App Check secret, kept in sync with the rest of the workflows). A
    // future edit that drops any of these breaks the dispatch on the
    // first overnight run.
    expect(SPARE_DRILL_NIGHTLY).toContain('node scripts/guard-spare-drill.mjs');
    expect(SPARE_DRILL_NIGHTLY).toContain('GH_TOKEN: ${{ github.token }}');
    expect(SPARE_DRILL_NIGHTLY).toContain('APP_OWNER_UID: ${{ secrets.APP_OWNER_UID }}');
    expect(SPARE_DRILL_NIGHTLY).toContain('FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
    expect(SPARE_DRILL_NIGHTLY).toContain('NEXT_PUBLIC_FIREBASE_API_KEY: ${{ secrets.NEXT_PUBLIC_FIREBASE_API_KEY }}');
    expect(SPARE_DRILL_NIGHTLY).toContain('NEXT_PUBLIC_FIREBASE_APP_ID: ${{ secrets.NEXT_PUBLIC_FIREBASE_APP_ID }}');
    // Pre-install dependencies so firebase-admin is available for the
    // drill-session helper inside the comparator's dispatch loop.
    expect(SPARE_DRILL_NIGHTLY).toContain('npm ci');
    expect(SPARE_DRILL_NIGHTLY).toMatch(/node-version:\s*22/);
  });

  it('archives the captured verify-live log so a future drift debug has the raw lines', () => {
    // Mirror of the dual-namespace guard evidence pattern: when the
    // comparator diffs against the golden, an ops engineer needs the raw
    // log to see what shape drifted. The script writes to
    // /tmp/vlive-guard-spare-drill.log on every run; upload-artifact
    // makes it pinnable to the run for 14 days. Drop either here and a
    // future drift night loses its evidence.
    expect(SPARE_DRILL_NIGHTLY).toContain('actions/upload-artifact@v4');
    expect(SPARE_DRILL_NIGHTLY).toContain('spare-drill-log');
    expect(SPARE_DRILL_NIGHTLY).toContain('/tmp/vlive-guard-spare-drill.log');
    expect(SPARE_DRILL_NIGHTLY).toContain('retention-days: 14');
  });

  it('grants actions:write so the comparator can actually dispatch ci.yml', () => {
    // The comparator dispatches ci.yml via `gh workflow run`, which needs
    // actions:write on the token. Before this block existed the job's
    // GITHUB_TOKEN was silently read-only (repo default), so EVERY
    // scheduled nightly failed with "workflow dispatched but the new
    // ci.yml run could not be located" (runs 32464195233 / 32349774634)
    // — the 403 from gh workflow run is swallowed by the comparator's
    // gh() helper, leaving the run-discovery loop empty. A future edit
    // that removes or narrows this block re-breaks the dispatch on the
    // first overnight run — fail CI here instead.
    expect(SPARE_DRILL_NIGHTLY).toMatch(/permissions:\n\s+contents: read\n\s+actions: write/);
  });

  it('replays the spare-drill fixture as a fast pre-dispatch gate before npm ci', () => {
    // Mirror of the weekly's gate (guard-drills-weekly.yml): the
    // comparator's --diff mode against the committed fixture log burns
    // seconds (plain node — no gh, no Firestore, no node_modules) instead
    // of a ~25 min ci.yml dispatch, so a golden or regex drift fails here
    // before the comparator ever dispatches. The gate must sit BEFORE
    // `npm ci` (that's what makes it fast — no dependency install) and
    // must point at the log fixture, not the golden. The comparator must
    // follow npm ci — the gate line embeds the same script path (plus
    // --diff), so a bare indexOf would match the gate itself and pass
    // vacuously.
    const gate = 'node scripts/guard-spare-drill.mjs --diff scripts/__golden__/spare-drill-log.txt';
    expect(SPARE_DRILL_NIGHTLY).toContain(gate);
    const gateIdx = SPARE_DRILL_NIGHTLY.indexOf(gate);
    const npmCiIdx = SPARE_DRILL_NIGHTLY.indexOf('run: npm ci');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(npmCiIdx).toBeGreaterThan(gateIdx);
    const comparatorIdx = SPARE_DRILL_NIGHTLY.indexOf('node scripts/guard-spare-drill.mjs', npmCiIdx);
    expect(comparatorIdx).toBeGreaterThan(npmCiIdx);
  });

  it('runs the spare-drill fixture once in a top-level preflight before the comparator job', () => {
    // Mirror of the weekly's preflight (guard-drills-weekly.yml): the
    // earliest SHARED signal for this nightly's single gate. One job
    // replays the spare fixture before the comparator's npm ci + ~25 min
    // dispatch, so a golden or regex drift fails in seconds instead of
    // after the full dispatch+seed+touch+fetch cycle. The comparator job
    // must start from it (needs: preflight), and the preflight must run
    // plain node only — no npm ci and no actions:write, because it never
    // dispatches or uploads. The per-job gate stays as belt-and-suspenders.
    const preflightStart = SPARE_DRILL_NIGHTLY.indexOf('preflight:');
    expect(preflightStart).toBeGreaterThan(-1);
    const comparatorStart = SPARE_DRILL_NIGHTLY.indexOf('compare-against-golden:', preflightStart);
    expect(comparatorStart).toBeGreaterThan(preflightStart);
    const preflightSection = SPARE_DRILL_NIGHTLY.slice(preflightStart, comparatorStart);
    expect(preflightSection).toContain(
      'node scripts/guard-spare-drill.mjs --diff scripts/__golden__/spare-drill-log.txt',
    );
    // Plain node only — no dependency install in the preflight.
    expect(preflightSection).not.toContain('run: npm ci');
    // Only contents: read — the preflight never dispatches or uploads.
    expect(preflightSection).toMatch(/permissions:\n\s+contents: read/);
    expect(preflightSection).not.toContain('actions: write');
    // The comparator job must start from the preflight.
    expect(SPARE_DRILL_NIGHTLY).toMatch(/compare-against-golden:[\s\S]*?needs:\s*preflight/);
  });
});

describe('.github/workflows/guard-drills-weekly.yml · Sunday-night spare + boundary + regression comparators', () => {
  // The daily spare-drill-nightly runs only the spare comparator — drift
  // on the boundary (archive-path) or regression (no-mask) shapes would
  // surface only via a manual dispatch. This weekly runs all three
  // comparators sequentially so a future failure on any side shows up the
  // next Monday morning with the captured log pinned as a 90-day artifact.

  it('runs Sundays at 22:00 UTC and supports manual dispatch', () => {
    // 22:00 UTC Sunday sits clear of every existing nightly:
    //   mon       06:00  (mic-regression + branch-tidy)
    //   tue       06:30  (mic-trend)
    //   thu/sat   06:30  (compare-live / marker-cleanup)
    //   daily     07:00  (codex-review-monitor)
    //   daily     08:00  (spare-drill-nightly)
    // A future contributor moving the cron out of 21:00–23:00 UTC either
    // contests an existing slot OR lands outside Sunday-night reviewer
    // hours — fail CI here so the move is deliberate.
    expect(GUARD_DRILLS_WEEKLY).toMatch(/cron:\s*['"`]?\s*0\s+22\s+\*\s+\*\s+0\s*['"`]?/);
    expect(GUARD_DRILLS_WEEKLY).toContain('workflow_dispatch:');
  });

  it('keeps the queued-run discipline so weekly reruns never overwrite a fresh in-flight pair', () => {
    expect(GUARD_DRILLS_WEEKLY).toContain('group: guard-drills-weekly');
    expect(GUARD_DRILLS_WEEKLY).toContain('cancel-in-progress: false');
  });

  it('runs the spare comparator FIRST with the full credential set', () => {
    // The spare job must dispatch ci.yml, seed + touch drill-live-session
    // through the guard window, fetch the log, and diff against the
    // spare golden. Drop the comparator script line or any secret and
    // the first leg fails differently on each future Sunday night.
    expect(GUARD_DRILLS_WEEKLY).toContain('node scripts/guard-spare-drill.mjs');
    expect(GUARD_DRILLS_WEEKLY).toContain('GH_TOKEN: ${{ github.token }}');
    expect(GUARD_DRILLS_WEEKLY).toContain('APP_OWNER_UID: ${{ secrets.APP_OWNER_UID }}');
    expect(GUARD_DRILLS_WEEKLY).toContain('FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
    expect(GUARD_DRILLS_WEEKLY).toContain('NEXT_PUBLIC_FIREBASE_API_KEY: ${{ secrets.NEXT_PUBLIC_FIREBASE_API_KEY }}');
    expect(GUARD_DRILLS_WEEKLY).toContain('NEXT_PUBLIC_FIREBASE_APP_ID: ${{ secrets.NEXT_PUBLIC_FIREBASE_APP_ID }}');
  });

  it('grants actions:write on EVERY job so each comparator can dispatch ci.yml', () => {
    // Same root cause as the nightly (see the spare-drill-nightly
    // describe): each comparator dispatches ci.yml via `gh workflow run`,
    // which needs actions:write. The jobs' GITHUB_TOKEN was silently
    // read-only (repo default) until these blocks existed — the first
    // manual weekly dispatch (32477234630) failed in the spare leg with
    // "workflow dispatched but the new ci.yml run could not be located",
    // cascading skips to the boundary and regression legs. All three
    // jobs must carry the block — a drop on any one leg re-breaks that
    // leg's dispatch on the next Sunday night.
    for (const job of ['spare-drill', 'boundary-drill', 'regression-drill']) {
      const jobStart = GUARD_DRILLS_WEEKLY.indexOf(`${job}:`);
      expect(jobStart, `job ${job} must exist`).toBeGreaterThan(-1);
      const jobSection = GUARD_DRILLS_WEEKLY.slice(jobStart);
      expect(jobSection).toMatch(/permissions:\n\s+contents: read\n\s+actions: write/);
    }
  });

  it('keeps drill-live-session.mjs TRACKED so the comparators can seed in CI checkouts', () => {
    // The comparators seed/touch/delete the drill session by shelling out
    // to scripts/drill-live-session.mjs. It used to live in the gitignored
    // .freebuff/ scratch dir — absent from every CI checkout — so after the
    // dispatch-permission fix, the weekly failed again at the seed step
    // with "Cannot find module .freebuff/drill-live-session.mjs" (weekly
    // 32477679149). The helper must stay tracked in scripts/ AND all three
    // comparators must reference that path — a move back to a gitignored
    // path silently breaks every scheduled drill.
    expect(existsSync('scripts/drill-live-session.mjs')).toBe(true);
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.freebuff\/$/m);
    for (const script of ['guard-spare-drill.mjs', 'guard-boundary-drill.mjs', 'guard-regression-drill.mjs']) {
      const src = readFileSync(`scripts/${script}`, 'utf8');
      expect(src).toContain("resolve(ROOT, 'scripts/drill-live-session.mjs')");
      expect(src).not.toContain('.freebuff/drill-live-session');
    }
  });

  it('seeds delete-first so a leaked session never blocks the next drill run', () => {
    // The --seed helper refuses when the drill-live-session doc already
    // exists ("already exists — delete first"). A failed drill run used to
    // leak the doc — cleanup ran only on the happy path — and the NEXT run's
    // seed died with exit 1 (nightly re-run 32482323556). Each comparator
    // must therefore --delete (tolerates absence) immediately before
    // --seed, making the seed idempotent and the leak self-healing. A
    // future edit that drops the delete-first line re-breaks the next run
    // after any drill failure.
    for (const script of ['guard-spare-drill.mjs', 'guard-boundary-drill.mjs', 'guard-regression-drill.mjs']) {
      const src = readFileSync(`scripts/${script}`, 'utf8');
      expect(src).toContain("['--delete']);\n    runNodeWithEnv(resolve(ROOT, 'scripts/drill-live-session.mjs'), ['--seed']);");
    }
  });

  it('runs the boundary comparator AFTER the spare via needs:', () => {
    // Why sequential: each comparator dispatches its own ci.yml on main.
    // If both jobs ran in parallel, ci.yml's concurrency group (cancel-
    // in-progress: true) would cancel the first dispatch and the second
    // comparator's seed/touch loop would land on the second ci.yml run's
    // verify-live step. Sequencing with needs: keeps each dispatch
    // atomic from the comparator's perspective. A future edit that drops
    // needs: would silently introduce the cross-job collision.
    expect(GUARD_DRILLS_WEEKLY).toContain('node scripts/guard-boundary-drill.mjs');
    expect(GUARD_DRILLS_WEEKLY).toMatch(/boundary-drill:[\s\S]*?needs:\s*spare-drill/);
    // spillover check: the boundaries of the spare job's steps vs the
    // boundary job's steps must not allow the boundary script to appear
    // before the needs: line within the boundary-drill job.
    const boundaryJobStart = GUARD_DRILLS_WEEKLY.indexOf('boundary-drill:');
    const needsIdx = GUARD_DRILLS_WEEKLY.indexOf('needs: spare-drill', boundaryJobStart);
    const scriptIdx = GUARD_DRILLS_WEEKLY.indexOf('node scripts/guard-boundary-drill.mjs', boundaryJobStart);
    expect(needsIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(needsIdx);
  });

  it('archives both captured logs at 90 days so a quarterly review sees the full Sunday-night set', () => {
    // The daily upload keeps 14 days; the weekly rolls them forward so
    // the 3-month drift review has a clean capture set. All three captured
    // log paths must be uploaded — drop one and a future drift on that
    // side has no recoverable evidence.
    expect(GUARD_DRILLS_WEEKLY).toContain('actions/upload-artifact@v4');
    expect(GUARD_DRILLS_WEEKLY).toContain('/tmp/vlive-guard-spare-drill.log');
    expect(GUARD_DRILLS_WEEKLY).toContain('/tmp/vlive-guard-boundary-drill.log');
    expect(GUARD_DRILLS_WEEKLY).toContain('/tmp/vlive-guard-regression-drill.log');
    expect(GUARD_DRILLS_WEEKLY).toContain('retention-days: 90');
  });

  it('runs the regression comparator THIRD (after boundary via needs:) with the full credential set', () => {
    // The regression drill is the no-mask proof: dispatch ci.yml WITH
    // force_verify_live_regression=true so the run carries two failures,
    // then diff the evidence lines AND assert the recorded reason is null.
    // It must run after boundary-drill (needs:) so the three sequential
    // ci.yml dispatches never cancel each other (ci.yml's concurrency
    // group cancels in_progress runs).
    expect(GUARD_DRILLS_WEEKLY).toContain('node scripts/guard-regression-drill.mjs');
    expect(GUARD_DRILLS_WEEKLY).toMatch(/regression-drill:[\s\S]*?needs:\s*boundary-drill/);
    const regressionStart = GUARD_DRILLS_WEEKLY.indexOf('regression-drill:');
    const needsIdx = GUARD_DRILLS_WEEKLY.indexOf('needs: boundary-drill', regressionStart);
    const scriptIdx = GUARD_DRILLS_WEEKLY.indexOf('node scripts/guard-regression-drill.mjs', regressionStart);
    expect(needsIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(needsIdx);
    // The regression job gets the same five credentials as the other legs
    // (gh for dispatch/log fetch, Firestore for the no-mask assertion).
    const regressionJob = GUARD_DRILLS_WEEKLY.slice(regressionStart);
    expect(regressionJob).toContain('GH_TOKEN: ${{ github.token }}');
    expect(regressionJob).toContain('APP_OWNER_UID: ${{ secrets.APP_OWNER_UID }}');
    expect(regressionJob).toContain('FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}');
    expect(regressionJob).toContain('NEXT_PUBLIC_FIREBASE_API_KEY: ${{ secrets.NEXT_PUBLIC_FIREBASE_API_KEY }}');
    expect(regressionJob).toContain('NEXT_PUBLIC_FIREBASE_APP_ID: ${{ secrets.NEXT_PUBLIC_FIREBASE_APP_ID }}');
  });

  it('replays each comparator fixture as a fast pre-dispatch gate before npm ci', () => {
    // The gates burn seconds (plain node --diff against the committed
    // fixture log — no gh, no Firestore, no node_modules) instead of a
    // ~25 min ci.yml dispatch: a golden or regex drift fails here before
    // the comparator ever dispatches. Each job must run its OWN fixture
    // (the spare golden's placeholder lines are absorbed by buildExpected,
    // so a cross-wired fixture would pass vacuously), the gate must sit
    // BEFORE `npm ci` (that's what makes it fast — no dependency install),
    // and the fixture path must point at the log fixture, not the golden.
    const gates = [
      ['spare-drill', 'node scripts/guard-spare-drill.mjs --diff scripts/__golden__/spare-drill-log.txt'],
      ['boundary-drill', 'node scripts/guard-boundary-drill.mjs --diff scripts/__golden__/boundary-drill-log.txt'],
      ['regression-drill', 'node scripts/guard-regression-drill.mjs --diff scripts/__golden__/regression-drill-log.txt'],
    ];
    for (const [job, gate] of gates) {
      const jobStart = GUARD_DRILLS_WEEKLY.indexOf(`${job}:`);
      const jobSection = GUARD_DRILLS_WEEKLY.slice(jobStart);
      expect(jobSection).toContain(gate);
      const gateIdx = jobSection.indexOf(gate);
      const npmCiIdx = jobSection.indexOf('run: npm ci');
      const comparatorIdx = jobSection.indexOf(`node scripts/guard-${job === 'spare-drill' ? 'spare' : job === 'boundary-drill' ? 'boundary' : 'regression'}-drill.mjs`, npmCiIdx);
      expect(gateIdx).toBeGreaterThan(-1);
      expect(npmCiIdx).toBeGreaterThan(gateIdx);
      // Search for the comparator AFTER npm ci — the gate line embeds the
      // same script path (plus --diff), so a bare indexOf would match the
      // gate itself and pass vacuously.
      expect(comparatorIdx).toBeGreaterThan(npmCiIdx);
    }
  });

  it('runs all three fixture gates once in a top-level preflight before the dispatch chain', () => {
    // The per-job gates are belt-and-suspenders; the preflight is the
    // earliest SHARED signal: one job replays all three fixtures before
    // the spare leg's npm ci + ~25 min dispatch, so a shared golden or
    // regex drift fails in ~30s instead of after the first dispatch (and
    // cascading skips to boundary + regression). The chain must start
    // from it (spare-drill needs: preflight), and the preflight must run
    // the gates with plain node only — no npm ci and no actions:write,
    // because it never dispatches or uploads.
    const preflightStart = GUARD_DRILLS_WEEKLY.indexOf('preflight:');
    expect(preflightStart).toBeGreaterThan(-1);
    const spareStart = GUARD_DRILLS_WEEKLY.indexOf('spare-drill:', preflightStart);
    expect(spareStart).toBeGreaterThan(preflightStart);
    const preflightSection = GUARD_DRILLS_WEEKLY.slice(preflightStart, spareStart);
    for (const gate of [
      'node scripts/guard-spare-drill.mjs --diff scripts/__golden__/spare-drill-log.txt',
      'node scripts/guard-boundary-drill.mjs --diff scripts/__golden__/boundary-drill-log.txt',
      'node scripts/guard-regression-drill.mjs --diff scripts/__golden__/regression-drill-log.txt',
    ]) {
      expect(preflightSection).toContain(gate);
    }
    // Plain node only — no dependency install in the preflight.
    expect(preflightSection).not.toContain('run: npm ci');
    // Only contents: read — the preflight never dispatches or uploads.
    expect(preflightSection).toMatch(/permissions:\n\s+contents: read/);
    expect(preflightSection).not.toContain('actions: write');
    // The dispatch chain must start from the preflight.
    expect(GUARD_DRILLS_WEEKLY).toMatch(/spare-drill:[\s\S]*?needs:\s*preflight/);
  });
});
