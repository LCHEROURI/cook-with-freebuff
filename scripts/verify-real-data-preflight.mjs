const EXPECTED_PROJECT_ID = 'portfolio-app-freebuff2';
const DEFAULT_APP = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/**
 * Validates that the preflight host is bound to the expected Firebase project.
 * Accepts only official Firebase Hosting / App Hosting hostname forms:
 *
 *   PROJECT_ID.web.app
 *   PROJECT_ID.firebaseapp.com
 *   SITE_ID--PROJECT_ID.REGION.hosted.app
 *
 * Substring-only matches are rejected — an attacker-controlled host such as
 * \`evil--PROJECT_ID.attacker.example\` must not pass the check.
 */
function assertHostBoundToProject(appUrl) {
  const hostname = new URL(appUrl).hostname;

  // Default Firebase Hosting domains — exact match at the project level.
  if (
    hostname === `${EXPECTED_PROJECT_ID}.web.app` ||
    hostname === `${EXPECTED_PROJECT_ID}.firebaseapp.com`
  ) {
    return;
  }

  // Firebase App Hosting preview / production channels.
  // The --projectId label may be followed by a region dot (production)
  // or a channel suffix (--projectId-preview.region.hosted.app). The
  // hostname must end with the Google-controlled .hosted.app TLD.
  if (
    hostname.endsWith('.hosted.app') &&
    /--portfolio-app-freebuff2(?:[.-])/.test(hostname)
  ) {
    return;
  }

  throw new Error(
    `Refusing preflight against an untrusted host; the deployment URL must reference project ${EXPECTED_PROJECT_ID}.`,
  );
}

export function parseProductionPreflightOptions(args, env) {
  const expectedSha = flag(args, '--expected-sha', env.VERIFY_EXPECTED_SHA);
  if (!expectedSha) {
    throw new Error('Refusing real-data access without --expected-sha or VERIFY_EXPECTED_SHA.');
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error('The expected production SHA must be a full 40-character Git commit SHA.');
  }

  const app = flag(args, '--app', env.VERIFY_BASE_URL ?? DEFAULT_APP).replace(/\/$/, '');
  assertHostBoundToProject(app);

  return {
    app,
    expectedSha: expectedSha.toLowerCase(),
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function verifyProductionPreflight({ app, expectedSha, fetchImpl = fetch }) {
  const buildResponse = await fetchImpl(`${app.replace(/\/$/, '')}/api/build-info`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const build = await readJson(buildResponse);
  if (
    buildResponse.status !== 200
    || build?.emulator !== false
    || build?.commitSha?.toLowerCase() !== expectedSha.toLowerCase()
  ) {
    throw new Error(`Refusing stale production revision; expected ${expectedSha}.`);
  }

  const appCheckResponse = await fetchImpl(`${app.replace(/\/$/, '')}/api/cook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list_recipes' }),
  });
  const appCheckBody = await readJson(appCheckResponse);
  if (
    appCheckResponse.status !== 403
    || appCheckBody?.error?.code !== 'APP_CHECK_FAILED'
  ) {
    throw new Error('App Check production preflight failed; expected HTTP 403 APP_CHECK_FAILED.');
  }

  return { deployedSha: build.commitSha };
}
