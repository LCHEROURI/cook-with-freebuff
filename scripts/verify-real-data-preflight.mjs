const DEFAULT_APP = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function parseProductionPreflightOptions(args, env) {
  const expectedSha = flag(args, '--expected-sha', env.VERIFY_EXPECTED_SHA);
  if (!expectedSha) {
    throw new Error('Refusing real-data access without --expected-sha or VERIFY_EXPECTED_SHA.');
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) {
    throw new Error('The expected production SHA must be a full 40-character Git commit SHA.');
  }

  return {
    app: flag(args, '--app', env.VERIFY_BASE_URL ?? DEFAULT_APP).replace(/\/$/, ''),
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
