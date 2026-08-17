// ============================================================================
// lib/server/model-config.test.ts — lock the Remote Config model resolution.
//
// resolveGeminiModel must supply ONLY the Remote Config layer: a configured
// parameter returns its value, everything else returns undefined so the
// caller's env → default chain applies unchanged. A missing admin app, the
// emulator, or a failed fetch must all degrade to undefined, never throw.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MODEL_ROLE_CONFIG } from '../ai/model-roles';

const getTemplate = vi.fn();

vi.mock('server-only', () => ({}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  cert: vi.fn((creds: unknown) => creds),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => null),
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(() => null),
}));

vi.mock('firebase-admin/remote-config', () => ({
  getRemoteConfig: vi.fn(() => ({ getTemplate })),
}));

const FAKE_CREDS = JSON.stringify({
  project_id: 'test-proj',
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
});

function template(parameters: Record<string, { defaultValue?: { value?: string } }> = {}) {
  return { parameters, conditions: [], parameterGroups: {}, etag: 'etag' };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_CREDS;
  delete process.env.FIRESTORE_EMULATOR_HOST;
});

describe('resolveGeminiModel', () => {
  it('returns undefined when there is no admin app (falls through to env/default)', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('generation')).resolves.toBeUndefined();
    expect(getTemplate).not.toHaveBeenCalled();
  });

  it('returns undefined under the emulator (no real Remote Config)', async () => {
    process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('generation')).resolves.toBeUndefined();
    expect(getTemplate).not.toHaveBeenCalled();
  });

  it('returns the published default value for a role', async () => {
    getTemplate.mockResolvedValue(template({
      recipe_generation_model: { defaultValue: { value: 'gemini-3.7-flash' } },
      live_voice_model: { defaultValue: { value: 'gemini-3.1-flash-live-preview' } },
    }));
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('generation')).resolves.toBe('gemini-3.7-flash');
    await expect(resolveGeminiModel('live-voice')).resolves.toBe('gemini-3.1-flash-live-preview');
  });

  it('returns undefined for a role with no Remote Config parameter', async () => {
    getTemplate.mockResolvedValue(template({ recipe_generation_model: { defaultValue: { value: 'x' } } }));
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('vision')).resolves.toBeUndefined();
  });

  it('caches the template — one fetch across repeated calls', async () => {
    getTemplate.mockResolvedValue(template({
      recipe_generation_model: { defaultValue: { value: 'gemini-3.7-flash' } },
    }));
    const { resolveGeminiModel } = await import('./model-config');

    await resolveGeminiModel('generation');
    await resolveGeminiModel('generation');
    expect(getTemplate).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the first fetch fails (never throws)', async () => {
    getTemplate.mockRejectedValue(new Error('permission-denied'));
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('generation')).resolves.toBeUndefined();
  });

  it('backs off after a failed refresh — serves stale and defers the next fetch', async () => {
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      getTemplate.mockResolvedValue(template({ recipe_generation_model: { defaultValue: { value: 'gemini-3.7-flash' } } }));
      const { resolveGeminiModel } = await import('./model-config');

      await resolveGeminiModel('generation'); // success, caches the template
      expect(getTemplate).toHaveBeenCalledTimes(1);

      // The cache expires and the refresh fails.
      now += 6 * 60 * 1000;
      getTemplate.mockRejectedValue(new Error('unavailable'));
      await expect(resolveGeminiModel('generation')).resolves.toBe('gemini-3.7-flash'); // last-good value
      expect(getTemplate).toHaveBeenCalledTimes(2);

      // Within the TTL after the failure: the backoff holds, no re-fetch.
      now += 1 * 60 * 1000;
      await expect(resolveGeminiModel('generation')).resolves.toBe('gemini-3.7-flash');
      expect(getTemplate).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('logModelResolutionSources', () => {
  // The startup self-check emits one structured `model_source` line per role
  // (via lib/server/logger.ts → console.log as JSON). These tests read those
  // lines back and assert the source each role resolved from.
  const MODEL_ENV_VARS = Object.values(MODEL_ROLE_CONFIG).map((c) => c.envVar);

  async function captureSources(setup: () => void): Promise<Record<string, { model: string; source: string }>> {
    for (const name of MODEL_ENV_VARS) delete process.env[name];
    setup();
    const { logModelResolutionSources } = await import('./model-config');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      if (typeof line === 'string') lines.push(line);
    });
    try {
      await logModelResolutionSources();
    } finally {
      spy.mockRestore();
    }
    const byRole: Record<string, { model: string; source: string }> = {};
    for (const line of lines) {
      const e = JSON.parse(line) as { event?: string; role?: string; model?: string; source?: string };
      if (e.event === 'model_source' && e.role && e.model && e.source) {
        byRole[e.role] = { model: e.model, source: e.source };
      }
    }
    return byRole;
  }

  it('logs every role as `default` when neither Remote Config nor env vars are set', async () => {
    getTemplate.mockResolvedValue(template({})); // no published parameters
    const byRole = await captureSources(() => {});

    expect(Object.keys(byRole)).toHaveLength(5);
    for (const { role, defaultModel } of Object.values(MODEL_ROLE_CONFIG)) {
      expect(byRole[role]).toEqual({ model: defaultModel, source: 'default' });
    }
  });

  it('resolves precedence: Remote Config > env > default', async () => {
    getTemplate.mockResolvedValue(template({
      live_voice_model: { defaultValue: { value: 'gemini-rc-live' } },
    }));
    const byRole = await captureSources(() => {
      process.env.RECIPE_GENERATION_MODEL = 'gemini-env-gen';
    });

    // Remote Config wins where published.
    expect(byRole['live-voice']).toEqual({ model: 'gemini-rc-live', source: 'remote-config' });
    // The env var wins where Remote Config is unset.
    expect(byRole.generation).toEqual({ model: 'gemini-env-gen', source: 'env' });
    // Everything else falls back to the hardcoded default.
    expect(byRole.validation).toEqual({ model: MODEL_ROLE_CONFIG.validation.defaultModel, source: 'default' });
    expect(byRole.conversation).toEqual({ model: MODEL_ROLE_CONFIG.conversation.defaultModel, source: 'default' });
    expect(byRole.vision).toEqual({ model: MODEL_ROLE_CONFIG.vision.defaultModel, source: 'default' });
  });
});
