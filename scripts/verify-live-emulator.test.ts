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
