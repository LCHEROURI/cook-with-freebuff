import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-local.test.ts — lock the local-dev comparison driver.
//
// Same discipline as scripts/ci-workflows.test.ts: read the REAL script from
// disk (never a fixture) and assert the load-bearing pieces survive future
// edits, so a change that silently breaks the one-command local check —
// drifting the fixed port, dropping the process-group teardown (orphaned
// `next dev` processes), or losing the verify-live spawn / exit mirroring —
// fails here instead of at the next manual run.
//
// The three contracts the manual dance needed (learned the hard way):
//   1. Fixed port default — `next dev` must boot on a DEDICATED port (3100),
//      not the ephemeral port Next picks (which once collided with Freebuff's
//      own orchestrator answering 200 on `/`).
//   2. Process-group teardown — the dev server must spawn detached (own
//      group) and ALWAYS be killed by negative-pid group signal (npm + next +
//      workers), so no run can leak a listener.
//   3. verify-live spawn + exit mirroring — the real check must run against
//      the local BASE and its exit code must be the driver's own.
// ============================================================================

const SRC = readFileSync('scripts/verify-live-local.mjs', 'utf8');

describe('scripts/verify-live-local.mjs · fixed port default', () => {
  it('defaults to port 3100, overridable via VERIFY_LOCAL_PORT', () => {
    // The manual dance proved why this matters: Next's ephemeral port picked
    // 58699 — Freebuff's own orchestrator — which answered 200 on `/` and
    // 404 on /api/cook. A dedicated fixed default + env override is the lock.
    expect(SRC).toContain('VERIFY_LOCAL_PORT ?? 3100');
    expect(SRC).toContain('http://localhost:${PORT}');
    // The port must actually be passed to `next dev` (npm run dev -- --port).
    expect(SRC).toContain("spawn('npm', ['run', 'dev', '--', '--port', String(PORT)]");
  });
});

describe('scripts/verify-live-local.mjs · process-group teardown', () => {
  it('spawns the dev server detached into its own process group', () => {
    // Without `detached: true`, process.kill(-pid) would target a group the
    // child does not own and the teardown would silently miss npm + next +
    // workers — leaking a listener on every run.
    expect(SRC).toContain('detached: true');
    expect(SRC).toContain('const group = -dev.pid;');
  });

  it('kills the group with SIGTERM then SIGKILL in the always-runs teardown', () => {
    // Graceful first, hard-kill after a short grace. Both signals must exist
    // (a graceful-only teardown can leave next's workers alive).
    expect(SRC).toContain("process.kill(group, 'SIGTERM')");
    expect(SRC).toContain("process.kill(group, 'SIGKILL')");
    // The teardown must be unconditional — documented as "always runs" and
    // placed AFTER the verify spawn, so a FAILING verify still tears down.
    // Anchor the search at the teardown marker: the SIGINT/SIGTERM handlers
    // (registered before the boot wait) also kill the group, so a first-
    // occurrence match would be ambiguous.
    expect(SRC).toContain('Teardown (always runs)');
    const verify = SRC.indexOf("spawn(process.execPath, ['scripts/verify-live.mjs'");
    const teardown = SRC.indexOf('Teardown (always runs)');
    const sigkill = SRC.indexOf("process.kill(group, 'SIGKILL')", teardown);
    expect(verify).toBeGreaterThan(-1);
    expect(sigkill).toBeGreaterThan(verify);
  });

  it('also tears down on the boot-failure early exit', () => {
    // If the server never answers, the driver must still kill the group
    // before exiting — never leave a half-booted `next dev` behind.
    // Anchor the search at the boot-failure message: the SIGINT/SIGTERM
    // handlers (registered before the boot wait) also send SIGTERM, so the
    // first occurrence is no longer the early exit's kill.
    const bootFail = SRC.indexOf('dev server never answered on ${BASE} within 180s');
    const earlySigterm = SRC.indexOf("process.kill(group, 'SIGTERM')", bootFail);
    expect(bootFail).toBeGreaterThan(-1);
    expect(earlySigterm).toBeGreaterThan(bootFail);
    expect(SRC).toContain('process.exit(process.exitCode ?? 1);');
  });
});

