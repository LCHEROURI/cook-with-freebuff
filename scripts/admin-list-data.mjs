#!/usr/bin/env node
// ============================================================================
// scripts/admin-list-data.mjs — one-command read of the owner's Firestore data.
//
// Lists the owner's recipes and pantry items (the two collections most useful
// for a quick "what is in the app right now" check) straight from Firestore
// via the Admin SDK, the same server-side path the API routes use.
//
// READ-ONLY: it never writes or deletes, so it is safe against production.
//
// Usage:
//   npm run admin:list                # the owner (APP_OWNER_UID)
//   npm run admin:list -- --uid <uid> # any user, e.g. a probe account
//
// Requires FIREBASE_SERVICE_ACCOUNT (inline JSON) + APP_OWNER_UID in
// process.env or .env.local (see .env.example).
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

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const OWNER_UID = process.env.APP_OWNER_UID;
const UID = flag('--uid') ?? OWNER_UID;

if (!SA_JSON) {
  console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT (inline JSON) is required');
  process.exit(1);
}
if (!UID) {
  console.error('✗ FAIL: APP_OWNER_UID is required (or pass --uid <uid>)');
  process.exit(1);
}

let sa;
try {
  // Parse RAW — the env value is already JSON-escaped; unescaping before
  // parse would corrupt embedded \n sequences.
  sa = JSON.parse(SA_JSON);
} catch {
  console.error('✗ FAIL: FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  process.exit(1);
}

const app =
  getApps()[0] ??
  initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'), // same as lib/server/admin.ts
    }),
  });
const db = getFirestore(app);

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'n/a');
const list = (arr) => (arr && arr.length ? arr.join(', ') : 'none');
const qty = (q, u) => {
  const parts = [];
  if (q != null) parts.push(String(q));
  if (u) parts.push(u);
  return parts.join(' ');
};

try {
  // Owner-scoped reads only — never a full collection scan. Sorting is done
  // client-side so the script needs no composite index to run.
  const [recipesSnap, pantrySnap] = await Promise.all([
    db.collection('recipes').where('userId', '==', UID).get(),
    db.collection('pantry_items').where('userId', '==', UID).get(),
  ]);

  const recipes = recipesSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0));
  const pantry = pantrySnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

  console.log(`Owner data (uid ${UID})\n`);

  console.log(`Recipes (${recipes.length})`);
  if (recipes.length === 0) {
    console.log('  none\n');
  }
  for (const r of recipes) {
    console.log(`  • ${r.title ?? '(untitled)'}`);
    console.log(
      `    ${r.servings ?? '?'} servings · ${r.totalMinutes ?? '?'} min · protein: ${list(r.proteinCategories)}`,
    );
    console.log(
      `    tags: ${list(r.dietaryTags)} · allergens: ${list(r.allergens)}`,
    );
    console.log(`    id: ${r.id} · generated ${date(r.generatedAt)}\n`);
  }

  console.log(`Pantry (${pantry.length})`);
  if (pantry.length === 0) {
    console.log('  none\n');
  }
  for (const p of pantry) {
    const amount = qty(p.quantity, p.unit);
    console.log(`  • ${p.name ?? '(unnamed)'}`);
    console.log(
      `    ${amount ? amount + ' · ' : ''}confidence ${p.confidence ?? '?'} · source ${p.source ?? 'n/a'} · last confirmed ${date(p.lastConfirmedAt)}`,
    );
    if (p.expirationDate) {
      console.log(`    expires ${date(p.expirationDate)}`);
    }
    console.log(`    id: ${p.id}\n`);
  }
} catch (e) {
  console.error('✗ FAIL: could not read Firestore —', e?.message ?? String(e));
  process.exit(1);
}
