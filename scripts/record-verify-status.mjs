#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/record-verify-status.mjs — record the post-deploy verify:live
// verdict to Firestore so the public /status page can show the last result.
//
// Runs as the LAST step of the verify-live CI job (if: always(), so a red run
// is recorded too — a failure must be visible, not vanish). Writes the fixed
// doc `deploy_status/verify_live`:
//
//   { verdict: 'success'|'failure'|'external', commitSha, ranAt, runUrl, reason? }
//
// 'external' is the Gemini prepayment-credits block (verify-live-classify):
// the deploy check passed but recipe generation and its downstream stages
// could not run — the /status page renders it distinctly instead of as a
// full verification. 'reason' is an OPTIONAL sub-field set only on a
// spared-live-session failure (a drill or an overlapping-run collision — the
// guard spared a genuinely live session): the verdict stays 'failure' (the
// run did fail) but the /status page labels it as intentional instead of
// showing a bare failure.
//
// The single-slot `verify_live` doc is overwritten on every run, so a later
// green run would erase a billing outage. When the verdict is 'external', the
// SAME record is additionally pinned to `deploy_status/last_external`, written
// ONLY on external (never on success/failure), so the /status page can show
// when the last Gemini-credits outage occurred without re-reading run logs —
// a recurring billing-outage pattern stays visible across later green runs.
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
import {
  SPARED_LIVE_REASON,
  VERDICT_EXTERNAL,
  VERDICT_FAILURE,
  VERDICT_SUCCESS,
} from './verify-live-classify.mjs';

// ── Status document schema ──────────────────────────────────────────────────
// The doc is trusted by the /api/status route, so it is validated here BEFORE
// persisting — a malformed commit or run URL can never be stored and later
// trusted. Same contract the repository layer enforces for every Firestore
// write (AGENTS.md: all writes are schema validated).
const verifyLiveStatusSchema = z.object({
  verdict: z.enum([VERDICT_SUCCESS, VERDICT_FAILURE, VERDICT_EXTERNAL]),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, 'commitSha must be a 40-hex git sha')
    .min(1),
  ranAt: z.string().min(1, 'ranAt is required'),
  runUrl: z
    .string()
    .refine((v) => v === '' || /^https?:\/\//.test(v), 'runUrl must be empty or an http(s) URL'),
  reason: z.enum([SPARED_LIVE_REASON]).optional(),
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
const reason = flag('--reason', process.env.VERIFY_REASON ?? '');
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); process.exit(1); };

if (!SA_JSON) { fail('FIREBASE_SERVICE_ACCOUNT required (already wired in the verify-live job env)'); }
if (verdict !== VERDICT_SUCCESS && verdict !== VERDICT_FAILURE && verdict !== VERDICT_EXTERNAL) {
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
  // Optional: only a spared-live-session reason is valid; an empty/absent
  // value stays undefined so the doc never carries a stale reason.
  ...(reason ? { reason } : {}),
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
  // Sticky Gemini-credits marker (see header): the single-slot verify_live doc
  // is overwritten by every run, so a later green run would erase the outage.
  // Pin the last 'external' run to its own doc, written ONLY here — a
  // success/failure run never touches it, so the last credits outage survives.
  if (verdict === VERDICT_EXTERNAL) {
    await db.collection('deploy_status').doc('last_external').set(parsed.data);
    ok(`pinned last Gemini-credits outage → deploy_status/last_external`);
  }
} catch (e) {
  fail(`could not write deploy_status: ${e instanceof Error ? e.message : e}`);
}
process.exit(0);
