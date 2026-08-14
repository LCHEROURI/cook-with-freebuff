#!/usr/bin/env node
// ============================================================================
// scripts/cleanup-correlation-markers.ts — bound the correlation_markers
// collection.
//
// correlation_markers is the durable idempotency store: every session
// transition that carries a correlation id (pause, resume, done, …) writes
// one doc, and the rollback path clears it in the same transaction. Markers
// are only ever READ within a client retry window (seconds to minutes); a
// marker that has outlived the TTL can never suppress a live transition, so
// it is pure growth. The sweep deletes every marker older than the cutoff,
// including the historical raw-key (pre-encoding) docs — draining the legacy
// namespace the same way the rollback clear does.
//
// This script is the thin CLI wrapper: env loading, TTL validation, dry-run.
// The sweep itself and every Firestore write live behind the repository
// boundary (deleteStaleCorrelationMarkers in lib/server/repositories.ts,
// Codex P1, PR #70 review) — the script has no raw Firestore access, and
// admin initialization is inherited from lib/server/admin.ts (emulator-aware,
// reads FIREBASE_SERVICE_ACCOUNT outside the emulator).
//
// Safe by construction:
//   • only deletes docs with markedAt < cutoff; the default 30-day cutoff is
//     far longer than any possible retry window, so no live marker is touched
//   • MARKER_TTL_DAYS < 1 is rejected — the script can never be told to
//     delete everything
//   • batch deletes at Firestore's 500-write batch limit, page by page
//   • idempotent and resumable: re-running is a no-op
//   • DRY_RUN=1 prints what would be deleted and writes nothing
//   • docs without a numeric markedAt are skipped by the range query (the
//     schema enforces a numeric markedAt at every write path, so these should
//     not exist)
//
// Usage:
//   npm run cleanup:markers                  # real run, 30-day cutoff
//   MARKER_TTL_DAYS=7 npm run cleanup:markers
//   DRY_RUN=1 npm run cleanup:markers        # preview, writes nothing
//   FIRESTORE_EMULATOR_HOST=localhost:8080 npm run cleanup:markers
//
// Requires FIREBASE_SERVICE_ACCOUNT (inline JSON) for production; the
// emulator branch needs no credentials.
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deleteStaleCorrelationMarkers } from '../lib/server/repositories';

// ── Env loading (process.env wins; .env.local fills the gaps) ───────────────
function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch {
    // No .env.local — rely on process.env.
  }
}
loadEnv();

const TTL_DAYS = Number(process.env.MARKER_TTL_DAYS ?? 30);
const DRY_RUN = process.env.DRY_RUN === '1';

if (!Number.isFinite(TTL_DAYS) || TTL_DAYS < 1) {
  console.error(
    `✗ FAIL: MARKER_TTL_DAYS must be a positive number of days (got ${process.env.MARKER_TTL_DAYS ?? 'unset'}) — refusing to run.`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const cutoff = Date.now() - TTL_DAYS * 86_400_000;
  const CUTOFF_ISO = new Date(cutoff).toISOString();
  console.log(
    `correlation_markers cleanup — deleting docs with markedAt < ${CUTOFF_ISO} (${TTL_DAYS}d)${DRY_RUN ? ' [DRY RUN — nothing will be written]' : ''}`,
  );
  try {
    const { deleted, pages } = await deleteStaleCorrelationMarkers(cutoff, { dryRun: DRY_RUN });
    console.log(`✓ ${DRY_RUN ? 'would delete' : 'deleted'} ${deleted} stale marker doc(s) across ${pages} page(s)`);
    process.exit(0);
  } catch (e) {
    console.error('✗ FAIL: cleanup error —', (e as Error)?.message ?? String(e));
    process.exit(1);
  }
}

void main();
