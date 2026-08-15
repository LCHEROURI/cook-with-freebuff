import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-login.test.ts — lock verify-live's LOGIN-POPUP gate.
//
// The one config regression the App Hosting migration shipped: the canonical
// hostname fell out of Firebase Auth's authorized domains, so the /login page
// dead-ended with "Sign-in is blocked" while every API-only verify stage stayed
// green (they mint tokens server-side and never touch the client popup). The
// [2c] stage closes that gap by spawning scripts/drive-login-popup.mjs against
// the deployed app: a FRESH headless Chrome profile clicks the real
// "Continue with Google" button and proves the OAuth popup opens (the SDK's
// origin check passed) with no domain banner. Same read-the-real-script
// discipline as verify-live-starter.test.ts / verify-live-voice.test.ts.
// ============================================================================

const SRC = readFileSync('scripts/verify-live.mjs', 'utf8');
const DRIVER = readFileSync('scripts/drive-login-popup.mjs', 'utf8');

describe('verify-live · [2c] login popup proof', () => {
  it('spawns the committed login-popup driver against the deployed app', () => {
    expect(SRC).toContain('[2c] Login popup proof');
    expect(SRC).toContain("spawnSync('node', ['scripts/drive-login-popup.mjs', '--app', APP, '--out', `/tmp/verify-live-login-${t}`], {");
    expect(SRC).toContain('timeout: 120_000');
  });

  it('requires RESULT: PASS and re-asserts the popup + no-banner markers (not a black box)', () => {
    // Exit 0 alone must not pass — the log must show the popup actually opened
    // and no domain banner appeared, otherwise a driver edit that drops the
    // assertions would fail the gate instead of passing silently.
    expect(SRC).toContain('loginDriver.status === 0 && /RESULT: PASS/.test(loginLog)');
    expect(SRC).toContain("ok('login popup driver → RESULT: PASS (OAuth popup opened, no domain error)')");
    expect(SRC).toContain("fail(`login popup driver → exit ${loginDriver.status ?? 'crash'}");
    expect(SRC).toContain("'OAuth popup opened and navigated to a Google auth URL'");
    expect(SRC).toContain("'no \"Sign-in is blocked\" banner after clicking'");
  });

  it('runs production-only (skips the emulator and guided-only legs)', () => {
    // The stage needs headless Chrome + the deployed host, so it sits in a
    // production-only guard like [3d]/[3e] and can never run against the
    // local emulators or the --guided-only compare reference leg. The count is
    // the [2c] guard plus the pre-existing driver stages, so it can never be
    // the only production-only block in the file.
    expect(SRC).toContain('[2c] Login popup proof');
    const guardCount = SRC.match(/if \(!EMULATOR && !GUIDED_ONLY\) \{/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });
});

describe('scripts/drive-login-popup.mjs · driver contract', () => {
  it('clicks the real button with a genuine CDP mouse click, never element.click()', () => {
    // A synthetic element.click() would not count as a user gesture in some
    // contexts and could pass while the real tap still fails. The driver must
    // dispatch real mousePressed/mouseReleased at the button's center.
    expect(DRIVER).toContain('Input.dispatchMouseEvent');
    expect(DRIVER).toContain("textContent.includes('Continue with Google')");
    expect(DRIVER).not.toContain('element.click()');
  });

  it('proves the popup via Target discovery and asserts no domain banner', () => {
    expect(DRIVER).toContain('Target.setDiscoverTargets');
    expect(DRIVER).toContain('OAuth popup opened and navigated to a Google auth URL');
    expect(DRIVER).toContain('no "Sign-in is blocked" banner after clicking');
  });

  it('uses a FRESH profile so a cached SDK origin rejection cannot hide a real config failure', () => {
    expect(DRIVER).toContain("`--user-data-dir=${USER_DATA_DIR}`");
    expect(DRIVER).toContain('rmSync(USER_DATA_DIR, { recursive: true, force: true })');
  });

  it('exits 0 with RESULT: PASS only when no failure was recorded', () => {
    expect(DRIVER).toContain("RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}");
    expect(DRIVER).toContain('process.exit(failures === 0 ? 0 : 1)');
  });

  it('loads env and resolves CHROME + APP the same way the other drivers do', () => {
    expect(DRIVER).toContain("flag('--app', process.env.VERIFY_BASE_URL)");
    expect(DRIVER).toContain('process.env.CHROME_PATH');
  });

  it('resolves Chrome cross-platform so the [2c] stage is CI-safe on linux/win/mac', () => {
    // The stage runs on the ubuntu-latest CI leg where the mac-only default
    // path would never exist. The driver must honour an explicit CHROME_PATH
    // first, then search each OS's real install locations, and fail fast if
    // the resolved binary cannot spawn.
    expect(DRIVER).toContain('function resolveChrome()');
    expect(DRIVER).toContain('existsSync(c)');
    expect(DRIVER).toContain('/usr/bin/google-chrome');
    expect(DRIVER).toContain('chrome.exe');
    expect(DRIVER).toContain("chrome.on('error'");
  });
});
