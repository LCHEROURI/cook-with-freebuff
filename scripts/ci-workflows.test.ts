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
  // validate is the FIRST job in ci.yml; the emulator-compare smoke is the
  // SECOND (deploy-apphosting follows it), and the post-deploy gate moved
  // out. The block runs from the validate key to the emulator-compare key so
  // the smoke job's push-gated steps are never read as part of validate; a
  // non-empty guard turns a future restructure into a legible failure
  // instead of confusing toContain misses.
  const smokeStart = CI.indexOf('\n  emulator-compare:');
  const validateBlock = CI.slice(CI.indexOf('\n  validate:'), smokeStart === -1 ? undefined : smokeStart);

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
    // The move must stay documented in the workflow (the NOTE lives AFTER the
    // deploy-apphosting job, so it is checked against the whole file), so a
    // future edit that re-adds the gate without consciously re-deciding fails.
    expect(CI).toContain('post-deploy verify:live gate NO LONGER lives here');
    expect(CI).toContain('.github/workflows/verify-deployed.yml');
  });

  it('runs the stale-head guard on pushes, gated on VERCEL_TOKEN', () => {
    // The push-time stale-head protection: verify-deployed-hash with
    // --stale-guard (direction-aware — a forward push passes, only a
    // rollback/diverged HEAD fails) so a stale push fails CI before the
    // deploy even starts. The gating `if:` is the load-bearing half: the step
    // must run ONLY on `push` events (a PR head is legitimately behind live
    // main and would falsely block) and only when VERCEL_TOKEN is present.
    expect(validateBlock).toContain('name: Verify pushed head is not stale vs live (stale-guard)');
    expect(validateBlock).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard');
    expect(validateBlock).toContain("if: ${{ github.event_name == 'push' && env.VERCEL_TOKEN != '' }}");
    expect(validateBlock).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
  });

  it('fails loudly when VERCEL_TOKEN is missing on a main push (no silent skip)', () => {
    // The gated step skips-not-fails without the secret; the loud guard stops
    // that skip from masquerading as a green run on the canonical repo's main
    // pushes — the same discipline as the post-deploy workflow's guard.
    expect(validateBlock).toContain('name: Fail loudly if VERCEL_TOKEN is missing (main push)');
    expect(validateBlock).toContain("github.event_name == 'push'");
    expect(validateBlock).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(validateBlock).toContain("env.VERCEL_TOKEN == ''");
    expect(validateBlock).toContain('exit 1');
  });

  it('keeps the PR stale-guard step strictly PR-only — it can never fire on push', () => {
    // The PR-time variant is the mirror image of the push-only step above:
    // it must run ONLY on pull_request (pinned to the PR head via --head),
    // never on push — the push contract belongs to the --stale-guard step
    // above, and a push firing this step would compare live against a
    // branch head and falsely block healthy pushes.
    const prStepStart = validateBlock.indexOf('name: Verify PR head is not stale vs live (stale-guard)');
    const prStepEnd = validateBlock.indexOf('\n  # NOTE:', prStepStart);
    const prStepBlock = validateBlock.slice(prStepStart, prStepEnd === -1 ? undefined : prStepEnd);
    expect(prStepBlock.length).toBeGreaterThan(0);
    expect(prStepBlock).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard --head "${{ github.event.pull_request.head.sha }}"');
    expect(prStepBlock).toContain("if: ${{ github.event_name == 'pull_request' && env.VERCEL_TOKEN != '' }}");
    expect(prStepBlock).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    // Negative locks: the PR step must not be push-gated and must not run
    // without --head (a --head-less copy would compare against the checkout
    // HEAD — the merge ref — and make every stale PR pass).
    expect(prStepBlock).not.toMatch(/github\.event_name\s*==\s*'push'/);
    expect(prStepBlock).not.toMatch(/verify-deployed-hash-gate\.mjs --stale-guard$/m);
  });

  it('fails loudly when VERCEL_TOKEN is missing on a PR (no silent skip on the canonical repo)', () => {
    // Same loud-guard discipline as the push side: a missing token must fail
    // PRs from the canonical repo instead of silently skipping the gate;
    // fork PRs (no secrets) keep skip-not-fail via the repository check.
    const prGuardStart = validateBlock.indexOf('name: Fail loudly if VERCEL_TOKEN is missing (PR)');
    const prGuardBlock = validateBlock.slice(prGuardStart, validateBlock.indexOf('name: Verify PR head', prGuardStart));
    expect(prGuardBlock.length).toBeGreaterThan(0);
    expect(prGuardBlock).toContain("github.event_name == 'pull_request'");
    expect(prGuardBlock).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(prGuardBlock).toContain("env.VERCEL_TOKEN == ''");
    expect(prGuardBlock).toContain('exit 1');
  });

  it('keeps the stale-guard step strictly push-only — it can never fire on pull_request', () => {
    // The stale-head guard was live-proven on a real runner with a BRANCH
    // push (the __stale-guard-proof experiment) — it fired red on a stale
    // head and blocked the push. That experiment was only possible BECAUSE
    // the step runs on `push`; it can never fire on `pull_request` by design:
    // a PR head is legitimately behind live main (the push will deploy it
    // forward), so gating the step on PRs would falsely block every PR. This
    // test locks the NEGATIVE — the gating must stay exactly push-only, and
    // the event condition must never be negated (`!= 'pull_request'` would
    // still fire on pushes but silently broaden to every other event too).
    //
    // The contrast that makes the lock meaningful: the workflow DOES trigger
    // on pull_request (so validate runs on PRs) — but the step specifically
    // cannot. The single-invocation count guards against a second,
    // PR-gated copy of the step appearing elsewhere in the job.
    expect(CI).toContain('pull_request:'); // validate still runs on PRs
    // Exactly ONE push-time stale-guard invocation (no --head) in validate;
    // the PR-time variant has its own --head invocation, locked by its own
    // test below. A second push-gated copy appearing elsewhere fails here.
    expect(validateBlock.match(/verify-deployed-hash-gate\.mjs --stale-guard$/m)).toHaveLength(1);

    const stepStart = validateBlock.indexOf('name: Verify pushed head is not stale vs live (stale-guard)');
    // Scope ends at the PR-time section (the push-only step must not include
    // the PR step, which legitimately references pull_request). The trailing
    // NOTE comment is prose about the verify:live move — also excluded.
    const prStart = validateBlock.indexOf('\n      # PR-time stale-head guard');
    const noteStart = validateBlock.indexOf('\n  # NOTE:');
    const ends = [prStart, noteStart].filter((i) => i !== -1);
    const stepEnd = ends.length ? Math.min(...ends) : undefined;
    const stepBlock = validateBlock.slice(stepStart, stepEnd);
    expect(stepBlock).toContain("if: ${{ github.event_name == 'push' && env.VERCEL_TOKEN != '' }}");
    // Negative locks: no literal pull_request, no negated event gate, and no
    // other event name — the ONLY event this step can ever run on is push.
    expect(stepBlock).not.toContain('pull_request');
    expect(stepBlock).not.toMatch(/github\.event_name\s*!==?\s*'/);
    expect(stepBlock).not.toContain('workflow_dispatch');
    expect(stepBlock).not.toContain('deployment_status');

    // The loud guard is the sibling half of the same contract: it too must
    // stay push-only (a missing token on a PR is not a failure — PRs never
    // run the gate the guard protects).
    const loudStart = validateBlock.indexOf('name: Fail loudly if VERCEL_TOKEN is missing (main push)');
    const loudBlock = validateBlock.slice(loudStart, validateBlock.indexOf('name: Verify pushed head', loudStart));
    expect(loudBlock).toContain("github.event_name == 'push'");
    expect(loudBlock).not.toContain('pull_request');
  });
});