describe('scripts/verify-live-local.mjs · verify-live spawn + exit mirroring', () => {
  it('runs the real check against the local BASE with inherited stdio', () => {
    // The check must be the SHARED driver (scripts/verify-live.mjs) pointed
    // at the local server via --app — not a reimplementation that could drift.
    expect(SRC).toContain("spawn(process.execPath, ['scripts/verify-live.mjs', '--app', BASE, '--probe-prefix', 'verify-local-']");
    // Both spawns (dev + verify) must inherit stdio so the operator sees the
    // full transcript; a drop on either would hide boot errors or check output.
    expect(SRC.match(/stdio: 'inherit'/g)).toHaveLength(2);
  });

  it('gives the local run its own probe namespace so a concurrent CI run can never touch its seed', () => {
    // The local run shares the production Firestore + owner uid with the
    // deployed CI verify, but passes `--probe-prefix verify-local-` — a
    // DISJOINT namespace from CI's `verify-live-`. A concurrent CI sweep
    // (which only matches `verify-live-`) can therefore never delete the
    // local run's in-flight seed, even transiently.
    expect(SRC).toContain("'--probe-prefix', 'verify-local-'");
    expect(SRC).toContain('never touch the local seed even transiently');
  });

  it('mirrors the verify child exit code (0 = PASS, 1 = FAIL)', () => {
    // The driver's verdict must be the check's verdict: the child's exit
    // resolves rc, and the final process.exit forwards rc (or the fail() code).
    expect(SRC).toContain("child.on('exit', (code) => resolveChild(code ?? 1));");
    expect(SRC).toContain('process.exit(process.exitCode ?? rc);');
  });

  it('warms the API routes AND the /login page BEFORE the verify spawn (compile before budgets)', () => {
    // verify-live.mjs gives each request a 30s budget; the on-demand dev
    // compilation of /api/cook + /api/agent must happen before that budget
    // starts, or a cold first hit eats it. The [2c] stage drives /login with
    // headless Chrome, so the page must be warmed too. Index ordering locks
    // the sequence.
    const warmCook = SRC.indexOf("warmRoute('/api/cook')");
    const warmAgent = SRC.indexOf("warmRoute('/api/agent')");
    const warmLogin = SRC.indexOf("warmPage('/login')");
    const verify = SRC.indexOf("spawn(process.execPath, ['scripts/verify-live.mjs'");
    expect(warmCook).toBeGreaterThan(-1);
    expect(warmAgent).toBeGreaterThan(-1);
    expect(warmLogin).toBeGreaterThan(-1);
    expect(warmLogin).toBeGreaterThan(warmAgent);
    expect(verify).toBeGreaterThan(warmLogin);
    expect(SRC).toContain('AbortSignal.timeout(60_000)');
  });

  it('keeps the full sequence: boot → warm → verify → teardown → exit', () => {
    const boot = SRC.indexOf("spawn('npm', ['run', 'dev'");
    const warm = SRC.indexOf("warmRoute('/api/cook')");
    const verify = SRC.indexOf("spawn(process.execPath, ['scripts/verify-live.mjs'");
    const teardown = SRC.indexOf('Teardown (always runs)');
    const sigkill = SRC.indexOf("process.kill(group, 'SIGKILL')", teardown);
    const exit = SRC.indexOf('process.exit(process.exitCode ?? rc);');
    for (const [name, i] of [['boot', boot], ['warm', warm], ['verify', verify], ['sigkill', sigkill], ['exit', exit]]) {
      expect(i).toBeGreaterThan(-1); // each anchor must exist — a reorder fails legibly
    }
    expect(warm).toBeGreaterThan(boot);
    expect(verify).toBeGreaterThan(warm);
    expect(sigkill).toBeGreaterThan(verify);
    expect(exit).toBeGreaterThan(sigkill);
  });
});
