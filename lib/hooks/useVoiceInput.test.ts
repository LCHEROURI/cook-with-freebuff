// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceInput } from './useVoiceInput';
import type { SpeechRecognitionLike } from './useVoiceInput';

// ============================================================================
// lib/hooks/useVoiceInput.test.ts — the real-microphone surface of /cook.
// The Web Speech API is stubbed with a fake recognition object so the full
// lifecycle is locked at the unit level: toggle → start, interim streaming,
// continuous accumulation, flush-on-stop, auto-restart on timeout,
// error mapping, unsupported-browser fallback, unmount.
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
  vi.restoreAllMocks();
  clearApi();
  lastInstance = null;
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

    // First utterance finalises.
    act(() => {
      lastInstance?.onresult?.(resultEvent('done', true));
    });
    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.interim).toBe('');

    // Second utterance finalises — the real API fires with cumulative results.
    const first = { isFinal: true, length: 1, 0: { transcript: 'done' } };
    const second = { isFinal: true, length: 1, 0: { transcript: 'repeat' } };
    act(() => {
      lastInstance?.onresult?.({ resultIndex: 1, results: [first, second] });
    });
    expect(onFinal).not.toHaveBeenCalled();

    // Buffer is flushed only on explicit stop.
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

  it('auto-restarts recognition on timeout instead of turning listening off', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    expect(lastInstance?.started).toBe(true);
    // Simulate a browser timeout (onend fires without explicit stop).
    lastInstance!.started = false;
    act(() => {
      lastInstance?.onend?.();
    });
    // The hook restarted — still listening.
    expect(result.current.listening).toBe(true);
    expect(lastInstance?.started).toBe(true);
  });

  it('maps a permission denial to a human message and reports via onError', () => {
    installFake();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onError }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'not-allowed' });
    });
    expect(result.current.error).toContain('Microphone permission denied');
    expect(result.current.listening).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('maps no-speech and network errors distinctly', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'no-speech' });
    });
    expect(result.current.error).toContain('I did not hear anything');
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onerror?.({ error: 'network' });
    });
    expect(result.current.error).toContain('you can type instead');
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
    // Stop (flush).
    act(() => result.current.toggle());
    // Start a new session.
    act(() => result.current.toggle());
    expect(lastInstance).not.toBe(first);
    expect(lastInstance?.started).toBe(true);
  });
});
