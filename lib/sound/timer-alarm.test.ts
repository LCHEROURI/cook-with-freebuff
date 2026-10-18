// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playTimerChime, triggerTimerHaptics, triggerTimerAlarm, resetAudioContext, unlockAudioContext } from './timer-alarm';

describe('timer-alarm', () => {
  const originalAudioContext = window.AudioContext;
  const originalVibrate = navigator.vibrate;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAudioContext();
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    if (originalVibrate) {
      navigator.vibrate = originalVibrate;
    } else {
      delete (navigator as { vibrate?: unknown }).vibrate;
    }
  });

  describe('triggerTimerHaptics', () => {
    it('triggers navigator.vibrate with the expected kitchen timer vibration pattern', () => {
      const mockVibrate = vi.fn().mockReturnValue(true);
      navigator.vibrate = mockVibrate;

      const result = triggerTimerHaptics();
      expect(result).toBe(true);
      expect(mockVibrate).toHaveBeenCalledWith([300, 150, 300, 150, 600]);
    });

    it('returns false gracefully when navigator.vibrate is unavailable', () => {
      delete (navigator as { vibrate?: unknown }).vibrate;
      const result = triggerTimerHaptics();
      expect(result).toBe(false);
    });

    it('returns false gracefully when navigator.vibrate throws', () => {
      navigator.vibrate = vi.fn(() => {
        throw new Error('Not allowed');
      });
      const result = triggerTimerHaptics();
      expect(result).toBe(false);
    });
  });

  describe('playTimerChime', () => {
    it('synthesizes a 3-tone chime using Web Audio API nodes', async () => {
      const mockGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };

      const mockOscillator = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const mockAudioCtx = {
        state: 'running',
        currentTime: 0,
        destination: {},
        createGain: vi.fn(() => mockGainNode),
        createOscillator: vi.fn(() => mockOscillator),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      window.AudioContext = vi.fn(() => mockAudioCtx) as unknown as typeof AudioContext;

      const result = await playTimerChime();
      expect(result).toBe(true);
      expect(mockAudioCtx.createOscillator).toHaveBeenCalledTimes(3);
      expect(mockAudioCtx.createGain).toHaveBeenCalledTimes(3);
      expect(mockOscillator.start).toHaveBeenCalledTimes(3);
      expect(mockOscillator.stop).toHaveBeenCalledTimes(3);
    });

    it('resumes audio context if it was suspended before playback', async () => {
      const mockGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };

      const mockOscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const mockAudioCtx = {
        state: 'suspended',
        currentTime: 0,
        destination: {},
        createGain: vi.fn(() => mockGainNode),
        createOscillator: vi.fn(() => mockOscillator),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      window.AudioContext = vi.fn(() => mockAudioCtx) as unknown as typeof AudioContext;

      const result = await playTimerChime();
      expect(result).toBe(true);
      expect(mockAudioCtx.resume).toHaveBeenCalledTimes(1);
    });

    it('returns false gracefully when AudioContext is not supported', async () => {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;

      const result = await playTimerChime();
      expect(result).toBe(false);
    });
  });

  describe('unlockAudioContext', () => {
    it('resumes suspended context and plays a 1-sample silent buffer during user gesture', () => {
      const mockBufferSource = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      };
      const mockAudioCtx = {
        state: 'suspended',
        currentTime: 0,
        destination: {},
        createBuffer: vi.fn(() => ({})),
        createBufferSource: vi.fn(() => mockBufferSource),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      window.AudioContext = vi.fn(() => mockAudioCtx) as unknown as typeof AudioContext;

      const ctx = unlockAudioContext();
      expect(ctx).toBe(mockAudioCtx);
      expect(mockAudioCtx.resume).toHaveBeenCalled();
      expect(mockAudioCtx.createBuffer).toHaveBeenCalledWith(1, 1, 22050);
      expect(mockBufferSource.start).toHaveBeenCalledWith(0);
    });

    it('returns null gracefully when AudioContext is unsupported', () => {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;

      const ctx = unlockAudioContext();
      expect(ctx).toBeNull();
    });
  });

  describe('triggerTimerAlarm', () => {
    it('triggers both audio chime and haptics', async () => {
      const mockVibrate = vi.fn().mockReturnValue(true);
      navigator.vibrate = mockVibrate;

      const mockGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };

      const mockOscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const mockAudioCtx = {
        state: 'running',
        currentTime: 0,
        destination: {},
        createGain: vi.fn(() => mockGainNode),
        createOscillator: vi.fn(() => mockOscillator),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      window.AudioContext = vi.fn(() => mockAudioCtx) as unknown as typeof AudioContext;

      const result = await triggerTimerAlarm();
      expect(result.hapticsTriggered).toBe(true);
      expect(result.audioPlayed).toBe(true);
    });

    it('suppresses redundant alarm triggers within the cooldown period unless forced', async () => {
      const mockVibrate = vi.fn().mockReturnValue(true);
      navigator.vibrate = mockVibrate;

      const mockGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };

      const mockOscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const mockAudioCtx = {
        state: 'running',
        currentTime: 0,
        destination: {},
        createGain: vi.fn(() => mockGainNode),
        createOscillator: vi.fn(() => mockOscillator),
        resume: vi.fn().mockResolvedValue(undefined),
      };

      window.AudioContext = vi.fn(() => mockAudioCtx) as unknown as typeof AudioContext;

      const first = await triggerTimerAlarm();
      expect(first.audioPlayed).toBe(true);

      // Immediately triggering again within 1.5s is suppressed
      const second = await triggerTimerAlarm();
      expect(second.audioPlayed).toBe(false);
      expect(second.hapticsTriggered).toBe(false);

      // Force bypasses the cooldown
      const third = await triggerTimerAlarm({ force: true });
      expect(third.audioPlayed).toBe(true);
      expect(third.hapticsTriggered).toBe(true);
    });
  });
});
