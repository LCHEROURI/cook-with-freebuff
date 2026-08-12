// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveDictation, DICTATION_SYSTEM_INSTRUCTION } from './useLiveDictation';
import { runVoiceSelfCheck, type VoiceSelfCheckResult } from '@/lib/voice/self-check';

// ============================================================================
// lib/hooks/useLiveDictation.test.ts — the recipe-starter dictation mic: a
// Gemini Live session that ONLY transcribes (no tools, TEXT modality), hands
// the final input transcription to onFinal, and stops itself — with quiet-
// timeout, barge-in and teardown guarantees. The GeminiLiveClient module is
// swapped for a fake so the lifecycle is deterministic.
// ============================================================================

type Handler = (payload: never) => void;

const { FakeDictationClient, ctorSpy } = vi.hoisted(() => {
  class FakeDictationClient {
    handlers = new Map<string, Set<Handler>>();
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
    disconnect() {
      this.disconnectCalls += 1;
    }
  }
  const ctorSpy = vi.fn((opts: Record<string, unknown>) => {
    lastClient = new FakeDictationClient(opts);
    return lastClient;
  });
  return { FakeDictationClient, ctorSpy };
});

type FakeClientInstance = InstanceType<typeof FakeDictationClient>;
let lastClient: FakeClientInstance | null = null;

vi.mock('@/lib/voice/gemini-live', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/gemini-live')>();
  return {
    ...actual,
    GeminiLiveClient: ctorSpy,
    DEFAULT_TOKEN_URL: '/api/voice/token',
  };
});

