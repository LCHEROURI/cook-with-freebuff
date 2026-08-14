// ─────────────────────────────────────────────────────────────────────────────
// lib/voice/self-check.ts — independent probes of the two voice hops.
//
// When a Gemini Live session fails, the client's own error can only describe
// what IT observed. These probes test each hop in isolation — the token
// endpoint (HTTP status) and the Live WebSocket transport (does a socket even
// open?) — so the fallback banner can name the exact failing hop: a rejected
// request (bad key), an unreachable endpoint (offline/DNS), or a blocked
// socket (firewall/VPN).
// ─────────────────────────────────────────────────────────────────────────────

import { LIVE_WS_URL } from './gemini-live';

export interface TokenProbe {
  ok: boolean;
  httpStatus: number | null;
  /** 'network' (fetch threw), 'timeout' (aborted), or null on a response. */
  error: 'network' | 'timeout' | null;
}

export interface WebSocketProbe {
  opened: boolean;
  closeCode: number | null;
  /** 'timeout', 'connection-failed', 'construct', or null when it opened/closed. */
  error: 'timeout' | 'connection-failed' | 'construct' | null;
}

export interface VoiceSelfCheckResult {
  token: TokenProbe;
  websocket: WebSocketProbe;
}

const PROBE_TIMEOUT_MS = 3000;

// Individual probes are exported for unit tests (same pattern as the frame
// helpers in gemini-live.ts); runVoiceSelfCheck is what the app calls.
export function probeTokenEndpoint(
  tokenUrl: string,
  getToken: (() => Promise<string | null> | string | null) | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
  getAppCheckHeaders?: (forceRefresh?: boolean) => Promise<Record<string, string>>,
): Promise<TokenProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return (async () => {
    try {
      const bearer = await getToken?.();
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(await getAppCheckHeaders?.(true)) },
        signal: controller.signal,
      });
      return { ok: res.ok, httpStatus: res.status, error: null };
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      return { ok: false, httpStatus: null, error: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  })();
}

export function probeWebSocket(wsUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<WebSocketProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: WebSocketProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      // Settle the timeout verdict first — the close we fire below (to clean
      // up) must not overwrite it with a real close code.
      done({ opened: false, closeCode: null, error: 'timeout' });
      try {
        ws?.close();
      } catch {
        // already closed
      }
    }, timeoutMs);

    let ws: WebSocket | null = null;
    try {
      // A dummy token: the socket opens if the transport hop is reachable —
      // the server then closes it as invalid, which is exactly what we want
      // to observe (open = the hop works; the real session's failure was
      // upstream, e.g. a bad minted token).
      ws = new WebSocket(`${wsUrl}?access_token=probe`);
    } catch {
      done({ opened: false, closeCode: null, error: 'construct' });
      return;
    }
    ws.onopen = () => {
      // Settle opened FIRST — the close event that follows must not overwrite
      // the "the transport hop works" verdict.
      done({ opened: true, closeCode: null, error: null });
      try {
        ws?.close();
      } catch {
        // already closed
      }
    };
    ws.onerror = () => done({ opened: false, closeCode: null, error: 'connection-failed' });
    ws.onclose = (e) => {
      if (!settled) done({ opened: false, closeCode: e.code ?? null, error: null });
    };
  });
}

/**
 * Probe both voice hops independently. Never throws — always returns a result
 * so the caller can name the failing hop even when everything is broken.
 */
export async function runVoiceSelfCheck(opts: {
  tokenUrl: string;
  getToken?: (() => Promise<string | null> | string | null) | undefined;
  getAppCheckHeaders?: (forceRefresh?: boolean) => Promise<Record<string, string>>;
  /** Live WebSocket base URL (no query string). Defaults to LIVE_WS_URL. */
  wsUrl?: string;
}): Promise<VoiceSelfCheckResult> {
  const [token, websocket] = await Promise.all([
    probeTokenEndpoint(opts.tokenUrl, opts.getToken, PROBE_TIMEOUT_MS, opts.getAppCheckHeaders),
    probeWebSocket(opts.wsUrl ?? LIVE_WS_URL),
  ]);
  // Structured hop results — a console paste alone then diagnoses the failure
  // (which hop broke and how), even when the banner text was dismissed.
  console.error(
    `[voice:self-check] token ok=${token.ok} httpStatus=${token.httpStatus ?? 'null'} error=${token.error ?? 'null'}`,
  );
  console.error(
    `[voice:self-check] websocket opened=${websocket.opened} closeCode=${websocket.closeCode ?? 'null'} error=${websocket.error ?? 'null'}`,
  );
  return { token, websocket };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Speech fallback self-check.
//
// The Gemini Live path probes a token endpoint + WebSocket. The Web Speech
// fallback has different hops: browser API availability, microphone access
// (getUserMedia), and the browser's speech-service error codes. When the
// fallback fails, these probes name which hop actually broke.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebSpeechSelfCheckResult {
  /** Whether the browser exposes a SpeechRecognition constructor at all. */
  api: boolean;
  /** Mic probe outcome: permission granted, denied, no device, or unknown. */
  mic: 'granted' | 'denied' | 'not-found' | 'unknown';
}

