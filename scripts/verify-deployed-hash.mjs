#!/usr/bin/env node
// ============================================================================
// scripts/verify-deployed-hash.mjs — report the exact commit Vercel is
// serving, so the post-deploy gate never has to infer the hash from a
// successful push.
//
// Reads VERCEL_TOKEN from:
//   1. the VERCEL_TOKEN env var
//   2. .env.local (VERCEL_TOKEN=…)
//   3. the Vercel CLI auth store (~/Library/Application Support/
//      com.vercel.cli/auth.json) — the fallback that keeps local runs working
//      before a durable token is pasted into .env.local
//
// Usage:
//   node scripts/verify-deployed-hash.mjs
//     → latest READY production deployment: commit sha, URL, time
//   node scripts/verify-deployed-hash.mjs --url <deployed-url>
//     → the deployment serving THAT URL (preview or production; the URL may
//       be the canonical alias or the deployment-specific subdomain) — the
//       mode the CI deployment_status gate uses, driven by the event's
//       target_url
//   node scripts/verify-deployed-hash.mjs [--url <url>] --expect <sha>
//     → exits nonzero unless the deployed commit sha starts with <sha>
//   node scripts/verify-deployed-hash.mjs [--url <primary>] --compare-url <url>
//     → alias-routing drift watch: resolves the deployment serving <url>
//       (typically the canonical production alias) and asserts it serves the
//       SAME commit as the primary target — catches the canonical alias
//       pointing at an older/newer deployment than the deployment-specific
//       URL. Exits nonzero on drift; skips (exit 0, notice) if either
//       deployment records no commit sha.
//
// Flags COMBINE: --compare-url and --expect can be given together and the
// script exits nonzero if ANY requested check fails.
//
// Exit codes: 0 = PASS (or unverifiable skip), 1 = FAIL, 2 = VERCEL_TOKEN is
// invalid or revoked (Vercel flagged invalidToken:true) so callers can show
// the paste-a-fresh-token guidance instead of retrying. Read-only against the
// Vercel API; no source changes.
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'cook-with-freebuff';
export const PRODUCTION_URL = 'https://cook-with-freebuff.vercel.app';

/** The commit sha a Vercel deployment record is serving, if recorded. */
export function extractSha(dep) {
  return dep?.meta?.githubCommitSha ?? dep?.gitSource?.sha ?? '';
}

/**
 * Drift verdict for two deployment shas:
 *   'match' | 'mismatch' | 'unverifiable' (either side missing).
 */
export function compareDrift(a, b) {
  if (!a || !b) return 'unverifiable';
  return a === b ? 'match' : 'mismatch';
}

/** Vercel marks a dead/revoked credential by returning invalidToken: true. */
export function isInvalidToken(body) {
  return Boolean(body && (body.invalidToken === true || body?.error?.invalidToken === true));
}

export const INVALID_TOKEN_MESSAGE =
  'VERCEL_TOKEN is invalid or revoked — paste a fresh token from https://vercel.com/account/tokens into .env.local';

// ── Token resolution ────────────────────────────────────────────────────────
// env var → .env.local (quotes stripped, like the repo's other loaders) →
// the Vercel CLI auth store. The CLI-store fallback is what keeps local runs
// working before a durable token is added to .env.local.
export const readToken = () => {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*VERCEL_TOKEN\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) return v;
    }
  } catch { /* no .env.local */ }
  try {
    const auth = readFileSync(resolve(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'), 'utf8');
    const parsed = JSON.parse(auth);
    if (parsed.token) return parsed.token;
  } catch { /* no CLI store */ }
  return null;
};

/**
 * Parse CLI flags. Each raw arg is trimmed first: a GitHub Actions
 * plain-scalar `run: cmd \` block folds the trailing backslash-newline into
 * a literal backslash-space, so `--url "…"` arrives in bash as the single
 * word ` --url` (leading space). Trimming recovers the flag so the script
 * can never silently fall back to the list branch because a flag lost its
 * leading position.
 */
export function parseArgs(rawArgs) {
  const args = rawArgs.map((a) => a.trim());
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    expect: flag('--expect'),
    url: flag('--url'),
    compareUrl: flag('--compare-url'),
    apphostingUrl: flag('--apphosting-url'),
  };
}

/**
 * Fetch the commit SHA a Firebase App Hosting build serves, via its
 * `/api/build-info` endpoint (inlined NEXT_PUBLIC_APP_COMMIT_SHA at build
 * time). Returns '' when the route is missing or the build predates the
 * endpoint — the caller treats that as unverifiable, never a mismatch.
 */
export async function resolveAppHostingCommit(apphostingUrl) {
  const url = `${apphostingUrl.replace(/\/$/, '')}/api/build-info`;
  const res = await fetch(url);
  if (!res.ok) return '';
  const body = await res.json().catch(() => null);
  return typeof body?.commitSha === 'string' ? body.commitSha : '';
}