// The self-check probes run on every failure; by default they resolve healthy
// so existing tests keep their own error text. The hop-naming test overrides
// the result with a rejected token.
vi.mock('@/lib/voice/self-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/self-check')>();
  return {
    ...actual,
    runVoiceSelfCheck: vi.fn().mockResolvedValue({
      token: { ok: true, httpStatus: 200, error: null },
      websocket: { opened: true, closeCode: null, error: null },
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
  lastClient = null;
  installAudioContext();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  removeAudioContext();
});

describe('useLiveDictation', () => {
  it('is unavailable without Web Audio', () => {
    removeAudioContext();
    const { result } = renderHook(() => useLiveDictation());
    expect(result.current.available).toBe(false);
  });

  it('toggle creates a TOOL-FREE dictation session (no tools, AUDIO modality, dictation instruction)', async () => {
    const { result } = renderHook(() => useLiveDictation({ getToken: () => 'bearer' }));
    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.listening).toBe(true);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const opts = ctorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.tokenUrl).toBe('/api/voice/token');
    expect(opts.getToken).toBeDefined();
    expect(opts.systemInstruction).toBe(DICTATION_SYSTEM_INSTRUCTION);
    // The cardinal rule: the dictation session exposes NO tools, so the model
    // can never act on a spoken prompt before the user reviews it.
    expect(Array.isArray(opts.tools) ? opts.tools.length : (opts.tools as readonly unknown[])?.length ?? 0).toBe(0);
    // AUDIO, not TEXT — the constrained Live endpoint rejects TEXT modality
    // (CLOSED(1007)); the audio reply is unused because the session closes on
    // the final transcript.
    expect(opts.responseModalities).toEqual(['AUDIO']);
  });

  it('goes live on CONNECTED and starts mic capture', async () => {
    const { result } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      lastClient!.emit('status', 'CONNECTED');
    });
    expect(result.current.listening).toBe(true);
    expect(lastClient!.startListeningCalls).toBe(1);
  });

  it('exposes the reply-playback mic pause and clears it on error or final transcript', async () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal }));
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      lastClient!.emit('status', 'CONNECTED');
    });
    expect(result.current.micReplying).toBe(false);
    await act(async () => {
      lastClient!.emit('playback', true);
    });
    expect(result.current.micReplying).toBe(true);
    // The final transcript closes the session — no stale "reply playing".
    await act(async () => {
      lastClient!.emit('transcript', { type: 'final', text: 'rice' });
    });
    expect(result.current.micReplying).toBe(false);
    expect(onFinal).toHaveBeenCalledWith('rice');
  });

  it('hands the FINAL input transcription to onFinal, then closes the session', async () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal }));
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
      lastClient!.emit('transcript', { type: 'final', text: '  chicken, rice and onion for 4  ' });
    });
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('chicken, rice and onion for 4');
    expect(lastClient!.disconnectCalls).toBe(1);
    expect(result.current.listening).toBe(false);
  });

  it('ignores partial transcriptions — only the final utterance is dictation', async () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal }));
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('transcript', { type: 'partial', text: 'chicken' });
      lastClient!.emit('transcript', { type: 'final', text: '' });
    });
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(true);
  });

  it('a second tap mid-listen cancels (barge-in) without dictating anything', async () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal }));
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      await result.current.toggle();
    });
    expect(lastClient!.disconnectCalls).toBe(1);
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toBeNull(); // barge-in close is a clean idle
  });

  it('an UNEXPECTED server close surfaces an honest error (never a silent idle)', async () => {
    const { result } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
    });
    // The server drops the session (e.g. a rejected setup) — we did not close it.
    await act(async () => {
      lastClient!.emit('status', 'DISCONNECTED');
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toContain('type your ingredients');
  });

  it('a NEW session is not poisoned by a previous barge-in flag', async () => {
    const { result } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
      await result.current.toggle(); // barge-in: intentional close
    });
    await act(async () => {
      await result.current.toggle(); // fresh session
      lastClient!.emit('status', 'DISCONNECTED'); // server drops IT unexpectedly
    });
    expect(result.current.error).toContain('type your ingredients');
  });

  it('names the exact failing hop in the error once the self-check probes land', async () => {
    // A deferred probe lets the test observe the immediate reason BEFORE the
    // enrichment lands, proving the fallback never waits on the probes.
    let resolveProbe!: (v: VoiceSelfCheckResult) => void;
    vi.mocked(runVoiceSelfCheck).mockReturnValueOnce(
      new Promise((r) => {
        resolveProbe = r;
      }),
    );
    const { result } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      lastClient!.emit('error', new Error('Could not open the voice connection.'));
      lastClient!.emit('status', 'ERROR');
    });
    // Immediate reason first — the fallback must not wait on the probes…
    expect(result.current.error).toContain("couldn't start");
    // …then the probes land and the error names the failing hop with the
    // dictation-specific fallback wording.
    await act(async () => {
      resolveProbe({
        token: { ok: false, httpStatus: 503, error: null },
        websocket: { opened: true, closeCode: null, error: null },
      });
      await Promise.resolve();
    });
    expect(result.current.error).toContain('HTTP 503');
    expect(result.current.error).toContain('you can type your ingredients instead.');
    expect(vi.mocked(runVoiceSelfCheck)).toHaveBeenCalledWith(
      expect.objectContaining({ tokenUrl: '/api/voice/token' }),
    );
  });

  it('maps a microphone error to a friendly permission message', async () => {
    const { result } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('error', new Error('Microphone unavailable — check your browser permission.'));
    });
    expect(result.current.error).toContain('Microphone permission denied');
    expect(result.current.listening).toBe(false);
  });

  it('stops with an honest message when nothing is spoken (quiet timeout)', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveDictation({ quietTimeoutMs: 15000 }));
    await act(async () => {
      await result.current.toggle();
    });
    await act(async () => {
      vi.advanceTimersByTime(14999);
    });
    expect(result.current.listening).toBe(true); // still listening before the deadline
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toContain('did not hear anything');
    expect(lastClient!.disconnectCalls).toBe(1);
  });

  it('a final transcript before the quiet deadline cancels the timer (no late error)', async () => {
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal }));
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
      lastClient!.emit('transcript', { type: 'final', text: 'onion' });
    });
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(onFinal).toHaveBeenCalledWith('onion');
    expect(result.current.error).toBeNull();
    expect(result.current.listening).toBe(false);
  });

  it('a flush-late final (server emits it after the quiet-timeout disconnect) still fills the prompt and clears the error', async () => {
    // The Live server only emits the FINAL input transcription after the audio
    // stream ends. When the flush arrives after the 15s quiet-timeout already
    // fired (timeout → disconnect() → audioStreamEnd → server transcribes the
    // utterance it was holding), the transcript must STILL reach onFinal and
    // clear the timeout's "did not hear anything" error — the user DID speak.
    vi.useFakeTimers();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useLiveDictation({ onFinal, quietTimeoutMs: 15000 }));
    await act(async () => {
      await result.current.toggle();
      lastClient!.emit('status', 'CONNECTED');
    });
    // Nothing heard for 15s → the quiet timeout fires (disconnect flushes).
    await act(async () => {
      vi.advanceTimersByTime(15001);
    });
    expect(result.current.error).toContain('did not hear anything');
    expect(onFinal).not.toHaveBeenCalled();
    // ~1-2s later the flushed transcription lands: onFinal fires and the
    // contradictory error is cleared.
    await act(async () => {
      vi.advanceTimersByTime(1500);
      lastClient!.emit('transcript', { type: 'final', text: 'chicken rice onion' });
    });
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith('chicken rice onion');
    expect(result.current.error).toBeNull();
    expect(result.current.listening).toBe(false);
  });

  it('unmount disconnects the session — no dangling socket', async () => {
    const { result, unmount } = renderHook(() => useLiveDictation());
    await act(async () => {
      await result.current.toggle();
    });
    unmount();
    expect(lastClient!.disconnectCalls).toBe(1);
  });
});
