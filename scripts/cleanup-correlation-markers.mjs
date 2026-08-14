#!/usr/bin/env node
// ============================================================================
// scripts/cleanup-correlation-markers.mjs — bound the correlation_markers
// collection.
//
// correlation_markers is the durable idempotency store: every session
// transition that carries a correlation id (pause, resume, done, …) writes
// one doc, and the rollback path clears it in the same transaction. Markers
// are only ever READ within a client retry window (seconds to minutes); a
// marker that has outlived the TTL can never suppress a live transition, so
// it is pure growth. This script deletes every marker older than the cutoff,
// including the historical raw-key (pre-encoding) docs — draining the legacy
// namespace the same way the rollback clear does.
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
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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
// Firestore hard limit: at most 500 writes per batch.
const BATCH_SIZE = 500;

if (!Number.isFinite(TTL_DAYS) || TTL_DAYS < 1) {
  console.error(
    `✗ FAIL: MARKER_TTL_DAYS must be a positive number of days (got ${process.env.MARKER_TTL_DAYS ?? 'unset'}) — refusing to run.`,
  );
  process.exit(1);
}

// ── Admin init: emulator-aware, mirroring lib/server/admin.ts ───────────────
let app;
if (process.env.FIRESTORE_EMULATOR_HOST) {
  // Local emulator mode needs no service account.
  app = getApps()[0] ?? initializeApp({ projectId: 'demo-cook-with-freebuff' });
} else {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) {
    console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT (inline JSON) is required outside emulator mode');
    process.exit(1);
  }
  let sa;
  try {
    // Parse RAW — the env value is already JSON-escaped; unescaping before
    // parse would corrupt embedded \n sequences (same as admin-list-data.mjs).
    sa = JSON.parse(saRaw);
  } catch {
    console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    process.exit(1);
  }
  app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: sa.private_key.replace(/\\n/g, '\n'),
      }),
    });
}
const db = getFirestore(app);

// ── Sweep ───────────────────────────────────────────────────────────────────
const cutoff = Date.now() - TTL_DAYS * 86_400_000;
const CUTOFF_ISO = new Date(cutoff).toISOString();
console.log(
  `correlation_markers cleanup — deleting docs with markedAt < ${CUTOFF_ISO} (${TTL_DAYS}d)${DRY_RUN ? ' [DRY RUN — nothing will be written]' : ''}`,
);

let deleted = 0;
let pages = 0;
let lastDoc = null;
try {
  while (true) {
    // Single-field range + orderBy on the same field needs no composite index.
    // Pagination via startAfter keeps pages bounded and the sweep resumable.
    let q = db
      .collection('correlation_markers')
      .where('markedAt', '<', cutoff)
      .orderBy('markedAt')
      .limit(BATCH_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    pages += 1;
    lastDoc = snap.docs[snap.size - 1];
    if (!DRY_RUN) {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
    }
    deleted += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }
  console.log(`✓ ${DRY_RUN ? 'would delete' : 'deleted'} ${deleted} stale marker doc(s) across ${pages} page(s)`);
} catch (e) {
  console.error('✗ FAIL: cleanup error —', e?.message ?? String(e));
  process.exit(1);
}
process.exit(0);
