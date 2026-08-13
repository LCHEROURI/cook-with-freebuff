#!/usr/bin/env node
// ============================================================================
// scripts/authorize-domain.mjs — add a deployment URL to the shared Firebase
// project's authorized domains using a service account.
//
//   node scripts/authorize-domain.mjs --domain https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app
//
// Google sign-in (Firebase Auth) only works from domains listed in the
// project's Authorized domains. This script reads the Identity Platform admin
// config, appends the domain if missing, and PATCHes it back — idempotent:
// exits 0 when already present. It makes the login page work on a fresh
// App Hosting URL without a console click.
//
// Reads the service account from FIREBASE_SERVICE_ACCOUNT (inline JSON) or
// FIREBASE_SERVICE_ACCOUNT_PATH (file), mints a Google OAuth token from the
// SA private key (JWT RS256 → token endpoint), then GET/PATCHes
// identitytoolkit.googleapis.com/admin/v2/projects/{project}/config.
// ============================================================================

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DOMAIN = new URL(flag('--domain', 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app')).hostname;
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'portfolio-app-freebuff2';
const CONFIG_URL = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;

// ── Service account (inline JSON or path, quotes stripped) ─────────────────
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

function getServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return inline;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) return readFileSync(path, 'utf8');
  return null;
}

/** Mint a Google OAuth access token from a service-account private key. */
async function mintServiceAccountToken(saRaw) {
  const sa = JSON.parse(saRaw);
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createSign('sha256').update(`${header}.${claims}`).sign(sa.private_key.replace(/\\n/g, '\n'));
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth token exchange → HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
  return body.access_token;
}

const saRaw = getServiceAccount();
if (!saRaw) {
  console.error('✗ FAIL: no service account (set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH)');
  process.exit(1);
}

let bearer;
try {
  bearer = await mintServiceAccountToken(saRaw);
} catch (err) {
  console.error(`✗ FAIL: token mint → ${err.message}`);
  process.exit(1);
}

const H = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

console.log(`[2/3] Reading admin config for ${PROJECT}`);
const getRes = await fetch(CONFIG_URL, { headers: H });
const getJson = await getRes.json().catch(() => ({}));
if (!getRes.ok) {
  console.error(`✗ FAIL: GET config → ${getRes.status} ${JSON.stringify(getJson).slice(0, 200)}`);
  process.exit(1);
}
const current = getJson.authorizedDomains ?? [];

if (current.includes(DOMAIN)) {
  console.log(`  ✓ ${DOMAIN} already authorized — nothing to do`);
  console.log('\nRESULT: PASS');
  process.exit(0);
}

console.log(`[3/3] Adding ${DOMAIN}`);
const patchRes = await fetch(`${CONFIG_URL}?updateMask=authorizedDomains`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ authorizedDomains: [...current, DOMAIN] }),
});
const patchJson = await patchRes.json().catch(() => ({}));
if (!patchRes.ok) {
  console.error(`✗ FAIL: PATCH config → ${patchRes.status} ${JSON.stringify(patchJson).slice(0, 200)}`);
  process.exit(1);
}
const after = patchJson.authorizedDomains ?? [];
console.log(`  ✓ added — now ${after.length} domains (${after.includes(DOMAIN) ? 'present' : 'MISSING'})`);
console.log('\nRESULT: PASS');
process.exit(0);
