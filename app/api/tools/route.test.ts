import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { SessionService, InMemorySessionStore } from '@/lib/server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '@/lib/server/tools';
import type { ToolContext } from '@/lib/server/tools/types';

vi.mock('@/lib/server/admin', () => ({
  resolveUserId: vi.fn(),
}));

vi.mock('@/lib/server/stores', () => ({
  buildProductionContext: vi.fn(),
}));

vi.mock('@/lib/server/app-check', () => ({
  gateAppCheck: vi.fn(async () => null),
}));

import { resolveUserId } from '@/lib/server/admin';
import { buildProductionContext } from '@/lib/server/stores';

const mockResolve = resolveUserId as ReturnType<typeof vi.fn>;
const mockBuild = buildProductionContext as ReturnType<typeof vi.fn>;

function testContext(userId: string): ToolContext {
  const store = new InMemorySessionStore();
  return {
    userId,
    sessionService: new SessionService(store),
    timerStore: new InMemoryTimerStore(),
    logStore: new InMemoryLogStore(),
    recipeStore: new InMemoryRecipeStore(),
  };
}

describe('POST /api/tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('user-1');
    mockBuild.mockImplementation((userId: string) =>
      testContext(userId),
    );
  });

  it('returns 401 without a valid token', async () => {
    mockResolve.mockResolvedValue(null);
    const res = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'start_cooking_session', arguments: {} }),
    }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('executes a tool with a valid token', async () => {
    const res = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ tool: 'start_cooking_session', arguments: {} }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.phase).toBe('COLLECTING_INGREDIENTS');
  });

  it('rejects a missing tool name', async () => {
    const res = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ arguments: {} }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('returns 400 for a failing tool call (structured error, not a throw)', async () => {
    const res = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ tool: 'complete_current_step', arguments: {} }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects a malformed correlationId with 400 INVALID_BODY before executing the tool', async () => {
    const res = await POST(new Request('http://localhost/api/tools', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ tool: 'start_cooking_session', arguments: {}, correlationId: 'bad/id' }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
    expect(body.error.message).toContain('correlationId');
    // The context is built inside runWithContext AFTER the check — a rejected
    // id never reaches the tool layer, so no marker could be written.
    expect(mockBuild).not.toHaveBeenCalled();
  });
});