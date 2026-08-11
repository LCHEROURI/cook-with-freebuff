// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceInput } from './useVoiceInput';
import type { SpeechRecognitionLike } from './useVoiceInput';

// ============================================================================
// lib/hooks/useVoiceInput.test.ts — the real-microphone surface of /cook.
// The Web Speech API is stubbed with a fake recognition object so the full
// lifecycle is locked at the unit level: toggle → start, interim streaming,
// final-transcript handoff (into the EXISTING voice.send path), auto-end,
// barge-in cancel, error mapping, unsupported-browser fallback, unmount.
// ============================================================================

class FakeRecognition implements SpeechRecognitionLike {
  lang = '';
  interimResults = true;
  maxAlternatives = 1;
  continuous = false;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  started = false;
  aborted = false;
  start() {
    this.started = true;
  }
  stop() {
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
    // After the recognition auto-ends (utterance delivered), the next tap
    // creates a FRESH instance — never a reused/stale one.
    const first = lastInstance;
    act(() => {
      lastInstance?.onend?.();
    });
    act(() => result.current.toggle());
    expect(lastInstance).not.toBe(first);
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

  it('fires onFinal with the trimmed transcript and clears the interim caption', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onresult?.(resultEvent('  done  ', true));
    });
    expect(onFinal).toHaveBeenCalledWith('done');
    expect(result.current.interim).toBe('');
  });

  it('resets listening when the recognition ends (auto-stop after the utterance)', () => {
    installFake();
    const { result } = renderHook(() => useVoiceInput());
    act(() => result.current.toggle());
    expect(result.current.listening).toBe(true);
    act(() => {
      lastInstance?.onend?.();
    });
    expect(result.current.listening).toBe(false);
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

  it('a second toggle while listening aborts and discards the partial utterance', () => {
    installFake();
    const onFinal = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onFinal }));
    act(() => result.current.toggle());
    act(() => {
      lastInstance?.onresult?.(resultEvent('repeat the', false));
    });
    const first = lastInstance;
    act(() => result.current.toggle());
    expect(first?.aborted).toBe(true);
    expect(result.current.listening).toBe(false);
    expect(result.current.interim).toBe('');
    // The partial utterance never reached the agent.
    expect(onFinal).not.toHaveBeenCalled();
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
});
