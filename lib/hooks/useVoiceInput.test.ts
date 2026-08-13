// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceInput } from './useVoiceInput';
import type { SpeechRecognitionLike } from './useVoiceInput';
import { runWebSpeechSelfCheck } from '@/lib/voice/self-check';

// The Web Speech self-check probes navigator.mediaDevices — swap it for a
// deterministic stub. Healthy by default so non-fatal tests keep their own
// error text; the fatal-path tests override the probe result.
vi.mock('@/lib/voice/self-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/self-check')>();
  return {
    ...actual,
    runWebSpeechSelfCheck: vi.fn().mockResolvedValue({ api: true, mic: 'granted' }),
  };
});

// ============================================================================
// lib/hooks/useVoiceInput.test.ts — the real-microphone surface of /cook.
// The Web Speech API is stubbed with a fake recognition object so the full
// lifecycle is locked at the unit level: toggle → start, interim streaming,
// continuous accumulation, flush-on-stop, auto-restart on timeout/error,
// fatal-only error surfacing, unsupported-browser fallback, unmount.
// ============================================================================

class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  interimResults = true;
  maxAlternatives = 1;
  continuous = true;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  start() {
    this.started = true;
    this.stopped = false;
    this.aborted = false;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
}

let lastInstance: FakeRecognition | null = null;

function installFake() {
  lastInstance = null;
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = class extends FakeRecognition {
    constructor() {
      super();
      lastInstance = this;
    }
  };
}

function clearApi() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
}

function resultEvent(transcript: string, isFinal: boolean, resultIndex = 0) {
  return {
    resultIndex,
    results: [{ isFinal, length: 1, 0: { transcript } }],
  };
}

beforeEach(() => {
  // clearAllMocks (not restoreAllMocks): the self-check mock's resolved
  // value must survive between tests — restore would wipe it to undefined.
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearApi();
  lastInstance = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useVoiceInput', () => {
  it('reports unsupported when the browser has no SpeechRecognition', () => {
    const { result } = renderHook(() => useVoiceInput());
    expect(result.current.supported).toBe(false);
    expect(result.current.listening).toBe(false);
  });

  it('toggle starts a fresh recognition and flips listening on', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    expect(result.current.supported).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.listening).toBe(true);
    expect(lastInstance?.started).toBe(true);
  });

  it('streams interim results live without firing onFinal', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onresult?.(resultEvent('dice the', false));
    });
    expect(result.current.interim).toBe('dice the');
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('accumulates final utterances in the buffer — does NOT call onFinal per utterance', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());

    act(() => {
      lastInstance?.onresult?.(resultEvent('done', true));
    });
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.interim).toBe('');

    const first = { isFinal: true, length: 1, 0: { transcript: 'done' } };
    const second = { isFinal: true, length: 1, 0: { transcript: 'repeat' } };
    act(() => {
      lastInstance?.onresult?.({ resultIndex: 1, results: [first, second] });
    });
    expect(onFinal).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    expect(onFinal).toHaveBeenCalledWith('done repeat');
    expect(result.current.listening).toBe(false);
  });

  it('flushes the accumulated buffer on stop and fires onFinal once', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onresult?.(resultEvent('chicken', true));
    });
    const c = { isFinal: true, length: 1, 0: { transcript: 'chicken' } };
    const r = { isFinal: true, length: 1, 0: { transcript: 'rice' } };
    act(() => {
      lastInstance?.onresult?.({ resultIndex: 1, results: [c, r] });
    });
    act(() => result.current.stop());
    expect(onFinal).toHaveBeenCalledWith('chicken rice');
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it('does not call onFinal when the buffer is empty on stop', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());
    act(() => result.current.stop());
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('auto-restarts recognition on timeout after a short delay', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    expect(lastInstance?.started).toBe(true);
    lastInstance!.started = false;
    act(() => {
      lastInstance?.onend?.();
    });
    // Not restarted yet — the 100ms timer hasn't fired.
    expect(lastInstance?.started).toBe(false);
    // Advance past the delay.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.listening).toBe(true);
    expect(lastInstance?.started).toBe(true);
  });

  it('does not restart on timeout if the user explicitly stopped first', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    // User stops.
    act(() => result.current.stop());
    lastInstance!.started = false;
    // A late onend fires after stop — should be ignored.
    act(() => {
      lastInstance?.onend?.();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(lastInstance?.started).toBe(false);
  });

  it('no-speech errors trigger a restart, not a fatal error', () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'no-speech' });
    });
    // No error surfaced, still listening.
    expect(result.current.error).toBeNull();
    expect(result.current.listening).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    // Timer fires the restart.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(lastInstance?.started).toBe(true);
  });

  it('a network error triggers a restart, not a fatal error (first time)', () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'network' });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.listening).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('exhausts network retries, then fails with a hop-named reason (no silent drop)', async () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    // Two retryable failures are absorbed…
    act(() => {
      lastInstance?.onerror?.({ error: 'network' });
      lastInstance?.onerror?.({ error: 'network' });
    });
    expect(result.current.error).toBeNull();
    // …the third must surface honestly, naming the speech-service hop.
    act(() => {
      lastInstance?.onerror?.({ error: 'network' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toContain('unreachable');
    expect(onError).toHaveBeenCalled();
    expect(runWebSpeechSelfCheck).toHaveBeenCalled();
    // Stale restart timers must not resurrect a failed session.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.listening).toBe(false);
  });

  it('bounds audio-capture retries the same way, naming the mic hop', async () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'audio-capture' });
      lastInstance?.onerror?.({ error: 'audio-capture' });
      lastInstance?.onerror?.({ error: 'audio-capture' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.listening).toBe(false);
    expect(result.current.error).toContain('could not capture audio');
  });

  it('permission denied is still a fatal error, named by the mic probe', async () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'not-allowed' });
    });
    // Immediate reason first — the fallback must not wait on the probes.
    expect(result.current.error).toContain('Microphone permission denied');
    expect(result.current.listening).toBe(false);
    expect(onError).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toContain('Microphone permission');
  });

  it('unmount aborts the active recognition — no dangling listeners', () => {
    installFake();
    const { result, unmount } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    const instance = lastInstance;
    unmount();
    expect(instance?.aborted).toBe(true);
  });

  it('ignores the aborted error event (user-cancelled is not an error)', () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'aborted' });
    });
    expect(result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('creates a fresh recognition on each new listening session', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    const first = lastInstance;
    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(lastInstance).not.toBe(first);
    expect(lastInstance?.started).toBe(true);
  });
});
