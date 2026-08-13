// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTimerChimeForTests, playTimerChime, unlockAudioOnGesture, type AudioContextLike } from './timer-chime';

// ─────────────────────────────────────────────────────────────────────────────
// timer-chime.test.ts — the chime must be gesture-gated: it only sounds once
// the AudioContext is running (i.e. after a user gesture resumed it), and it
// is silent while suspended or when Web Audio is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeCtx(state: string) {
  const gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  const osc = {
    type: '',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => gain),
    createOscillator: vi.fn(() => osc),
    resume: vi.fn(async () => {}),
  };
  return { ctx, gain, osc };
}

function installAudioContext(instance: AudioContextLike) {
  const Ctor = function () {
    return instance;
  } as unknown as new () => AudioContextLike;
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: Ctor });
}

function removeAudioContext() {
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  delete w.AudioContext;
  delete w.webkitAudioContext;
}

beforeEach(() => __resetTimerChimeForTests());

afterEach(() => {
  removeAudioContext();
  vi.unstubAllGlobals();
});

describe('timer-chime', () => {
  it('plays the two-tone chime when the context is running', () => {
    const { ctx, osc, gain } = makeFakeCtx('running');
    installAudioContext(ctx);

    playTimerChime();

    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(osc.frequency.setValueAtTime).toHaveBeenNthCalledWith(1, 880, 0);
    expect(osc.frequency.setValueAtTime).toHaveBeenNthCalledWith(2, 1320, 0.18);
    expect(osc.start).toHaveBeenCalledWith(0);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalled();
    expect(osc.connect).toHaveBeenCalledWith(gain);
  });

  it('is silent while the context is suspended (no user gesture yet)', () => {
    const { ctx } = makeFakeCtx('suspended');
    installAudioContext(ctx);

    playTimerChime();

    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createGain).not.toHaveBeenCalled();
  });

  it('is silent when Web Audio is unavailable', () => {
    // No AudioContext installed — must not throw.
    expect(() => playTimerChime()).not.toThrow();
  });

  it('resumes a suspended context on the first user gesture', () => {
    const { ctx } = makeFakeCtx('suspended');
    installAudioContext(ctx);

    unlockAudioOnGesture();
    window.dispatchEvent(new Event('pointerdown'));

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    // After the first gesture the listener is gone — a second event must not
    // resume again.
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('reuses a single shared AudioContext across chimes', () => {
    const { ctx } = makeFakeCtx('running');
    let constructions = 0;
    const Ctor = function () {
      constructions += 1;
      return ctx;
    } as unknown as new () => AudioContextLike;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: Ctor });

    playTimerChime();
    playTimerChime();

    expect(constructions).toBe(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });
});
