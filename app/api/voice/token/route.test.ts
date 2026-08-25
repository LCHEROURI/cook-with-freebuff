// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from './route';

vi.mock('@/lib/server/admin', () => ({
  resolveUserId: vi.fn(),
}));

vi.mock('@/lib/server/app-check', () => ({
  gateAppCheck: vi.fn(async () => null),
}));

vi.mock('@/lib/server/model-config', () => ({
  resolveGeminiModel: vi.fn(async () => undefined),
}));

import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { resolveGeminiModel } from '@/lib/server/model-config';

const API_KEY = 'AIzaSy-fake-test-key-00000000000000000';

function mockResolve(userId: string | null) {
  vi.mocked(resolveUserId).mockResolvedValue(userId);
}

function mintResponse(overrides: Record<string, unknown> = {}) {
  return {
    name: 'auth_tokens/1234abcd',
    expireTime: '2026-08-11T20:00:00.000Z',
    ...overrides,
  };
}

function mockMint(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

const originalKey = process.env.GOOGLE_AI_API_KEY;
const originalLiveModel = process.env.LIVE_MODEL;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gateAppCheck).mockResolvedValue(null);
  process.env.GOOGLE_AI_API_KEY = API_KEY;
  process.env.LIVE_MODEL = 'gemini-3.1-flash-live-preview';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.GOOGLE_AI_API_KEY;
  else process.env.GOOGLE_AI_API_KEY = originalKey;
  if (originalLiveModel === undefined) delete process.env.LIVE_MODEL;
  else process.env.LIVE_MODEL = originalLiveModel;
  vi.unstubAllGlobals();
});

function authReq(): Request {
  return new Request('http://localhost/api/voice/token', {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
  });
}

describe('POST /api/voice/token', () => {
  it('returns an App Check block before auth, model resolution, or token minting', async () => {
    vi.mocked(gateAppCheck).mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
    vi.stubGlobal('fetch', vi.fn());
    const res = await POST(authReq());

    expect(res.status).toBe(403);
    expect(resolveUserId).not.toHaveBeenCalled();
    expect(resolveGeminiModel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests (401)', async () => {
    mockResolve(null);
    const res = await POST(authReq());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 503 when GOOGLE_AI_API_KEY is not configured', async () => {
    mockResolve('uid-1');
    delete process.env.GOOGLE_AI_API_KEY;
    const res = await POST(authReq());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; recoverable: boolean } };
    expect(body.error.code).toBe('VOICE_UNAVAILABLE');
    expect(body.error.recoverable).toBe(true);
  });

  it('mints a single-use token and NEVER exposes the API key', async () => {
    mockResolve('uid-1');
    mockMint(200, mintResponse());

    const res = await POST(authReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { token: string; model: string; expiresAt: string | null } };
    expect(body.success).toBe(true);
    expect(body.data.token).toBe('auth_tokens/1234abcd');
    expect(body.data.model).toBe('gemini-3.1-flash-live-preview');
    expect(body.data.expiresAt).toBe('2026-08-11T20:00:00.000Z');

    const raw = await POST(authReq()).then((r) => r.text());
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain('AIzaSy-fake-test-key');

    // Upstream contract: v1alpha/auth_tokens, api-key header, uses: 1,
    // 30-minute expireTime / 2-minute newSessionExpireTime window.
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(API_KEY);
    const sent = JSON.parse(String(init.body)) as {
      uses: number;
      expireTime: string;
      newSessionExpireTime: string;
    };
    expect(sent.uses).toBe(1);
    const expireMs = new Date(sent.expireTime).getTime();
    const startMs = new Date(sent.newSessionExpireTime).getTime();
    expect(expireMs - startMs).toBeGreaterThan(20 * 60 * 1000);
  });

  it('returns a recoverable 502 when the upstream mint fails', async () => {
    mockResolve('uid-1');
    mockMint(400, { error: { message: 'bad key' } });
    const res = await POST(authReq());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; recoverable: boolean } };
    expect(body.error.code).toBe('UPSTREAM');
    expect(body.error.recoverable).toBe(true);
  });

  it('returns a recoverable 502 when the mint body has no usable token', async () => {
    mockResolve('uid-1');
    mockMint(200, { name: 42 });
    const res = await POST(authReq());
    expect(res.status).toBe(502);
  });

  it('returns a recoverable 502 when the upstream request throws', async () => {
    mockResolve('uid-1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await POST(authReq());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { recoverable: boolean } };
    expect(body.error.recoverable).toBe(true);
  });
});
