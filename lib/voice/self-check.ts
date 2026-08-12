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
): Promise<TokenProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return (async () => {
    try {
      const bearer = await getToken?.();
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
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
  /** Live WebSocket base URL (no query string). Defaults to LIVE_WS_URL. */
  wsUrl?: string;
}): Promise<VoiceSelfCheckResult> {
  const [token, websocket] = await Promise.all([
    probeTokenEndpoint(opts.tokenUrl, opts.getToken),
    probeWebSocket(opts.wsUrl ?? LIVE_WS_URL),
  ]);
  return { token, websocket };
}

/**
 * Name the exact failing hop from the self-check results. Falls back to the
 * session's own message when the probes are inconclusive.
 */
export function composeHopReason(baseMessage: string, check: VoiceSelfCheckResult): string {
  const fallback = 'Using the built-in speech fallback instead.';
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
