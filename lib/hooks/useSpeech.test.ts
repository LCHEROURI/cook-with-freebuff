// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeech } from './useSpeech';

const speak = vi.fn();
const cancel = vi.fn();

class FakeUtterance {
  text: string;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

beforeEach(() => {
  speak.mockReset();
  cancel.mockReset();
  vi.stubGlobal('speechSynthesis', { speak, cancel, speaking: false });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSpeech', () => {
  it('speaks trimmed text', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('  Added 2 eggs  '));
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe('Added 2 eggs');
  });

  it('ignores blanks', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('   '));
    expect(speak).not.toHaveBeenCalled();
  });

  it('reports unsupported when the API value is missing', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
    expect(() => result.current.speak('hi')).not.toThrow();
  });

  it('reports unsupported when the utterance constructor is missing', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
  });
});
