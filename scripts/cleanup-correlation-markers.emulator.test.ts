// ============================================================================
// scripts/cleanup-correlation-markers.emulator.test.ts — run the REAL cleanup
// script against a LIVE Firestore emulator.
//
// The contract test locks the script's safety properties by source; this
// suite proves them behaviorally: it seeds stale + fresh correlation markers
// into the emulator, spawns the actual script (child process, own admin
// init), and asserts the stale docs are gone and the fresh ones survive.
// Real emulator semantics are what make it discriminating — range queries,
// snapshot-based pagination, and the 500-write batch limit are enforced by
// the emulator, not modeled by the test.
//
// Running: same gating as the other emulator tests — `npm run test:emulator`
// (boots its own emulator, needs Java 21) or `npm run emulators` + `npm test`
// (reuses). Skips fast otherwise.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { Firestore } from 'firebase-admin/firestore';
import {
  EMULATOR_HOST,
  AUTO_BOOT,
  bootEmulator,
} from './emulator-test-helper';

vi.mock('server-only', () => ({}));

let emulator: { stop: () => Promise<void> } | null = null;
let bootError = '';
try {
  emulator = await bootEmulator();
} catch (e) {
  bootError = e instanceof Error ? e.message : String(e);
}
if (!emulator && AUTO_BOOT) {
  throw new Error(`RUN_EMULATOR_TESTS=1 but the Firestore emulator could not start:\n${bootError}`);
}

const ROOT = process.cwd();
const DAY = 86_400_000;

/** Spawn the real cleanup script with the given extra env; collect its output. */
function runCleanup(extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = spawn(process.execPath, ['scripts/cleanup-correlation-markers.mjs'], {
      cwd: ROOT,
      env: { ...process.env, FIRESTORE_EMULATOR_HOST: EMULATOR_HOST, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

describe.skipIf(!emulator)('correlation-marker cleanup · Firestore emulator', () => {
  let db: Firestore;
  const seeded: string[] = [];

  async function seedMarker(id: string, markedAt: number): Promise<void> {
    seeded.push(id);
    await db.collection('correlation_markers').doc(id).set({ markedAt, rawId: id });
  }

  beforeAll(async () => {
    // The real admin module must see the emulator host BEFORE its first
    // import (lib/server/admin.ts caches its Firestore instance).
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
    const { getAdminDb } = await import('../lib/server/admin');
    db = getAdminDb()!;
    expect(db).not.toBeNull();
  });

  afterAll(async () => {
    // Best-effort cleanup of this file's seeded docs (a reused dev emulator
    // exports on exit, so leftover probe markers would persist).
    try {
      for (const id of seeded) {
        await db.collection('correlation_markers').doc(id).delete();
      }
    } catch {
      /* best effort */
    }
    await emulator?.stop();
  });

  it('deletes markers older than the TTL cutoff and keeps fresh ones', async () => {
    const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    // One legacy raw-key doc (the pre-encoding namespace) and one encoded-key
    // doc, both 2 days old; one fresh doc 1 hour old.
    const staleRaw = `stale-raw-${run}`;
    const staleEncoded = `stale-encoded-${run}`;
    const fresh = `fresh-${run}`;
    await seedMarker(staleRaw, Date.now() - 2 * DAY);
    await seedMarker(staleEncoded, Date.now() - 2 * DAY);
    await seedMarker(fresh, Date.now() - 3_600_000);

    const { code, stdout, stderr } = await runCleanup({ MARKER_TTL_DAYS: '1' });
    // stderr may carry Node's benign punycode deprecation warning — the real
    // failure signal is the script's own ✗ FAIL line.
    expect(stderr).not.toContain('✗ FAIL');
    expect(code).toBe(0);
    expect(stdout).toContain('deleted 2 stale marker doc(s)');
    expect((await db.collection('correlation_markers').doc(staleRaw).get()).exists).toBe(false);
    expect((await db.collection('correlation_markers').doc(staleEncoded).get()).exists).toBe(false);
    expect((await db.collection('correlation_markers').doc(fresh).get()).exists).toBe(true);
  }, 60_000);

  it('DRY_RUN=1 reports what would be deleted and writes nothing', async () => {
    const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const stale = `dry-stale-${run}`;
    await seedMarker(stale, Date.now() - 2 * DAY);

    const { code, stdout } = await runCleanup({ MARKER_TTL_DAYS: '1', DRY_RUN: '1' });
    expect(code).toBe(0);
    expect(stdout).toContain('would delete 1 stale marker doc(s)');
    expect((await db.collection('correlation_markers').doc(stale).get()).exists).toBe(true);

    // Clear this doc so the multi-page test below sees exactly its own 550.
    await db.collection('correlation_markers').doc(stale).delete();
  }, 60_000);

  it('sweeps more than one page (550 stale docs) and keeps fresh ones', async () => {
    const run = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const fresh = `bulk-fresh-${run}`;
    await seedMarker(fresh, Date.now() - 3_600_000);

    // 550 stale docs → two pages (500 + 50). All share the SAME markedAt so
    // continuation is purely snapshot-based (startAfter), the harder case.
    const t = Date.now() - 2 * DAY;
    for (let i = 0; i < 11; i++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, j) => {
          const id = `bulk-${run}-${i}-${j}`;
          seeded.push(id);
          return db.collection('correlation_markers').doc(id).set({ markedAt: t, rawId: id });
        }),
      );
    }

    const { code, stdout } = await runCleanup({ MARKER_TTL_DAYS: '1' });
    expect(code).toBe(0);
    expect(stdout).toContain('deleted 550 stale marker doc(s)');
    expect(stdout).toContain('across 2 page(s)');
    expect((await db.collection('correlation_markers').doc(fresh).get()).exists).toBe(true);
  }, 60_000);
});
