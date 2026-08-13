// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  composeHopReason,
  composeWebSpeechReason,
  probeTokenEndpoint,
  probeWebSocket,
  probeWebSpeechMic,
  runVoiceSelfCheck,
  runWebSpeechSelfCheck,
  webSpeechApiAvailable,
} from './self-check';
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

describe('Web Speech self-check', () => {
  function stubMediaDevices(getUserMedia?: (c: unknown) => Promise<unknown>) {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: getUserMedia ? { getUserMedia } : undefined,
    });
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });

  it('reports granted when the mic opens and releases the stream', async () => {
    const stop = vi.fn();
    stubMediaDevices(vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }));
    expect(await probeWebSpeechMic()).toBe('granted');
    expect(stop).toHaveBeenCalled();
  });

  it('reports denied on NotAllowedError and not-found when no device exists', async () => {
    stubMediaDevices(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    expect(await probeWebSpeechMic()).toBe('denied');
    stubMediaDevices(vi.fn().mockRejectedValue(new DOMException('none', 'NotFoundError')));
    expect(await probeWebSpeechMic()).toBe('not-found');
  });

  it('reports unknown when getUserMedia is missing entirely', async () => {
    stubMediaDevices(undefined);
    expect(await probeWebSpeechMic()).toBe('unknown');
  });

  it('detects the browser SpeechRecognition constructor', () => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    expect(webSpeechApiAvailable()).toBe(false);
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = class {};
    expect(webSpeechApiAvailable()).toBe(true);
  });

  it('logs the structured webspeech line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
    stubMediaDevices(vi.fn().mockResolvedValue({ getTracks: () => [] }));
    const r = await runWebSpeechSelfCheck();
    expect(r).toEqual({ api: false, mic: 'granted' });
    expect(err).toHaveBeenCalledWith('[voice:self-check] webspeech api=false mic=granted');
    err.mockRestore();
  });
});

describe('composeWebSpeechReason', () => {
  it('names the missing-API hop first', () => {
    expect(composeWebSpeechReason('network', { api: false, mic: 'granted' })).toContain('not supported');
  });

  it('mic probes outrank error codes (ground truth for permission/device)', () => {
    expect(composeWebSpeechReason('network', { api: true, mic: 'denied' })).toContain('permission is denied');
    expect(composeWebSpeechReason('not-allowed', { api: true, mic: 'not-found' })).toContain('No microphone was detected');
  });

  it('maps the service error codes to named hops', () => {
    expect(composeWebSpeechReason('service-not-allowed', { api: true, mic: 'granted' })).toContain('speech service is not allowed');
    expect(composeWebSpeechReason('network', { api: true, mic: 'granted' })).toContain('unreachable');
    expect(composeWebSpeechReason('audio-capture', { api: true, mic: 'granted' })).toContain('could not capture audio');
  });

  it('falls back to the raw code when nothing is known', () => {
    expect(composeWebSpeechReason('no-speech', { api: true, mic: 'unknown' })).toBe('Speech recognition failed (no-speech).');
  });
});

describe('runVoiceSelfCheck', () => {
  it('probes both hops and returns a combined result', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const p = runVoiceSelfCheck({ tokenUrl: '/api/voice/token' });
    FakeWebSocket.instances[0].open();
    const r = await p;
    expect(r.token).toEqual({ ok: true, httpStatus: 200, error: null });
    expect(r.websocket.opened).toBe(true);
    // Structured hop lines — a console paste alone names the failing hop.
    expect(err).toHaveBeenCalledWith('[voice:self-check] token ok=true httpStatus=200 error=null');
    expect(err).toHaveBeenCalledWith('[voice:self-check] websocket opened=true closeCode=null error=null');
    err.mockRestore();
  });

  it('logs structured lines that name the failing hop on a broken path', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const p = runVoiceSelfCheck({ tokenUrl: '/api/voice/token' });
    FakeWebSocket.instances[0].fail();
    await p;
    expect(err).toHaveBeenCalledWith('[voice:self-check] token ok=false httpStatus=503 error=null');
    expect(err).toHaveBeenCalledWith('[voice:self-check] websocket opened=false closeCode=null error=connection-failed');
    err.mockRestore();
  });
});