describe('.github/workflows/ci.yml · deploy-apphosting auto-sync job', () => {
  // The App Hosting side used to deploy only manually (npm run
  // deploy:apphosting), so it drifted behind Vercel on every push. This job
  // closes that gap: it deploys to Firebase App Hosting after validate
  // passes, authenticating with a FIREBASE_TOKEN refresh token from
  // `firebase login:ci` (OWNER auth) — `firebase deploy --only apphosting`
  // provisions resources that need owner-level IAM, which the restricted
  // Admin SDK SA must never be widened to. The load-bearing contracts below
  // are the parts a future edit could silently break.
  const deployStart = CI.indexOf('\n  deploy-apphosting:');
  const deployBlock = CI.slice(deployStart);

  it('deploys after validate AND the emulator-compare smoke pass — never on pull_request', () => {
    expect(deployBlock.length).toBeGreaterThan(0);
    expect(deployBlock).toContain('name: Deploy Firebase App Hosting');
    // validate and the emulator-compare smoke must pass first — never deploy
    // broken code or a guided flow that diverges from live.
    expect(deployBlock).toContain('needs: [validate, emulator-compare]');
    // Push + manual re-sync only; PRs must never deploy.
    expect(deployBlock).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    expect(deployBlock).not.toContain('pull_request');
  });

  it('authenticates with a FIREBASE_TOKEN (owner login:ci) and stamps the commit', () => {
    // The deploy must authenticate via the FIREBASE_TOKEN env var (owner
    // refresh token from `firebase login:ci`) — NOT the service account, and
    // NOT GOOGLE_APPLICATION_CREDENTIALS — because `firebase deploy --only
    // apphosting` provisions resources needing owner IAM. It must run
    // write-commit.mjs BEFORE the firebase deploy so /api/build-info reports
    // the pushed commit (the source ZIP excludes .git).
    expect(deployBlock).toContain('FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}');
    expect(deployBlock).toContain('node scripts/write-commit.mjs');
    expect(deployBlock).toContain('npx -y firebase-tools@latest deploy --only apphosting --non-interactive --project portfolio-app-freebuff2');
    // The SA-based auth must be GONE — a regression back to it silently
    // reintroduces the owner-IAM 403.
    expect(deployBlock).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(deployBlock).not.toContain('FIREBASE_SERVICE_ACCOUNT');
  });

  it('runs the emulator-compare smoke before the deploy with Java 21 + owner creds', () => {
    const smokeStart = CI.indexOf('\n  emulator-compare:');
    expect(smokeStart).toBeGreaterThan(0);
    const smokeBlock = CI.slice(smokeStart, CI.indexOf('\n  deploy-apphosting:', smokeStart));
    expect(smokeBlock).toContain('name: Emulator-compare smoke (guided flow vs live)');
    expect(smokeBlock).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    // The deployed leg needs the same owner credentials the post-deploy
    // verify:live uses; the emulator leg needs Java 21 for the Firestore
    // emulator (ubuntu runners default to an older JDK).
    expect(smokeBlock).toContain('actions/setup-java@v4');
    expect(smokeBlock).toContain("java-version: '21'");
    expect(smokeBlock).toContain('NEXT_PUBLIC_FIREBASE_API_KEY');
    expect(smokeBlock).toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(smokeBlock).toContain('APP_OWNER_UID');
    expect(smokeBlock).toContain('npm run verify:live:compare:emulator');
  });

  it('retries the deploy on a 409 queue-conflict with backoff (never on other errors)', () => {
    // A deploy landing while the previous commit's rollout is still building
    // gets "HTTP Error: 409, unable to queue the operation", so a burst of
    // quick pushes red-ed the job. The step must retry that specific
    // transient with a growing backoff and give up only after a bounded
    // number of attempts, so the pushes converge instead of failing. Non-409
    // failures (a genuine build or rollout error) must NOT be retried:
    // retrying them cannot help and would burn the 15-minute budget masking
    // a real break. Each marker below is load-bearing.
    expect(deployBlock).toContain('unable to queue the operation');
    expect(deployBlock).toContain("grep -qE '409|unable to queue the operation'");
    expect(deployBlock).toContain('max_attempts=5');
    expect(deployBlock).toContain('wait_s=$((attempt * 30))');
    expect(deployBlock).toContain('sleep "$wait_s"');
    expect(deployBlock).toContain('attempt=$((attempt + 1))');
    // The bounded give-up must fail loudly, not loop forever.
    expect(deployBlock).toContain('still 409-conflicted after');
    // Non-409 must exit immediately with a distinct message (not retried).
    expect(deployBlock).toContain('non-409 error');
  });

  it('gates on FIREBASE_TOKEN with a loud guard on the canonical repo', () => {
    // A missing token must skip-not-fail on forks but fail loudly on a
    // canonical main push — a skipped deploy must never masquerade as a
    // green auto-sync.
    expect(deployBlock).toContain('name: Fail loudly if FIREBASE_TOKEN is missing (main push)');
    expect(deployBlock).toContain("env.FIREBASE_TOKEN == ''");
    expect(deployBlock).toContain('FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}');
  });
});

