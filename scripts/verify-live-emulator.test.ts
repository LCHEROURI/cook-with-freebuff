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
});

describe('verify:live · [2b] model resolution proof', () => {
  it('mirrors the five-role table (rcParam → envVar → default) without a TS import', () => {
    // The .mjs cannot import lib/ai/model-roles.ts, so it mirrors the table.
    // Every role's parameter, env var and default must be pinned so a drift
    // between the mirror and the server table fails here.
    expect(VERIFY_LIVE).toContain("rcParam: 'recipe_generation_model', envVar: 'RECIPE_GENERATION_MODEL', defaultModel: 'gemini-2.5-flash'");
    expect(VERIFY_LIVE).toContain("rcParam: 'recipe_validation_model', envVar: 'RECIPE_VALIDATION_MODEL', defaultModel: 'gemini-2.5-flash'");
    expect(VERIFY_LIVE).toContain("rcParam: 'conversation_model', envVar: 'CONVERSATION_MODEL', defaultModel: 'gemini-2.5-flash'");
    expect(VERIFY_LIVE).toContain("rcParam: 'vision_model', envVar: 'VISION_MODEL', defaultModel: 'gemini-2.5-flash'");
    expect(VERIFY_LIVE).toContain("rcParam: 'live_voice_model', envVar: 'LIVE_MODEL', defaultModel: 'gemini-3.1-flash-live-preview'");
  });

  it('reads the same published Remote Config template the server resolves from', () => {
    // The exact template lib/server/model-config.ts reads, via the admin SDK.
    expect(VERIFY_LIVE).toContain('getRemoteConfig(app).getTemplate()');
    expect(VERIFY_LIVE).toContain('parameter?.defaultValue?.value');
  });

  it('hard-asserts the live-voice model returned by /api/voice/token against Remote Config', () => {
    // A resolver that silently ignores Remote Config and returns the default
    // must fail the gate, not pass unnoticed.
    expect(VERIFY_LIVE).toContain("fetchJson(`${APP}/api/voice/token`, { method: 'POST', headers: AUTH })");
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
