// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGeminiLive, type LiveStatus } from './useGeminiLive';

// ============================================================================
// lib/hooks/useGeminiLive.test.ts — the Live voice session lifecycle, with the
// GeminiLiveClient module swapped for a fake: toggle → connect → transcripts →
// tool execution via /api/tools → reply streaming → turn finalize → teardown.
// ============================================================================

type Handler = (payload: never) => void;

const { FakeLiveClient, ctorSpy } = vi.hoisted(() => {
  class FakeLiveClient {
    handlers = new Map<string, Set<Handler>>();
    sentTexts: string[] = [];
    toolResponses: unknown[] = [];
    startListeningCalls = 0;
    disconnectCalls = 0;
    lastOpts: Record<string, unknown> = {};

    constructor(opts: Record<string, unknown>) {
      this.lastOpts = opts;
    }
    on(event: string, fn: Handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(fn);
      return () => this.handlers.get(event)?.delete(fn);
    }
    emit(event: string, payload: unknown) {
      this.handlers.get(event)?.forEach((fn) => fn(payload as never));
    }
    connect() {
      return Promise.resolve();
    }
    startListening() {
      this.startListeningCalls += 1;
      return Promise.resolve();
    }
    sendText(text: string) {
      this.sentTexts.push(text);
    }
    sendToolResponse(responses: unknown[]) {
      this.toolResponses = responses;
    }
    disconnect() {
      this.disconnectCalls += 1;
    }
  }
  const ctorSpy = vi.fn((opts: Record<string, unknown>) => {
    lastClient = new FakeLiveClient(opts);
    return lastClient;
  });
  return { FakeLiveClient, ctorSpy };
});

type FakeClientInstance = InstanceType<typeof FakeLiveClient>;
let lastClient: FakeClientInstance | null = null;

vi.mock('@/lib/voice/gemini-live', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/gemini-live')>();
  return {
    ...actual,
    GeminiLiveClient: ctorSpy,
    DEFAULT_TOKEN_URL: '/api/voice/token',
  };
});

function installAudioContext() {
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: class {},
  });
}

function removeAudioContext() {
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  delete w.AudioContext;
  delete w.webkitAudioContext;
}

function mintOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { token: 'tok' } }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  lastClient = null;
  installAudioContext();
  mintOk();
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeAudioContext();
});