/** True when the browser has a Web Speech recognition constructor. */
export function webSpeechApiAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** The voice engine the browser can actually use — a pure capability check. */
export type VoiceEngine = 'gemini-live' | 'web-speech' | 'none';

/**
 * Which mic engine /cook will use, from browser capability alone: Gemini Live
 * needs a WebSocket + fetch + Web Audio; Web Speech needs a SpeechRecognition
 * constructor. The active-screen page computes the same answer from runtime
 * state; this is the static capability probe the landing card uses so users
 * see the engine without opening /cook.
 */
export function detectVoiceEngine(): VoiceEngine {
  if (typeof window === 'undefined') return 'none';
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  if (typeof WebSocket !== 'undefined' && typeof fetch === 'function' && Boolean(w.AudioContext || w.webkitAudioContext)) {
    return 'gemini-live';
  }
  return webSpeechApiAvailable() ? 'web-speech' : 'none';
}

/** Probe microphone access directly — the probe that names the real hop. */
export async function probeWebSpeechMic(timeoutMs = 3000): Promise<WebSpeechSelfCheckResult['mic']> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) return 'unknown';
  // Timeout via a race (the DOM type for getUserMedia constraints has no
  // signal field) so a hanging permission prompt never blocks the verdict.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = await Promise.race([
      md.getUserMedia({ audio: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('probe timed out', 'TimeoutError')), timeoutMs);
      }),
    ]);
    // We only needed to know the mic is reachable — release it immediately.
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (e) {
    const name = e instanceof DOMException ? e.name : (e as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'not-found';
    return 'unknown';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe the Web Speech hops independently and log a structured line, matching
 * the Gemini self-check: a console paste alone names the failing hop.
 */
export async function runWebSpeechSelfCheck(): Promise<WebSpeechSelfCheckResult> {
  const api = webSpeechApiAvailable();
  const mic = await probeWebSpeechMic();
  console.error(`[voice:self-check] webspeech api=${api} mic=${mic}`);
  return { api, mic };
}

/** Name the failing Web Speech hop. Mic probes outrank error codes — the probe
 *  is ground truth for permission/device state; codes speak for the service. */
export function composeWebSpeechReason(errorCode: string | null, check: WebSpeechSelfCheckResult): string {
  if (!check.api) {
    return 'Speech recognition is not supported in this browser — type your message instead.';
  }
  if (check.mic === 'denied') {
    return 'Microphone permission is denied — enable it in your browser settings, then tap the mic again.';
  }
  if (check.mic === 'not-found') {
    return 'No microphone was detected on this device — check your microphone or headset connection.';
  }
  if (errorCode === 'service-not-allowed') {
    return "The browser's speech service is not allowed — check your browser and device settings.";
  }
  if (errorCode === 'network') {
    return "The browser's speech service is unreachable — check your connection, then tap the mic again.";
  }
  if (errorCode === 'audio-capture') {
    return 'The microphone could not capture audio — check that no other app is using it.';
  }
  if (errorCode === 'not-allowed') {
    return 'Microphone permission denied — enable it in your browser to speak.';
  }
  return errorCode ? `Speech recognition failed (${errorCode}).` : 'Speech recognition failed.';
}

/**
 * Name the exact failing hop from the self-check results. Falls back to the
 * session's own message when the probes are inconclusive.
 */
export function composeHopReason(
  baseMessage: string,
  check: VoiceSelfCheckResult,
  fallbackText = 'Using the built-in speech fallback instead.',
): string {
  const fallback = fallbackText;
  const t = check.token;
  if (t.error === 'timeout') {
    return `Gemini Live failed — the voice token endpoint timed out. ${fallback}`;
  }
  if (t.error === 'network') {
    return `Gemini Live failed — the voice token endpoint is unreachable (offline or a blocked network). ${fallback}`;
  }
  if (t.httpStatus !== null && !t.ok) {
    return `Gemini Live failed — the voice service rejected the token request (HTTP ${t.httpStatus}). ${fallback}`;
  }
  if (!check.websocket.opened) {
    const why =
      check.websocket.error === 'timeout'
        ? 'timed out'
        : check.websocket.error === 'connection-failed'
          ? 'was blocked'
          : `closed (code ${check.websocket.closeCode ?? 'unknown'})`;
    return `Gemini Live failed — the voice WebSocket ${why} (firewall, VPN, or network policy?). ${fallback}`;
  }
  if (/did not respond|timed out/.test(baseMessage.toLowerCase())) {
    return `Gemini Live failed — the voice service is reachable but did not respond. ${fallback}`;
  }
  return baseMessage;
}
