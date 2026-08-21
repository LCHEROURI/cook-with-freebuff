#!/usr/bin/env node
// scripts/drill-live-session.mjs — committed drill helper for the
// guard-spare / guard-boundary / guard-regression comparators.
//
// Proves the clean-owner guard's LIVE_SESSION_GRACE_MS spare path in real CI:
// a session touched within the last 60s is a genuinely live concurrent run's
// session and must NEVER be archived — the guard fails THIS run loudly
// instead of yanking the other run's /cook session.
//
// Lives in scripts/ (tracked) because the drill comparators run it from CI
// checkouts — it used to sit in the gitignored .freebuff/ scratch dir, which
// made every scheduled drill fail with "Cannot find module
// .freebuff/drill-live-session.mjs" in the runner. Keep it tracked: a move
// back to a gitignored path silently breaks all three drill workflows.
//
// Modes:
//   --seed            create the session (fresh, slug recipeId — invisible to
//                     the pre-run sweep, inside the settle's idle window)
//   --touch           bump lastActivityAt to now (keep-alive)
//   --backdate <secs> set lastActivityAt to now - secs (boundary drill: hold
//                     the session just past the 60s grace at the guard read)
//   --status          print the doc's status + idle age
//   --delete          remove the session (post-run cleanup)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env.local */ }
}
loadEnv();

const OWNER_UID = process.env.APP_OWNER_UID;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!OWNER_UID) { console.error('✗ APP_OWNER_UID required'); process.exit(1); }
if (!SA_JSON) { console.error('✗ FIREBASE_SERVICE_ACCOUNT required'); process.exit(1); }

const sa = JSON.parse(SA_JSON);
const app = getApps()[0] ?? initializeApp({
  credential: cert({
    projectId: sa.project_id,
    clientEmail: sa.client_email,
    privateKey: sa.private_key.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore(app);

const ID = 'drill-live-session';

async function main() {
  const ref = db.collection('cooking_sessions').doc(ID);
  if (process.argv.includes('--delete')) {
    const snap = await ref.get();
    if (!snap.exists) { console.log(`nothing to delete — ${ID} absent`); return; }
    await ref.delete();
    console.log(`deleted ${ID} (was ${snap.data()?.status})`);
    return;
  }
  if (process.argv.includes('--status')) {
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${ID} absent`); return; }
    const s = snap.data();
    const idle = typeof s.lastActivityAt === 'number' ? `${Math.round((Date.now() - s.lastActivityAt) / 1000)}s idle` : 'idle unknown';
    console.log(`${ID}: ${s.status}, ${s.currentPhase}, recipe ${s.recipeId}, ${idle}`);
    const owner = await db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get();
    const active = owner.docs.filter((d) => { const x = d.data(); return x.status === 'ACTIVE' || x.status === 'PAUSED'; });
    console.log(`owner ACTIVE/PAUSED: ${active.length}`);
    return;
  }
  if (process.argv.includes('--touch')) {
    const snap = await ref.get();
    if (!snap.exists) { console.error(`${ID} absent — seed first`); process.exit(1); }
    await ref.update({ lastActivityAt: Date.now(), updatedAt: Date.now() });
    console.log(`touched ${ID} lastActivityAt → now (${new Date().toISOString()})`);
    return;
  }
  const backIdx = process.argv.indexOf('--backdate');
  if (backIdx !== -1) {
    const secs = Number(process.argv[backIdx + 1]);
    if (!Number.isFinite(secs) || secs <= 0) { console.error('--backdate <secs> requires a positive number'); process.exit(1); }
    const snap = await ref.get();
    if (!snap.exists) { console.error(`${ID} absent — seed first`); process.exit(1); }
    const target = Date.now() - secs * 1000;
    await ref.update({ lastActivityAt: target, updatedAt: target });
    console.log(`backdated ${ID} lastActivityAt → now - ${secs}s (${new Date(target).toISOString()}) — idle will read ~${secs}s`);
    return;
  }
  if (process.argv.includes('--seed')) {
    const existing = await ref.get();
    if (existing.exists) { console.error(`${ID} already exists — delete first`); process.exit(1); }
    const now = Date.now();
    await ref.set({
      userId: OWNER_UID,
      // Non-prefixed model-slug recipeId — invisible to the sweep's recipeId
      // discriminator (the live-run shape, e.g. a concurrent batch's session).
      recipeId: 'chicken_rice_onion_001',
      status: 'ACTIVE',
      currentPhase: 'COLLECTING_INGREDIENTS',
      phase: 'COLLECTING_INGREDIENTS',
      lastActivityAt: now, // FRESH: within the guard's 60s LIVE_SESSION_GRACE_MS
      createdAt: now,
      updatedAt: now,
      version: 1,
      note: 'synthetic live session seeded by .freebuff/drill-live-session.mjs (guard-spare drill)',
    });
    console.log(`seeded ${ID} (ACTIVE, COLLECTING_INGREDIENTS, recipe chicken_rice_onion_001, FRESH — must NOT be archived by the guard)`);
    return;
  }
  console.error('mode required: --seed | --touch | --backdate <secs> | --status | --delete');
  process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
