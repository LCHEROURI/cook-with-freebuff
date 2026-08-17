#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/record-verify-status.mjs — record the post-deploy verify:live
// verdict to Firestore so the public /status page can show the last result.
//
// Runs as the LAST step of the verify-live CI job (if: always(), so a red run
// is recorded too — a failure must be visible, not vanish). Writes the fixed
// doc `deploy_status/verify_live`:
//
//   { verdict: 'success'|'failure'|'external', commitSha, ranAt, runUrl }
//
// 'external' is the Gemini prepayment-credits block (verify-live-classify):
// the deploy check passed but recipe generation and its downstream stages
// could not run — the /status page renders it distinctly instead of as a
// full verification.
//
// The doc is written with the admin SDK, so it bypasses client rules (the
// catch-all deny keeps direct client reads blocked — the /status page reads
// it through the server route, never the client). Nothing sensitive: the
// verdict and commit are already public via the GitHub run.
//
// Usage (CI): node scripts/record-verify-status.mjs \
//   --verdict "${{ job.status }}" --commit "${{ github.sha }}" \
//   --run-url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
//
// Requires FIREBASE_SERVICE_ACCOUNT (inline JSON) — already in the verify-live
// job env, so the step wires no new secret.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// ── Status document schema ──────────────────────────────────────────────────
// The doc is trusted by the /api/status route, so it is validated here BEFORE
// persisting — a malformed commit or run URL can never be stored and later
// trusted. Same contract the repository layer enforces for every Firestore
// write (AGENTS.md: all writes are schema validated).
const verifyLiveStatusSchema = z.object({
  verdict: z.enum(['success', 'failure', 'external']),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, 'commitSha must be a 40-hex git sha')
    .min(1),
  ranAt: z.string().min(1, 'ranAt is required'),
  runUrl: z
    .string()
    .refine((v) => v === '' || /^https?:\/\//.test(v), 'runUrl must be empty or an http(s) URL'),
});

// ── Env loading (process.env wins; .env.local fills the gaps) ───────────────
function loadEnv() {
  try {
    const text = readFileSync(resolvePath(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env.local — CI passes vars directly */ }
}
loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const verdict = flag('--verdict', process.env.VERIFY_VERDICT ?? '');
const commitSha = flag('--commit', process.env.VERIFY_COMMIT_SHA ?? '');
const runUrl = flag('--run-url', process.env.VERIFY_RUN_URL ?? '');
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); process.exit(1); };

if (!SA_JSON) { fail('FIREBASE_SERVICE_ACCOUNT required (already wired in the verify-live job env)'); }
if (verdict !== 'success' && verdict !== 'failure' && verdict !== 'external') {
  fail(`verdict must be success|failure|external, got "${verdict}"`);
}
if (!commitSha) { fail('--commit <sha> required'); }

let app;
try {
  const sa = JSON.parse(SA_JSON);
  const existing = getApps();
  app = existing[0] ?? initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'),
    }),
  });
} catch (e) {
  fail(`could not initialize the admin SDK: ${e instanceof Error ? e.message : e}`);
}

const statusDoc = {
  verdict,
  commitSha,
  ranAt: new Date().toISOString(),
  runUrl: runUrl || '',
};
const parsed = verifyLiveStatusSchema.safeParse(statusDoc);
if (!parsed.success) {
  fail(`refusing to persist an invalid status document: ${parsed.error.issues
    .map((i) => `${i.path.join('.')} ${i.message}`)
    .join('; ')}`);
}

try {
  const db = getFirestore(app);
  const doc = db.collection('deploy_status').doc('verify_live');
  await doc.set(parsed.data);
  ok(`recorded verify:live ${verdict} for ${commitSha.slice(0, 12)} → deploy_status/verify_live`);
} catch (e) {
  fail(`could not write deploy_status/verify_live: ${e instanceof Error ? e.message : e}`);
}
process.exit(0);
