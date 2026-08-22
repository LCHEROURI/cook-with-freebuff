import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-emulator.test.ts — lock the emulator-mode verify:live.
//
// verify:live:emulator runs the deterministic guided-flow check against the
// LOCAL Firestore + Auth emulators, so a full lifecycle proof never touches
// production data. Its load-bearing properties are: verify-live.mjs opts into
// emulator mode via an explicit flag (not a silent env sniff), inits the demo
// project without a service account, mints the owner token through the auth
// emulator, and skips the production-only stages; the orchestrator boots the
// emulators + a dev server pointed at them and spawns verify:live with
// --emulator. A future edit that drops any of these fails here instead of
// silently re-pointing the check at production.
// ============================================================================

const VERIFY_LIVE = readFileSync('scripts/verify-live.mjs', 'utf8');
const ORCHESTRATOR = readFileSync('scripts/verify-live-emulator.mjs', 'utf8');
const BUILD_INFO = readFileSync('app/api/build-info/route.ts', 'utf8');
const PKG = readFileSync('package.json', 'utf8');

describe('verify:live:emulator · contract lock', () => {
  it('opts into emulator mode via the --emulator flag and VERIFY_EMULATOR=1', () => {
    expect(VERIFY_LIVE).toContain("process.argv.includes('--emulator')");
    expect(VERIFY_LIVE).toContain("process.env.VERIFY_EMULATOR === '1'");
  });

  it('inits the demo project without a service account in emulator mode', () => {
    expect(VERIFY_LIVE).toContain("'demo-cook-with-freebuff'");
    expect(VERIFY_LIVE).toContain("initializeApp({ projectId: EMULATOR_PROJECT_ID })");
  });

  it('mints the owner token through the auth emulator (createUser + signInWithPassword)', () => {
    expect(VERIFY_LIVE).toContain('auth.createUser({ uid: OWNER_UID');
    expect(VERIFY_LIVE).toContain('accounts:signInWithPassword');
    expect(VERIFY_LIVE).toContain('AUTH_EMULATOR_HOST');
    // The production path (custom token → real identitytoolkit) must still exist.
    expect(VERIFY_LIVE).toContain('accounts:signInWithCustomToken');
  });

  it('skips the production-only stages in emulator mode instead of running them', () => {
    expect(VERIFY_LIVE).toContain('if (!EMULATOR && !GUIDED_ONLY) {');
    expect(VERIFY_LIVE).toContain('guided flow only');
  });

  it('the orchestrator boots Firestore + Auth emulators under the demo project', () => {
    expect(ORCHESTRATOR).toContain("'emulators:start'");
    expect(ORCHESTRATOR).toContain("'--only', 'firestore,auth'");
    expect(ORCHESTRATOR).toContain("'--project', EMULATOR_PROJECT");
  });

  it('the orchestrator points the dev server at the emulators, not production', () => {
    expect(ORCHESTRATOR).toContain('FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST');
    expect(ORCHESTRATOR).toContain('FIREBASE_AUTH_EMULATOR_HOST: AUTH_HOST');
    expect(ORCHESTRATOR).toContain("NEXT_PUBLIC_USE_FIRESTORE_EMULATOR: '1'");
  });

  it('the orchestrator spawns verify-live with the --emulator flag', () => {
    expect(ORCHESTRATOR).toContain("'scripts/verify-live.mjs'");
    expect(ORCHESTRATOR).toContain("'--emulator'");
  });

  it('reuses an already-running emulator-pointed dev server instead of booting a second one', () => {
    expect(ORCHESTRATOR).toContain('findEmulatorServer');
    expect(ORCHESTRATOR).toContain('/api/build-info');
    expect(ORCHESTRATOR).toContain('body?.emulator === true');
    expect(ORCHESTRATOR).toContain('VERIFY_EMULATOR_APP_URL');
  });

  it('leaves a reused dev server running (teardown never kills it)', () => {
    expect(ORCHESTRATOR).toContain('if (!reusedDev && devGroup) {');
    expect(ORCHESTRATOR).toContain('dev server left running (reused');
  });

  it('the app reports emulator mode via /api/build-info (bare boolean, no host)', () => {
    expect(BUILD_INFO).toContain('emulator: !!process.env.FIRESTORE_EMULATOR_HOST');
  });

  it('is wired as the one-command npm script', () => {
    expect(PKG).toContain('"verify:live:emulator": "node scripts/verify-live-emulator.mjs"');
  });
});

