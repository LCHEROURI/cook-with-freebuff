// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScreenWakeLock } from './useScreenWakeLock';

describe('useScreenWakeLock', () => {
  let releaseMock: ReturnType<typeof vi.fn>;
  let requestMock: ReturnType<typeof vi.fn>;
  let addEventListenerMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    releaseMock = vi.fn().mockResolvedValue(undefined);
    addEventListenerMock = vi.fn();
    requestMock = vi.fn().mockResolvedValue({
      released: false,
      release: releaseMock,
      addEventListener: addEventListenerMock,
    });

    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects wakeLock support', () => {
    const { result } = renderHook(() => useScreenWakeLock({ enabled: false }));
    expect(result.current.supported).toBe(true);
    expect(result.current.isLocked).toBe(false);
  });

  it('automatically requests wake lock when enabled is true', async () => {
    const { result } = renderHook(() => useScreenWakeLock({ enabled: true }));
    // Wait for the effect to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(requestMock).toHaveBeenCalledWith('screen');
    expect(result.current.isLocked).toBe(true);
  });

  it('releases lock when enabled transitions to false', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useScreenWakeLock({ enabled }), {
      initialProps: { enabled: true },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isLocked).toBe(true);

    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });

    expect(releaseMock).toHaveBeenCalled();
    expect(result.current.isLocked).toBe(false);
  });

  it('handles unsupported environments without throwing', () => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;

    const { result } = renderHook(() => useScreenWakeLock({ enabled: true }));
    expect(result.current.supported).toBe(false);
    expect(result.current.isLocked).toBe(false);
  });
});