describe('useGeminiLive', () => {
  it('is unavailable without Web Audio', () => {
    removeAudioContext();
    const { result } = renderHook(() => useGeminiLive());
    expect(result.current.available).toBe(false);
  });

  it('toggle connects the client with the shared tool surface and system instruction', async () => {
    const { result } = renderHook(() =>
      useGeminiLive({ getToken: () => 'bearer', systemContext: { currentPhase: 'COOKING_GUIDANCE', currentStep: 'cooking step 2' } }),
    );
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.mode).toBe('connecting');
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const opts = ctorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.tokenUrl).toBe('/api/voice/token');
    expect(opts.getToken).toBeDefined();
    expect(String(opts.systemInstruction)).toContain('Kitchen Agent');
    expect(String(opts.systemInstruction)).toContain('COOKING_GUIDANCE');
    expect((opts.tools as unknown[]).length).toBeGreaterThan(20);
  });

  it('goes live on CONNECTED and starts mic capture', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.mode).toBe('connecting');
    await act(async () => {
      lastClient!.emit('status', 'CONNECTED');
    });
    expect(result.current.mode).toBe('live');
    expect(result.current.status).toBe('LISTENING');
    expect(lastClient!.startListeningCalls).toBe(1);
  });

  it('builds a THINKING turn from a final transcript, streams the reply, and finalizes on turn end', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    await act(async () => {
      lastClient!.emit('transcript', { type: 'final', text: '  what is in my pantry  ' });
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]).toMatchObject({ utterance: 'what is in my pantry', status: 'THINKING' });

    await act(async () => {
      lastClient!.emit('agentSpeech', 'You have olive oil');
      lastClient!.emit('agentSpeech', 'and chicken.');
    });
    expect(result.current.status).toBe('SPEAKING');
    expect(result.current.turns[0].response).toBe('You have olive oil and chicken.');

    await act(async () => {
      lastClient!.emit('turn', { kind: 'end' });
    });
    expect(result.current.turns[0].status).toBe('SPEAKING');
    expect(result.current.turns[0].response).toContain('chicken');
    expect(result.current.status).toBe('LISTENING');
  });

  it('executes tool calls through /api/tools and returns the results over the socket', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { items: ['olive oil'] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useGeminiLive({ getToken: () => 'bearer' }));
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
      lastClient!.emit('transcript', { type: 'final', text: 'pantry please' });
      lastClient!.emit('toolcall', {
        functionCalls: [{ id: 'fc_1', name: 'get_pantry', args: { name: 'oil' } }],
      });
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/tools');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer');
    const body = JSON.parse(String(init.body)) as { tool: string; arguments: { name: string } };
    expect(body.tool).toBe('get_pantry');
    expect(body.arguments.name).toBe('oil');

    expect(lastClient!.toolResponses).toEqual([
      { id: 'fc_1', name: 'get_pantry', response: { success: true, data: { items: ['olive oil'] } } },
    ]);
    expect(result.current.turns[0].toolCalls).toHaveLength(1);
    expect(result.current.turns[0].toolCalls[0].result.success).toBe(true);
  });

  it('tracks repeated utterances as separate turns (index-based, not text-based)', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    await act(async () => {
      lastClient!.emit('transcript', { type: 'final', text: 'done' });
      lastClient!.emit('turn', { kind: 'end' });
      lastClient!.emit('transcript', { type: 'final', text: 'done' });
      lastClient!.emit('agentSpeech', 'Second one');
      lastClient!.emit('turn', { kind: 'end' });
    });
    expect(result.current.turns).toHaveLength(2);
    expect(result.current.turns[0].response).not.toContain('Second one');
    expect(result.current.turns[1].response).toBe('Second one');
  });

  it('keeps the typed path working: sendText builds a turn and forwards to the socket while live', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    await act(async () => {
      result.current.sendText('done');
    });
    expect(lastClient!.sentTexts).toEqual(['done']);
    expect(result.current.turns[0].utterance).toBe('done');
  });

  it('a second toggle disconnects and returns to off', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    expect(result.current.mode).toBe('live');
    await act(async () => {
      await result.current.toggle();
    });
    expect(lastClient!.disconnectCalls).toBe(1);
    expect(result.current.mode).toBe('off');
    expect(result.current.status).toBe('IDLE');
  });

  it('maps an ERROR status to a recoverable error state', async () => {
    const { result } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'ERROR');
    });
    expect(result.current.mode).toBe('off');
    expect(result.current.status).toBe('ERROR');
    expect(result.current.error).toContain('typed chat');
  });

  it('unmount disconnects the live session — no dangling socket', async () => {
    const { result, unmount } = renderHook(() => useGeminiLive());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    unmount();
    expect(lastClient!.disconnectCalls).toBe(1);
  });

  it('exposes a status that the page maps onto the voice indicator', async () => {
    const { result } = renderHook(() => useGeminiLive());
    expect(result.current.status).toBe('IDLE' satisfies LiveStatus);
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.status).toBe('LISTENING');
  });

  it('watchdog: awaiting turns on after silence while listening and clears on activity', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useGeminiLive({ silentThresholdMs: 5000 }));
      await act(async () => {
        await result.current.toggle();
        lastClient!.emit('status', 'CONNECTED');
      });
      expect(result.current.awaiting).toBe(false);

      // 4s of silence: still under the 5s threshold.
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(result.current.awaiting).toBe(false);

      // Cross the threshold: the honest state appears instead of a frozen mic.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current.awaiting).toBe(true);

      // The user speaks: activity clears it. (Transcript → THINKING, so the
      // mic is not "silent-listening" during the model's turn.)
      await act(async () => {
        lastClient!.emit('transcript', { type: 'final', text: 'set a timer' });
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.awaiting).toBe(false);

      // The turn completes and the mic is back to listening… then silence
      // brings the awaiting state back.
      await act(async () => {
        lastClient!.emit('turn', { kind: 'end' });
      });
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(result.current.status).toBe('LISTENING');
      expect(result.current.awaiting).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchdog: awaiting never fires while the model is replying (SPEAKING)', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useGeminiLive({ silentThresholdMs: 5000 }));
      await act(async () => {
        await result.current.toggle();
        lastClient!.emit('status', 'CONNECTED');
        lastClient!.emit('transcript', { type: 'final', text: 'repeat the step' });
        lastClient!.emit('agentSpeech', 'The next step is…');
      });
      expect(result.current.status).toBe('SPEAKING');
      // A long pause while SPEAKING (model audio still streaming) must NOT
      // surface the awaiting state — the session is not frozen, the mic is
      // muted by design until the reply drains.
      await act(async () => {
        vi.advanceTimersByTime(20000);
      });
      expect(result.current.awaiting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
