// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { detectIngredients } = vi.hoisted(() => ({
  detectIngredients: vi.fn(),
}));

vi.mock('@/lib/server/admin', () => ({
  resolveUserId: vi.fn(),
}));

vi.mock('@/lib/server/app-check', () => ({
  gateAppCheck: vi.fn(async () => null),
}));

vi.mock('@/lib/ai/gemini-vision', () => ({
  createGeminiVisionScanner: vi.fn(() => ({ detectIngredients })),
}));

vi.mock('@/lib/server/model-config', () => ({
  resolveGeminiModel: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/logger', () => ({
  logError: vi.fn(),
}));

import { POST } from './route';
import { resolveUserId } from '@/lib/server/admin';
import { gateAppCheck } from '@/lib/server/app-check';
import { resolveGeminiModel } from '@/lib/server/model-config';

function scanRequest(): Request {
  return new Request('http://localhost/api/vision/scan', {
    method: 'POST',
    headers: {
      authorization: 'Bearer fake-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
  });
}

describe('POST /api/vision/scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gateAppCheck).mockResolvedValue(null);
    vi.mocked(resolveUserId).mockResolvedValue('user-1');
    detectIngredients.mockResolvedValue([{ name: 'tomato', confidence: 0.9 }]);
  });

  it('returns an App Check block before auth, model resolution, or vision work', async () => {
    vi.mocked(gateAppCheck).mockResolvedValueOnce(new NextResponse(null, { status: 403 }));
    const res = await POST(scanRequest());

    expect(res.status).toBe(403);
    expect(resolveUserId).not.toHaveBeenCalled();
    expect(resolveGeminiModel).not.toHaveBeenCalled();
    expect(detectIngredients).not.toHaveBeenCalled();
  });

  it('invokes vision only after the App Check gate passes', async () => {
    const res = await POST(scanRequest());

    expect(res.status).toBe(200);
    expect(gateAppCheck).toHaveBeenCalledTimes(1);
    expect(detectIngredients).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateAppCheck).mock.invocationCallOrder[0])
      .toBeLessThan(detectIngredients.mock.invocationCallOrder[0]);
  });
});