describe('.github/workflows/verify-deployed.yml · deployment_status post-deploy gate', () => {
  it('triggers on deployment_status (+ workflow_dispatch) and only on successful production deploys with a URL', () => {
    expect(POST_DEPLOY).toMatch(/^on:\s*\n\s*deployment_status:/m);
    expect(POST_DEPLOY).toContain('workflow_dispatch:');
    expect(POST_DEPLOY).toContain("github.event_name == 'workflow_dispatch'");
    expect(POST_DEPLOY).toContain("github.event.deployment_status.state == 'success'");
    // Environment gating is the DUAL form: Vercel labels a deployment
    // "Production" when ONE project is linked to the repo, but
    // "Production – <project-name>" (en-dash, U+2013) when MULTIPLE projects
    // share it. A bare `== 'Production'` silently skips in the multi-project
    // regime — the exact bug the portfolio repo hit. The lock asserts both
    // arms so the gate fires in either regime and a revert to a bare literal
    // fails here.
    expect(POST_DEPLOY).toContain("(github.event.deployment_status.environment == 'Production' || startsWith(github.event.deployment_status.environment, 'Production – cook-with-freebuff'))");
    expect(POST_DEPLOY).toContain("github.event.deployment_status.target_url != ''");
  });

  it('still runs verify:live, gated on the four secrets', () => {
    // An ungated step would still contain the script name — the gating `if:`
    // is the load-bearing half. Dropping either fails here.
    expect(POST_DEPLOY).toContain('name: Verify deployed app end to end (verify:live)');
    expect(POST_DEPLOY).toContain('run: npm run verify:live');
    expect(POST_DEPLOY).toContain(FOUR_SECRETS_GATE);
  });

  it('installs Chrome and threads CHROME_PATH into the verify step (UI starter driver)', () => {
    // verify:live's [3c] stage drives the real /cook UI via
    // scripts/drive-starter-prefs.mjs (headless CDP), so the post-deploy
    // runner needs a Chromium binary — the driver's macOS fallback path would
    // crash on the Linux runner. The install step and the CHROME_PATH wiring
    // are load-bearing: dropping either silently breaks the UI gate after
    // every deploy, so a future workflow edit that removes them fails here.
    expect(POST_DEPLOY).toContain('name: Install Chrome for the UI starter driver');
    expect(POST_DEPLOY).toContain('uses: browser-actions/setup-chrome@v2');
    expect(POST_DEPLOY).toContain('chrome-version: stable');
    expect(POST_DEPLOY).toContain('id: chrome');
    expect(POST_DEPLOY).toContain('CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}');
    // The wiring must be INSIDE the verify:live step's env block (after the
    // step name), not somewhere else in the file.
    const verifyStart = POST_DEPLOY.indexOf('name: Verify deployed app end to end (verify:live)');
    const verifyBlock = POST_DEPLOY.slice(verifyStart, POST_DEPLOY.indexOf('\n      #', verifyStart));
    expect(verifyBlock).toContain('CHROME_PATH: ${{ steps.chrome.outputs.chrome-path }}');
  });

  it('asserts the Firebase App Hosting side (commit report + VERIFY_APPHOSTING_URL in verify:live)', () => {
    // The App Hosting URL is the second production target. Two load-bearing
    // wirings prove it on every post-deploy run: (1) the commit-report step
    // shows both hosts side by side in the runner log, and (2) the
    // VERIFY_APPHOSTING_URL env feeds verify:live's [4b] stage, which
    // hard-asserts the Firebase side serves the app + answers /api/cook.
    // Dropping either fails here.
    expect(POST_DEPLOY).toContain('name: Report the Firebase App Hosting commit');
    expect(POST_DEPLOY).toContain('--apphosting-url "https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app"');
    expect(POST_DEPLOY).toContain('VERIFY_APPHOSTING_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
    // The VERIFY_APPHOSTING_URL wiring must be INSIDE the verify:live step's
    // env block, not anywhere else in the file.
    const verifyStart = POST_DEPLOY.indexOf('name: Verify deployed app end to end (verify:live)');
    const verifyBlock = POST_DEPLOY.slice(verifyStart, POST_DEPLOY.indexOf('\n      #', verifyStart));
    expect(verifyBlock).toContain('VERIFY_APPHOSTING_URL: https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app');
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

  it('wires VERCEL_TOKEN into the job env, the loud guard, BOTH hash steps, AND the teeth-proof step (5 wirings)', () => {
    // Counting (not a bare toContain) catches a wiring dropped on any ONE of
    // the five places that need it: job env (feeds step `if`s), loud-guard
    // env, the two hash steps' envs, and the gate-stale teeth step's env.
    // Scoped to the PRODUCTION job block (the PR preview gate has its own
    // VERCEL_TOKEN wirings, counted by its own test below).
    const productionBlock = POST_DEPLOY.slice(
      POST_DEPLOY.indexOf('\n  verify-deployed-live:'),
      POST_DEPLOY.indexOf('\n  verify-preview-deploy:'),
    );
    expect(productionBlock.match(new RegExp(SECRET_WIRING('VERCEL_TOKEN').replace(/[$\{\}]/g, '\\$&'), 'g'))).toHaveLength(5);
  });

  it('machine-reproves the gate-stale teeth after every deploy (verify-gate-stale-ci.mjs)', () => {
    // The wrapper runs the gate-stale proof (FAIL path + stale-guard) against
    // live from the pushed commit's PARENT after a successful production
    // deploy, so the stale-guard teeth are proven on the real runner — not
    // just via the npm one-liners. Gated on VERCEL_TOKEN like the hash steps;
    // the wrapper itself is skip-not-fail on the transient edge (alias
    // promotion lag / API hiccup — states where the verdicts cannot
    // reproduce), so only a proof that CAN reproduce is allowed to fail.
    expect(POST_DEPLOY).toContain('name: Verify gate-stale proof after deploy (teeth)');
    expect(POST_DEPLOY).toContain('run: node scripts/verify-gate-stale-ci.mjs');
    expect(POST_DEPLOY).toContain("if: ${{ env.VERCEL_TOKEN != '' }}");
    // The skip-not-fail contract must stay documented in the workflow so a
    // future edit that hardens the step back into a plain failure (which
    // would red-flag every deploy-lag transient) fails here.
    expect(POST_DEPLOY).toContain('loud SKIP');
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

  it('keeps the run-safety envelope (concurrency, 30-minute budget, Node 22)', () => {
    expect(POST_DEPLOY).toContain('group: verify-deployed-${{ github.ref }}');
    expect(POST_DEPLOY).toContain('cancel-in-progress: false');
    // 30 minutes, not 10: the [3d] UI starter driver (2 attempts + 30s backoff)
    // PLUS the [3e] live-voice driver (2 Chrome launches + 2 Gemini Live
    // sessions, 420s budget each + 30s backoff) legitimately exceed a 10-min
    // cap — the 10-min version cancelled the job mid-[3e]-retry and failed a
    // healthy deploy. The retry budget is the load-bearing reason: shrinking
    // the timeout below the gates' worst case fails here.
    expect(POST_DEPLOY).toContain('timeout-minutes: 30');
    expect(POST_DEPLOY).toMatch(/node-version: 22/);
  });
});

describe('.github/workflows/verify-deployed.yml · PR preview gate (branch-protection-required post-deploy check)', () => {
  // Branch protection requires a real post-deploy check on PRs, and GitHub
  // blocks merges forever on a required check that never reports. The
  // production job only fires on Production deployment_status events, so PRs
  // need their own: the preview gate below fires on successful PREVIEW
  // deployments (which Vercel posts for every PR head) and asserts the
  // preview serves the PR head commit. Locking it here keeps the exact job
  // name — which branch protection references verbatim — from drifting.
  const previewBlock = POST_DEPLOY.slice(POST_DEPLOY.indexOf('\n  verify-preview-deploy:'));

  it('keeps the job with the exact name branch protection requires', () => {
    expect(previewBlock.length).toBeGreaterThan(0);
    expect(previewBlock).toContain('name: Verify PR preview deploy (hash gate)');
  });

  it('fires only on successful Preview deployments with a URL (never Production)', () => {
    // Production deployments are the production job's job (verify:live +
    // hash + alias drift). The preview gate must not double-run them — the
    // environment filter is the load-bearing half.
    expect(previewBlock).toContain("github.event.deployment_status.state == 'success'");
    // Same dual-form environment gating as the production job: bare "Preview"
    // (single linked project) OR "Preview – cook-with-freebuff" (multi-project
    // disambiguation) — so a future second linked project can never silently
    // skip this gate.
    expect(previewBlock).toContain("(github.event.deployment_status.environment == 'Preview' || startsWith(github.event.deployment_status.environment, 'Preview – cook-with-freebuff'))");
    expect(previewBlock).toContain("github.event.deployment_status.target_url != ''");
    expect(previewBlock).not.toContain("environment == 'Production'");
  });

  it('still runs the exact-deployment hash assertion against the PR head', () => {
    // The same inference-vs-verify closure the production job has: the
    // preview Vercel just built (target_url) must record the PR head commit
    // (deployment.sha). Dropping the step — or the --expect wiring — would
    // let a preview that isn't the PR head go green.
    expect(previewBlock).toContain('name: Verify the preview serves the PR head commit');
    expect(previewBlock).toContain('node scripts/verify-deployed-hash.mjs');
    expect(previewBlock).toContain('--url "${{ github.event.deployment_status.target_url }}"');
    expect(previewBlock).toContain('--expect "${{ github.event.deployment.sha }}"');
    expect(previewBlock).toContain("if: ${{ env.VERCEL_TOKEN != '' }}");
    expect(previewBlock).toContain('run: |');
  });

  it('wires VERCEL_TOKEN into the job env AND the verify step env, with a loud guard on the canonical repo', () => {
    // Job env (feeds the step `if`) + the verify step's own env — dropping
    // either silently disables the gate. The loud guard is the fork-safe
    // half: skip-not-fail on forks (no secrets), hard fail on the canonical
    // repo so a missing token can't masquerade as a green preview check.
    const tokenWiring = SECRET_WIRING('VERCEL_TOKEN').replace(/[$\\{\\}]/g, '\\$&');
    expect(previewBlock.match(new RegExp(tokenWiring, 'g'))).toHaveLength(2);
    expect(previewBlock).toContain('name: Fail loudly if VERCEL_TOKEN is missing (preview deploy)');
    expect(previewBlock).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(previewBlock).toContain('exit 1');
  });

  it('stays lightweight — no verify:live, no Firestore secrets, no Firestore writes in the preview gate', () => {
    // The preview gate exists to give branch protection a real check WITHOUT
    // burning the owner-verify write budget on every PR (the reason the
    // write-heavy verify:live stays Production-only). Reintroducing
    // verify:live — or the four Firestore secrets — into the preview job
    // fails here.
    expect(previewBlock).not.toContain('npm run verify:live');
    expect(previewBlock).not.toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(previewBlock).not.toContain('APP_OWNER_UID');
  });

  it('keeps the run-safety envelope (10-minute budget, Node 22)', () => {
    expect(previewBlock).toContain('timeout-minutes: 10');
    expect(previewBlock).toMatch(/node-version: 22/);
  });
});