describe('verify:live · App Check enforcement probe', () => {
  it('probes an unattested request and treats 403 APP_CHECK_FAILED as enforced', () => {
    // The negative path the happy flow can't show: a valid owner request with
    // NO App Check token must be 403'd when enforcement is on, so a silently
    // disabled gate can't masquerade as a green run. list_recipes is the
    // read-only action, so the probe writes nothing.
    expect(VERIFY_LIVE).toContain("headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' }");
    expect(VERIFY_LIVE).toContain("{ action: 'list_recipes' }");
    expect(VERIFY_LIVE).toContain("noAppCheck.status === 403 && noAppCheck.body?.error?.code === 'APP_CHECK_FAILED'");
  });

  it('only probes the deployed server, never the emulator (which always passes App Check)', () => {
    expect(VERIFY_LIVE).toContain('if (!EMULATOR) {');
    expect(VERIFY_LIVE).toContain('App Check enforced — unattested request rejected 403');
  });

  it('reports the probe result as a note, not a status line, so verify:live:compare stays clean', () => {
    // A ✓ here would leak into verify-live-compare's status-line diff (the
    // local leg runs monitor mode), so the enforced case must stay a note().
    expect(VERIFY_LIVE).toContain("note(`App Check enforced — unattested request rejected 403");
  });

  it('fails the harness when enforcement is required but the server is in monitor mode', () => {
    expect(VERIFY_LIVE).toContain("process.argv.includes('--require-app-check-enforced')");
    expect(VERIFY_LIVE).toContain('App Check enforcement required but the deployed server accepted an unattested request');
  });

  it('pairs the negative probe with an attested authenticated success in required mode', () => {
    expect(VERIFY_LIVE).toContain('if (REQUIRE_APP_CHECK_ENFORCED) {');
    expect(VERIFY_LIVE).toContain('const attested = await fetchJson(`${APP}/api/cook`');
    expect(VERIFY_LIVE).toContain("headers: AUTH");
    expect(VERIFY_LIVE).toContain("body: JSON.stringify({ action: 'list_recipes' })");
    expect(VERIFY_LIVE).toContain("attested.status === 200 && attested.body?.success === true");
    expect(VERIFY_LIVE).toContain('attested authenticated request succeeded');
  });

  it('mints a fresh App Check token for every single-use route probe', () => {
    expect(VERIFY_LIVE).toContain('const freshAppCheckAuth = async () =>');
    expect(VERIFY_LIVE).toContain("fetchJson(`${APP}/api/voice/token`, { method: 'POST', headers: await freshAppCheckAuth() })");
    expect(VERIFY_LIVE.match(/headers: await freshAppCheckAuth\(\)/g)).toHaveLength(3);
  });
});

