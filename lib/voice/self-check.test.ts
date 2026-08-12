// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { composeHopReason, probeTokenEndpoint, probeWebSocket, runVoiceSelfCheck } from './self-check';
import { LIVE_WS_URL } from './gemini-live';

// ============================================================================
// lib/voice/self-check.test.ts — the two independent probes (token endpoint +
// Live WebSocket) and the composer that names the exact failing hop in the
// fallback banner.
// ============================================================================

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  readyState = 0;
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.({ code: 1000, reason: 'clean' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeTokenEndpoint', () => {
  it('reports ok with the HTTP status on a healthy response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const r = await probeTokenEndpoint('/api/voice/token', () => 'bearer');
    expect(r).toEqual({ ok: true, httpStatus: 200, error: null });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/voice/token', expect.objectContaining({ method: 'POST' }));
  });

  it('names a rejected request via its HTTP status (e.g. missing key)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const r = await probeTokenEndpoint('/api/voice/token', undefined);
    expect(r).toEqual({ ok: false, httpStatus: 503, error: null });
  });

  it('reports a network failure when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const r = await probeTokenEndpoint('/api/voice/token', undefined);
    expect(r).toEqual({ ok: false, httpStatus: null, error: 'network' });
  });

  it('reports a timeout when the endpoint never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const p = probeTokenEndpoint('/api/voice/token', undefined, 3000);
    await vi.advanceTimersByTimeAsync(3100);
    expect(await p).toEqual({ ok: false, httpStatus: null, error: 'timeout' });
    vi.useRealTimers();
  });
});

describe('probeWebSocket', () => {
  it('reports opened when the transport hop is reachable', async () => {
    const p = probeWebSocket(LIVE_WS_URL, 3000);
    FakeWebSocket.instances[0].open();
    expect(await p).toEqual({ opened: true, closeCode: null, error: null });
    expect(FakeWebSocket.instances[0].url).toContain('access_token=probe');
  });

  it('reports a blocked transport when the socket errors before opening', async () => {
    const p = probeWebSocket(LIVE_WS_URL, 3000);
    FakeWebSocket.instances[0].fail();
    expect(await p).toEqual({ opened: false, closeCode: null, error: 'connection-failed' });
  });

  it('times out when the socket neither opens nor errors', async () => {
    vi.useFakeTimers();
    const p = probeWebSocket(LIVE_WS_URL, 3000);
    await vi.advanceTimersByTimeAsync(3100);
    expect(await p).toEqual({ opened: false, closeCode: null, error: 'timeout' });
    vi.useRealTimers();
  });
});

describe('composeHopReason', () => {
  const base = 'Gemini Live could not open the voice connection. Using the built-in speech fallback instead.';
  const okToken = { ok: true, httpStatus: 200, error: null } as const;
  const openedWs = { opened: true, closeCode: null, error: null } as const;

  it('names the token hop when the request is rejected (bad key)', () => {
    const r = composeHopReason(base, { token: { ok: false, httpStatus: 503, error: null }, websocket: openedWs });
    expect(r).toContain('HTTP 503');
    expect(r).toContain('built-in speech fallback');
  });

  it('names the token hop when it is unreachable (network)', () => {
    const r = composeHopReason(base, { token: { ok: false, httpStatus: null, error: 'network' }, websocket: openedWs });
    expect(r).toContain('token endpoint is unreachable');
  });

  it('names the WebSocket hop when the socket is blocked', () => {
    const r = composeHopReason(base, { token: okToken, websocket: { opened: false, closeCode: null, error: 'connection-failed' } });
    expect(r).toContain('voice WebSocket was blocked');
  });

  it('reports a reachable-but-silent service for a setup timeout', () => {
    const r = composeHopReason('Gemini Live did not respond — the voice service may be blocked. Using the built-in speech fallback instead.', {
      token: okToken,
      websocket: openedWs,
    });
    expect(r).toContain('reachable but did not respond');
  });

  it('falls back to the session message when the probes are inconclusive', () => {
    const r = composeHopReason(base, { token: okToken, websocket: openedWs });
    expect(r).toBe(base);
  });
});

describe('runVoiceSelfCheck', () => {
  it('probes both hops and returns a combined result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const p = runVoiceSelfCheck({ tokenUrl: '/api/voice/token' });
    FakeWebSocket.instances[0].open();
    const r = await p;
    expect(r.token).toEqual({ ok: true, httpStatus: 200, error: null });
    expect(r.websocket.opened).toBe(true);
  });
});
