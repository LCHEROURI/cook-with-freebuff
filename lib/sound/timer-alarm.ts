/**
 * Timer Audio Chime & Mobile Haptics
 *
 * Provides synthesized Web Audio API kitchen chimes and mobile vibration
 * without loading external media assets. Safe for SSR, TWA, and cross-browser use.
 */

// Global AudioContext singleton to reuse across timer alerts
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioCtx();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export function resetAudioContext(): void {
  audioCtx = null;
}

/**
 * Plays a pleasant 3-tone kitchen timer completion chime using Web Audio synthesis.
 * Tones: D5 (587.33Hz) -> A5 (880Hz) -> D6 (1174.66Hz)
 */
export async function playTimerChime(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;

  try {
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const now = ctx.currentTime;
    const tones = [
      { freq: 587.33, start: 0.0, duration: 0.15 },
      { freq: 880.0, start: 0.15, duration: 0.15 },
      { freq: 1174.66, start: 0.3, duration: 0.4 },
    ];

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone.freq, now + tone.start);

      // Smooth attack and exponential decay to prevent clicks
      gain.gain.setValueAtTime(0.0001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.3, now + tone.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.duration + 0.05);
    }

    return true;
  } catch {
    // Audio autoplay blocked or unsupported — fail gracefully without breaking UI
    return false;
  }
}

/**
 * Triggers mobile haptic vibration pattern for kitchen timer completion.
 * [300ms buzz, 150ms pause, 300ms buzz, 150ms pause, 600ms buzz]
 */
export function triggerTimerHaptics(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  try {
    if (typeof navigator.vibrate === 'function') {
      return navigator.vibrate([300, 150, 300, 150, 600]);
    }
  } catch {
    // Vibration blocked or denied
  }
  return false;
}

/**
 * Triggers full kitchen timer alarm: Web Audio chime + Mobile haptics.
 */
export async function triggerTimerAlarm(): Promise<{ audioPlayed: boolean; hapticsTriggered: boolean }> {
  const hapticsTriggered = triggerTimerHaptics();
  const audioPlayed = await playTimerChime();
  return { audioPlayed, hapticsTriggered };
}
