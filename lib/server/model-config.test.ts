// ============================================================================
// lib/server/model-config.test.ts — lock the Remote Config model resolution.
//
// resolveGeminiModel must supply ONLY the Remote Config layer: a configured
// parameter returns its value, everything else returns undefined so the
// caller's env → default chain applies unchanged. A missing admin app, the
// emulator, or a failed fetch must all degrade to undefined, never throw.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      recipe_generation_model: { defaultValue: { value: 'gemini-2.5-flash' } },
      live_voice_model: { defaultValue: { value: 'gemini-3.1-flash-live-preview' } },
    }));
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('generation')).resolves.toBe('gemini-2.5-flash');
    await expect(resolveGeminiModel('live-voice')).resolves.toBe('gemini-3.1-flash-live-preview');
  });

  it('returns undefined for a role with no Remote Config parameter', async () => {
    getTemplate.mockResolvedValue(template({ recipe_generation_model: { defaultValue: { value: 'x' } } }));
    const { resolveGeminiModel } = await import('./model-config');

    await expect(resolveGeminiModel('vision')).resolves.toBeUndefined();
  });

  it('caches the template — one fetch across repeated calls', async () => {
    getTemplate.mockResolvedValue(template({
      recipe_generation_model: { defaultValue: { value: 'gemini-2.5-flash' } },
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
});
