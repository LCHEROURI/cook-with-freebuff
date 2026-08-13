/**
 * Timer chime for the landing resume card — a short two-tone Web Audio beep
 * that can only play after the user has interacted with the page.
 *
 * Browsers suspend the AudioContext until the first user gesture (pointer,
 * key, or touch). That policy IS the gesture gate: without a gesture the
 * context stays suspended and playTimerChime no-ops; unlockAudioOnGesture
 * resumes it on the first interaction, after which alerts may chime.
 */

/** Minimal AudioContext surface used by the chime (jsdom-safe). */
export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  resume(): Promise<void>;
}

export interface GainNodeLike {
  gain: { setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void };
  connect(dest: unknown): void;
}

export interface OscillatorNodeLike {
  type: string;
  frequency: { setValueAtTime(v: number, t: number): void };
  connect(dest: unknown): void;
  start(t: number): void;
  stop(t: number): void;
}

let sharedCtx: AudioContextLike | null = null;

function getCtx(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/**
 * Resume the chime context on the first user gesture. Called once when the
 * landing page mounts; the listeners remove themselves after the first event.
 */
export function unlockAudioOnGesture(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock);
}

/**
 * Play the short two-tone chime (880 -> 1320 Hz, ~0.65s). Silently does
 * nothing when the AudioContext is unavailable or still suspended (no user
 * gesture yet) — the autoplay policy is the gate, never an error.
 */
export function playTimerChime(): void {
  const ctx = getCtx();
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.setValueAtTime(1320, now + 0.18);
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.65);
}

/** Test hook — drop the cached context so each test starts fresh. */
export function __resetTimerChimeForTests(): void {
  sharedCtx = null;
}
