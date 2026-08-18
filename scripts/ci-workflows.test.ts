import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const BRANCH_TIDY = readFileSync('.github/workflows/branch-tidy-weekly.yml', 'utf8');
const COMPARE_WEEKLY = readFileSync('.github/workflows/compare-live-weekly.yml', 'utf8');

// The verify step's gating `if:` — the four secrets must ALL be present for
// the deep gates to run (a missing one skips-not-fails, but only on forks;
// the loud guard below turns that skip into a failure on main deploys).
const FOUR_SECRETS_GATE =
  "if: ${{ env.NEXT_PUBLIC_FIREBASE_API_KEY != '' && env.FIREBASE_SERVICE_ACCOUNT != '' && env.APP_OWNER_UID != '' && env.GOOGLE_AI_API_KEY != '' }}";
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
    expect(smokeBlock).toContain(FOUR_SECRETS_GATE);
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
    expect(verifyStepBlock).toContain('run: npm run verify:live');
    expect(verifyStepBlock).toContain(FOUR_SECRETS_GATE);
    expect(verifyStepBlock).toContain('VERIFY_BASE_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    // No second-host env anymore — verify:live's [4b] stage was collapsed.
    expect(verifyStepBlock).not.toContain('VERIFY_APPHOSTING_URL');
  });

  it('wires all four secrets into the job env, the loud guard, AND the verify step env (3 wirings each)', () => {
    for (const name of [
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'FIREBASE_SERVICE_ACCOUNT',
      'APP_OWNER_UID',
      'GOOGLE_AI_API_KEY',
    ]) {
      expect(verifyBlock.match(new RegExp(SECRET_WIRING(name).replace(/[$\\{\\}]/g, '\\$&'), 'g'))).toHaveLength(3);
    }
  });

  it('wires NEXT_PUBLIC_FIREBASE_APP_ID into the job env and the verify step env only (2 wirings, no guard)', () => {
    // The app id attests the driver via App Check, but attestation is
    // best-effort until App Check is provisioned — so it rides the job + step
    // env and is NOT part of the loud guard (a missing one must not redden a
    // monitor-mode deploy).
    const wiring = new RegExp(SECRET_WIRING('NEXT_PUBLIC_FIREBASE_APP_ID').replace(/[$\\{\\}]/g, '\\$&'), 'g');
    expect(verifyBlock.match(wiring)).toHaveLength(2);
    const guardStart = verifyBlock.indexOf('name: Fail loudly if a verify secret is missing (main deploy)');
    const guardBlock = verifyBlock.slice(guardStart, verifyBlock.indexOf('name: Wait for the App Hosting rollout'));
    expect(guardBlock).not.toContain('NEXT_PUBLIC_FIREBASE_APP_ID');
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
    // The hard-signature classifier — a failed run matching ANY of these is
    // never a flake (the driver's own fail strings, verbatim substrings).
    expect(MIC_REGRESSION).toContain("reports a stuck queue|transcription\\(s\\) after 90s|latency bounds exceeded|latency cannot be bounded|second reply never drained|diagnostics blob was not capturable");
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
    expect(MIC_REGRESSION).toContain('Clean up drill residue (close issue + delete artifacts)');
    expect(MIC_REGRESSION).toContain("inputs.force_stuck_blob == 'true'");
    expect(MIC_REGRESSION).toContain('-X DELETE "repos/$GITHUB_REPOSITORY/actions/artifacts/$id"');
    // The cleanup can only close the issue this run created — a blanket close
    // could silently swallow a real open mic-regression issue.
    expect(MIC_REGRESSION).toContain('steps.alert.outputs.created_issue');
    // Deleting artifacts needs the actions scope; the scheduled monitor never
    // exercises it (the drill input defaults to false, keeping cleanup off).
    expect(MIC_REGRESSION).toContain('actions: write');
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
      scriptOf('Clean up drill residue (close issue + delete artifacts)'),
    ]) {
      execFileSync('bash', ['-n'], { input: script });
    }
  });
});