/**
 * Resolve a deployment by URL host via the v13 single-deployment lookup
 * (accepts the canonical alias OR the deployment-specific subdomain). Tries
 * the team-scoped lookup first, then falls back to a bare (unscoped) lookup —
 * the deployment subdomain is globally unique in Vercel, so the bare fallback
 * keeps the gate green even when no team id is known.
 */
export async function resolveByHost(host, what, token, teamId) {
  const attempts = [
    ...(teamId
      ? [`https://api.vercel.com/v13/deployments/${encodeURIComponent(host)}?teamId=${teamId}`]
      : []),
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(host)}`,
  ];

  let lastErr = null;
  for (const url of attempts) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
    if (res.ok) {
      const dep = body ?? {};
      const ts = dep?.createdAt ?? dep?.created;
      return {
        sha: extractSha(dep),
        url: dep?.url ?? '',
        created: ts ? new Date(ts).toISOString() : '',
      };
    }
    if (isInvalidToken(body)) {
      throw new Error(`${INVALID_TOKEN_MESSAGE}__INVALID_TOKEN__`);
    }
    lastErr = new Error(
      `Vercel API returned HTTP ${res.status} for ${what} "${host}". (the deployment record may be purged, the URL may be malformed, or the token lacks access to it)`,
    );
  }
  throw lastErr ?? new Error(`Unable to resolve ${what} "${host}".`);
}

/** A best-effort team id hint: env, then defaultTeamId, then a lone team. */
const resolveTeam = async (token) => {
  if (process.env.VERCEL_TEAM_ID) return process.env.VERCEL_TEAM_ID;
  try {
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
    if (res.ok && body?.user?.defaultTeamId) return body.user.defaultTeamId;
    if (isInvalidToken(body)) throw new Error(`${INVALID_TOKEN_MESSAGE}__INVALID_TOKEN__`);
  } catch (err) {
    if (String(err.message).includes('__INVALID_TOKEN__')) throw err;
  }
  try {
    const teamsRes = await fetch('https://api.vercel.com/v2/teams', {
      headers: { authorization: `Bearer ${token}` },
    });
    const teamsBody = typeof teamsRes.json === 'function' ? await teamsRes.json().catch(() => null) : null;
    if (teamsRes.ok) {
      const teams = teamsBody?.teams ?? [];
      if (teams.length === 1) return teams[0].id;
    }
  } catch { /* ignore — the bare fallback still covers --url */ }
  return null;
};

const invalidTokenExit = (err) => {
  console.error(`✗ FAIL: ${INVALID_TOKEN_MESSAGE}`);
  process.exit(2);
};

async function main() {
  const { expect: EXPECT, url: URL_TARGET, compareUrl: COMPARE_URL, apphostingUrl: APPHOSTING_URL } = parseArgs(process.argv.slice(2));

  // ── Firebase App Hosting commit (independent of Vercel's API) ──────────────
  // When --apphosting-url is passed, the commit the App Hosting build serves
  // is read from its /api/build-info route and asserted against --expect.
  // This runs BEFORE the Vercel token gate so the Firebase half never depends
  // on a Vercel credential.
  if (APPHOSTING_URL) {
    console.log(`\nFirebase App Hosting: ${APPHOSTING_URL}`);
    const sha = await resolveAppHostingCommit(APPHOSTING_URL);
    console.log(`  commit  ${sha || '(unknown — /api/build-info missing or predates the endpoint)'}`);
    if (EXPECT) {
      if (!sha) {
        console.log('  ⚠ no commit exposed by the App Hosting build — cannot verify against --expect (not a mismatch)');
      } else if (sha.startsWith(EXPECT.toLowerCase())) {
        console.log(`  ✓ App Hosting commit matches --expect ${EXPECT}`);
      } else {
        console.error(`  ✗ App Hosting commit ${sha} does not match --expect ${EXPECT}`);
        process.exit(1);
      }
    }
  }

  const token = readToken();
  if (!token) {
    console.error('✗ FAIL: no VERCEL_TOKEN (set VERCEL_TOKEN, add it to .env.local, or run vercel login)');
    process.exit(1);
  }

  let teamId = null;
  try {
    teamId = await resolveTeam(token);
  } catch (err) {
    if (String(err.message).includes('__INVALID_TOKEN__')) invalidTokenExit(err);
    throw err;
  }

  // ── Resolve the target deployment ─────────────────────────────────────────
  let deployedSha = '';
  let deployedUrl = '';
  let created = '';
  let label = '';

  if (URL_TARGET) {
    const host = URL_TARGET.replace(/^https?:\/\//, '').replace(/\/$/, '');
    try {
      const dep = await resolveByHost(host, 'deployment URL', token, teamId);
      deployedSha = dep.sha;
      deployedUrl = dep.url;
      created = dep.created;
    } catch (err) {
      if (String(err.message).includes('__INVALID_TOKEN__')) invalidTokenExit(err);
      console.error(`✗ FAIL: ${err.message}`);
      process.exit(1);
    }
    label = `Deployed URL: ${URL_TARGET}`;
  } else {
    if (!teamId) {
      console.error('✗ FAIL: could not resolve the Vercel team id from the token (needed to list production deployments).');
      process.exit(1);
    }
    // The v6 list endpoint's `project` filter is a PROJECT ID, not a name —
    // passing the name is SILENTLY IGNORED and the API returns the team's
    // latest deployment regardless of project (so this report could show the
    // OTHER app's commit). Resolve the id from the `vercel link` file; the
    // name fallback only applies before the repo is linked (CI never uses
    // this list branch — the post-deploy gates always pass --url).
    let projectId = null;
    try {
      projectId = JSON.parse(readFileSync(resolve(process.cwd(), '.vercel/project.json'), 'utf8'))?.projectId ?? null;
    } catch { /* not linked yet */ }
    const projectFilter = projectId ? `projectId=${encodeURIComponent(projectId)}` : `project=${PROJECT}`;
    const res = await fetch(
      `https://api.vercel.com/v6/deployments?${projectFilter}&teamId=${teamId}&target=production&state=READY&limit=1`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      if (isInvalidToken(body)) invalidTokenExit(null);
      console.error(`✗ FAIL: Vercel API returned HTTP ${res.status}.`);
      process.exit(1);
    }
    const dep = body?.deployments?.[0];
    if (!dep) {
      console.error(`✗ FAIL: no READY production deployment found for ${PROJECT}.`);
      process.exit(1);
    }
    deployedSha = extractSha(dep);
    deployedUrl = dep?.url ?? '';
    created = dep?.created ? new Date(dep.created).toISOString() : '';
    label = `Deployed to production: ${PRODUCTION_URL}`;
  }

  console.log(`\n${label}`);
  console.log(`  commit  ${deployedSha || '(unknown)'}`);
  console.log(`  url     ${deployedUrl}`);
  console.log(`  created ${created}`);
  console.log(`  project ${PROJECT} (team ${teamId ?? 'unscoped'})`);

  let anyFailed = false;

  // ── --compare-url <url>: alias-routing drift watch ────────────────────────
  // Resolves the deployment serving <url> and asserts it serves the same
  // commit as the primary target. Catches alias-routing drift: the
  // deployment-specific URL and the canonical alias pointing at different
  // deployments (e.g. a rollback that updated the alias but not the record).
  if (COMPARE_URL) {
    const host = COMPARE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    let other;
    try {
      other = await resolveByHost(host, 'compare URL', token, teamId);
    } catch (err) {
      if (String(err.message).includes('__INVALID_TOKEN__')) invalidTokenExit(err);
      console.error(`✗ FAIL: ${err.message}`);
      process.exit(1);
    }

    console.log(`\nAlias-routing drift watch: ${COMPARE_URL}`);
    console.log(`  compare commit ${other.sha || '(unknown)'}`);
    console.log(`  compare url    ${other.url}`);
    console.log(`  compare created ${other.created}`);

    const verdict = compareDrift(deployedSha, other.sha);
    if (verdict === 'unverifiable') {
      console.log('\n  ⚠ one or both deployments record no commit sha — cannot compare');
      console.log('  → skipping the drift assertion (not a mismatch)');
    } else if (verdict === 'match') {
      console.log(`\n  ✓ canonical URL and deployment-specific URL serve the same commit (${deployedSha.slice(0, 12)})`);
    } else {
      console.error(`\n  ✗ ALIAS-ROUTING DRIFT: ${COMPARE_URL} serves ${other.sha} but the primary target serves ${deployedSha}`);
      console.error('  The canonical alias and the deployment-specific URL point at different deployments.');
      anyFailed = true;
    }
  }

  // ── --expect <sha>: hard assertion for CI ─────────────────────────────────
  if (EXPECT) {
    if (!deployedSha) {
      console.log('\n  ⚠ no commit sha recorded for this deployment (CLI/prebuilt deploy without git metadata?)');
      console.log('  → cannot verify against --expect — skipping the assertion (not a mismatch)');
    } else if (deployedSha.startsWith(EXPECT.toLowerCase())) {
      console.log(`\n  ✓ deployed commit matches --expect ${EXPECT}`);
    } else {
      console.error(`\n  ✗ deployed commit ${deployedSha} does not match --expect ${EXPECT}`);
      anyFailed = true;
    }
  }

  if (anyFailed) {
    console.error('\nRESULT: FAIL');
    process.exit(1);
  }
  const checksRun = Boolean(COMPARE_URL || EXPECT);
  console.log(checksRun ? '\nRESULT: PASS' : '\nRESULT: PASS (deployed hash reported)');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