describe('verify:live · [2b] model resolution proof', () => {
  it('mirrors lib/ai/model-roles.ts exactly (parses the real table, so drift fails here)', () => {
    // The .mjs cannot import lib/ai/model-roles.ts, so it mirrors the table.
    // Hardcoding the five strings here would only prove the mirror contains
    // SOME values, not that they match the shared table. Parse the real table
    // and assert every role's full entry appears in the mirror, so an edit to
    // MODEL_ROLES that misses the mirror fails this test instead of the
    // deployed verifier querying a stale parameter.
    const ROLES_SRC = readFileSync('lib/ai/model-roles.ts', 'utf8');
    const entries = [...ROLES_SRC.matchAll(/\{\s*role:\s*'([^']+)',\s*rcParam:\s*'([^']+)',\s*envVar:\s*'([^']+)',\s*defaultModel:\s*'([^']+)'\s*\}/g)];
    expect(entries.length).toBe(5);
    for (const [, role, rcParam, envVar, defaultModel] of entries) {
      expect(VERIFY_LIVE).toContain(`{ role: '${role}', rcParam: '${rcParam}', envVar: '${envVar}', defaultModel: '${defaultModel}' }`);
    }
  });

  it('reads the same published Remote Config template the server resolves from', () => {
    // The exact template lib/server/model-config.ts reads, via the admin SDK.
    expect(VERIFY_LIVE).toContain('getRemoteConfig(app).getTemplate()');
    expect(VERIFY_LIVE).toContain('parameter?.defaultValue?.value');
  });

  it('hard-asserts the live-voice model returned by /api/voice/token against Remote Config', () => {
    // A resolver that silently ignores Remote Config and returns the default
    // must fail the gate, not pass unnoticed.
    expect(VERIFY_LIVE).toContain("fetchJson(`${APP}/api/voice/token`, { method: 'POST', headers: await freshAppCheckAuth() })");
    expect(VERIFY_LIVE).toContain('returnedModel === rcLive');
    expect(VERIFY_LIVE).toContain('the resolver ignored Remote Config');
  });

  it('runs production-only, guarded by if (!EMULATOR && !GUIDED_ONLY)', () => {
    // The stage must not run in the emulator leg or the --guided-only compare
    // reference leg (its note lines would disturb the compare diff). The [2b]
    // guard is a SECOND occurrence of the production-only gate (the [3b]
    // starter block is the first).
    expect(VERIFY_LIVE).toContain('[2b] Model resolution proof');
    const guardCount = VERIFY_LIVE.match(/if \(!EMULATOR && !GUIDED_ONLY\) \{/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });
});

describe('verify:live · [2b.2] model_source log smoke', () => {
  it('mints a logging.read-scoped OAuth token from the deploy SA (the authorize-domain.mjs pattern)', () => {
    // The smoke reads Cloud Logging with the SAME credential the run already
    // has (FIREBASE_SERVICE_ACCOUNT), scoped to logging.read only. A missing
    // or differently-scoped mint must fail this contract.
    expect(VERIFY_LIVE).toContain("const LOG_SCOPE = 'https://www.googleapis.com/auth/logging.read';");
    expect(VERIFY_LIVE).toContain('grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('queries Cloud Logging entries:list filtered to model_source events in a bounded window', () => {
    // The deployed server emits one model_source line per role at boot
    // (lib/server/model-config.ts). The smoke reads exactly those lines so a
    // boot that silently fell back to env/default fails the gate.
    expect(VERIFY_LIVE).toContain("fetch('https://logging.googleapis.com/v2/entries:list'");
    expect(VERIFY_LIVE).toContain('jsonPayload.event="model_source"');
    expect(VERIFY_LIVE).toContain('orderBy: \'timestamp desc\'');
  });

  it('scopes the query to the deployed revision so a previous boot can never stand in', () => {
    // The deploy job waited for GITHUB_SHA; each model_source line carries the
    // app's stamped commit, so the filter correlates records to the revision
    // under test. Without this, a healthy previous boot's lines in the window
    // could satisfy every role while the fresh (broken) revision passes.
    expect(VERIFY_LIVE).toContain("const deployedSha = process.env.GITHUB_SHA ?? '';");
    expect(VERIFY_LIVE).toContain('jsonPayload.commit="');
  });

  it('keeps checking the remaining roles after a missing entry instead of crashing the verifier', () => {
    // fail() records and continues (it never throws), so the missing-entry
    // branch must guard the deref that follows: a TypeError would skip every
    // stage after [2b] and hide the real diagnostics. The guard is the
    // continue directly after the no-entry fail, not a stray continue
    // elsewhere in the file.
    const noEntryIdx = VERIFY_LIVE.indexOf('no log entry for role');
    const guardIdx = VERIFY_LIVE.indexOf('continue;', noEntryIdx);
    expect(noEntryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(noEntryIdx);
    expect(guardIdx - noEntryIdx).toBeLessThan(400);
  });

  it('hard-asserts every role resolved from remote-config with the template model', () => {
    // All five roles, not just live-voice: a resolver drift on any role must
    // fail the gate, and a model that disagrees with the template must too.
    expect(VERIFY_LIVE).toContain("entry.source !== 'remote-config'");
    expect(VERIFY_LIVE).toContain('Remote Config is NOT authoritative');
    expect(VERIFY_LIVE).toContain('template and runtime drifted');
    expect(VERIFY_LIVE).toContain('resolved from remote-config');
  });

  it('fails loudly (never skips) when the SA cannot read Cloud Logging (missing roles/logging.viewer)', () => {
    // A 403 must be a distinct FAIL naming the IAM gap, so RC drift can never
    // hide behind a silently skipped check.
    expect(VERIFY_LIVE).toContain('grant roles/logging.viewer');
    expect(VERIFY_LIVE).toContain('the smoke cannot run and RC drift would go unnoticed');
  });

  it('retries the query to ride out Cloud Logging ingestion lag', () => {
    // Ingestion can lag a boot's lines by tens of seconds; the smoke re-queries
    // (bounded) until every role's entry lands before failing on a missing one.
    expect(VERIFY_LIVE).toContain('MAX_LOG_ATTEMPTS');
    expect(VERIFY_LIVE).toContain('waiting for log ingestion');
  });
});
