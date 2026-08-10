import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { SessionService, InMemorySessionStore } from '@/lib/server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '@/lib/server/tools';
import type { ToolContext } from '@/lib/server/tools/types';

vi.mock('@/lib/server/admin', () => ({ resolveUserId: vi.fn() }));
vi.mock('@/lib/server/stores', () => ({ buildProductionContext: vi.fn() }));

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

describe('POST /api/agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('user-1');
    mockBuild.mockImplementation((userId: string) => testContext(userId));
  });

  it('returns 401 without a valid token', async () => {
    mockResolve.mockResolvedValue(null);
    const res = await POST(new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'hello' }),
    }));
    expect(res.status).toBe(401);
  });

  it('processes a brain-dump end to end', async () => {
    const res = await POST(new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ utterance: 'I have two tomatoes and rice' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toContain('Is that right?');
    expect(body.toolCalls.some((c: { tool: string }) => c.tool === 'update_available_ingredients')).toBe(true);
  });

  it('rejects a missing utterance', async () => {
    const res = await POST(new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('reports a failing command honestly (no false success)', async () => {
    const res = await POST(new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-token',
      },
      body: JSON.stringify({ utterance: 'done' }),
    }));
    const body = await res.json();
    expect(body.response).toContain('did not work');
  });
});