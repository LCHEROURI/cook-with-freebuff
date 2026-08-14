// ============================================================================
// scripts/emulator-test-helper.ts — shared Firestore-emulator lifecycle for
// the emulator-backed integration tests (rollback-resume marker atomicity,
// correlation-marker cleanup). Boots a fresh emulator when RUN_EMULATOR_TESTS
// is set, reuses one that is already running (e.g. `npm run emulators`), and
// returns null (caller skips) otherwise.
//
// The Firestore emulator requires Java 21+ (see the README); the CI jobs that
// run these tests (emulator-compare) set up Java 21 explicitly.
// ============================================================================

import { spawn } from 'node:child_process';
import net from 'node:net';

export const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
export const EMULATOR_PORT = Number(EMULATOR_HOST.split(':').slice(-1)[0]);
export const AUTO_BOOT = process.env.RUN_EMULATOR_TESTS === '1';
export const EMULATOR_PROJECT = 'demo-cook-with-freebuff';

export function portInUse(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        res(v);
      }
    };
    s.once('connect', () => {
      s.destroy();
      finish(true);
    });
    s.once('error', () => finish(false));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      finish(false);
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** PIDs currently listening on a TCP port (lsof -t), for orphan sweeping. */
async function listenersOnPort(port: number): Promise<number[]> {
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Boot a Firestore emulator (or reuse a running one). Returns null when no
 * emulator is reachable and auto-boot is off — the caller skips then.
 * `stop()` no-ops for a reused emulator and fully tears down a booted one,
 * sweeping the port for orphaned Java listeners (firebase-tools' java child
 * can survive the npx process-group kill).
 */
export async function bootEmulator(): Promise<{ stop: () => Promise<void> } | null> {
  if (await portInUse(EMULATOR_PORT)) return { stop: async () => {} };
  if (!AUTO_BOOT) return null;

  const child = spawn(
    'npx',
    ['-y', 'firebase-tools@latest', 'emulators:start', '--only', 'firestore', '--project', EMULATOR_PROJECT],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout?.on('data', (d) => {
    log += d.toString();
  });
  child.stderr?.on('data', (d) => {
    log += d.toString();
  });

  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await portInUse(EMULATOR_PORT, '127.0.0.1', 500)) {
      up = true;
      break;
    }
    await sleep(1_000);
  }
  if (!up) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    throw new Error(
      `Firestore emulator did not come up on :${EMULATOR_PORT}\n${log.split('\n').filter(Boolean).slice(-8).join('\n')}`,
    );
  }
  // The port binds just before the emulator finishes internal init.
  await sleep(1_500);
  return {
    stop: async () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await sleep(1_000);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 6; i++) {
        if (!(await portInUse(EMULATOR_PORT))) return;
        await sleep(500);
      }
      for (const pid of await listenersOnPort(EMULATOR_PORT)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await sleep(500);
    },
  };
}
