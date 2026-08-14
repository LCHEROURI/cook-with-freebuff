'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useGeminiLive — first-party voice for /cook (Gemini Live, not Web Speech).
//
// The mic button in this mode opens a REAL TIME speech session:
//   - the browser mints an ephemeral token via /api/voice/token (the API key
//     never leaves the server), then streams mic audio straight to Gemini
//   - spoken turns arrive as inputTranscription text → shown on screen
//   - Gemini proposes toolCalls → THIS hook executes them through the existing
//     authenticated /api/tools route (the same registry /api/agent uses) and
//     returns the results so the model can speak the outcome
//   - the model's reply streams back as audio + outputTranscription text
//
// Fallbacks stay intact: browsers without Web Audio get the Web Speech mic
// (useVoiceInput) and the typed input works regardless.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GeminiLiveClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_TOKEN_URL,
  type GeminiLiveFunctionResponse,
} from '@/lib/voice/gemini-live';
import { composeHopReason, runVoiceSelfCheck } from '@/lib/voice/self-check';
import { TOOL_DECLARATIONS, buildLiveSystemInstruction } from '@/lib/ai/tool-declarations';
import type { AgentTurn, ExecutedToolCall } from '@/lib/agent/types';
import type { ToolResult } from '@/lib/server/tools/types';
import { appCheckHeaders } from '@/lib/firebase/app-check';

export type LiveMode = 'off' | 'connecting' | 'live';
export type LiveStatus = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'OFFLINE' | 'ERROR';

export interface UseGeminiLiveOptions {
  getToken?: () => Promise<string | null> | string | null;
  tokenUrl?: string;
  toolsEndpoint?: string;
  /** Hard-fail deadline for connect() — forwarded to the client. Default 5000. */
  connectTimeoutMs?: number;
  /** Session context embedded in the Live system instruction (like the orchestrator's). */
  systemContext?: { currentPhase?: string; currentStep?: string; activeTimerIds?: string[] };
  /**
   * Watchdog: after this long of silence while listening (ms), surface the
   * honest "say something or tap to stop" state instead of a frozen
   * "Listening…". Any activity (a spoken turn, a reply, a tool call, a tap)
   * resets it. Default 20000.
   */
  silentThresholdMs?: number;
}

const DEFAULT_SILENT_THRESHOLD_MS = 20000;

export interface AutoFallbackDecision {
  /** The user just tapped the Gemini mic (the attempt this failure belongs to). */
  geminiTapped: boolean;
  /** The one-shot fallback already fired for this tap. */
  alreadyFellBack: boolean;
  liveStatus: LiveStatus;
  liveMode: LiveMode;
  webSpeechSupported: boolean;
}

/**
 * The page's one-shot hard-fail: a Gemini mic tap that errors (missing key,
 * blocked WebSocket, connect timeout) continues into the Web Speech fallback
 * on the SAME tap — exactly once, and only when the tap initiated the attempt
 * (never for a mid-session drop the user didn't just trigger).
 */
export function shouldAutoFallbackToWebSpeech(d: AutoFallbackDecision): boolean {
  return (
    d.geminiTapped &&
    !d.alreadyFellBack &&
    d.liveStatus === 'ERROR' &&
    d.liveMode === 'off' &&
    d.webSpeechSupported
  );
}

/**
 * Turn a client failure into a clear, actionable banner: name the cause
 * (missing key, blocked WebSocket, timeout, drop) and tell the user the
 * built-in fallback took over — never a silent "session could not start".
 */
function fallbackReason(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('token endpoint rejected')) {
    return "Gemini Live couldn't start — the voice service rejected the request (check the API key). Using the built-in speech fallback instead.";
  }
  if (m.includes('token endpoint unreachable') || m.includes('could not reach the voice service')) {
    return "Gemini Live couldn't reach the voice service (missing API key or network block). Using the built-in speech fallback instead.";
  }
  if (m.includes('could not open the voice connection')) {
    return "Gemini Live couldn't open the voice connection — a firewall, VPN, or network policy may be blocking it. Using the built-in speech fallback instead.";
  }
  if (m.includes('timed out') || m.includes('did not respond')) {
    return "Gemini Live timed out connecting (slow or blocked network). Using the built-in speech fallback instead.";
  }
  if (m.includes('dropped') || m.includes('failed')) {
    return `Gemini Live's voice connection ${m.includes('dropped') ? 'dropped' : 'failed'}. Using the built-in speech fallback instead.`;
  }
  return `${message} Using the built-in speech fallback instead.`;
}

interface PendingTurn {
  /** Index into the turns array — matching by text would break on repeats ("done" twice). */
  turnIndex: number;
  utterance: string;
  reply: string;
  toolCalls: ExecutedToolCall[];
  finalizing: boolean;
}

export function useGeminiLive(opts: UseGeminiLiveOptions = {}) {
  const toolsEndpoint = opts.toolsEndpoint ?? '/api/tools';

  // Browser capability check — computed once, SSR-safe.
  const [available] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (typeof WebSocket === 'undefined' || typeof fetch !== 'function') return false;
    const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
    return Boolean(w.AudioContext || w.webkitAudioContext);
  });

  const [mode, setMode] = useState<LiveMode>('off');
  const [status, setStatus] = useState<LiveStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  // Live speech energy from the client — true while the user is actually
  // speaking, so the mic status can show a recording bar vs the waiting pulse.
  const [hearing, setHearing] = useState(false);
  // True while the model's spoken reply is playing (or queued): the mic is
  // muted, so the UI must stop inviting speech (no "Listening… speak now").
  const [micReplying, setMicReplying] = useState(false);
  // Watchdog: true while the session is live and listening but nothing has
  // been heard for silentThresholdMs — the caption swaps from the frozen
  // "Listening…" to an honest "say something, or tap to stop".
  const [awaiting, setAwaiting] = useState(false);
  const lastActivityRef = useRef(0);

  const clientRef = useRef<GeminiLiveClient | null>(null);
  // The error message currently on screen, so an async self-check can enrich
  // it without resurrecting a banner the user already dismissed.
  const lastErrorRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingTurn | null>(null);
  const turnsRef = useRef<AgentTurn[]>([]);
  // Monotonic turn counter — React state updates apply lazily, so a ref that
  // advances synchronously is what indexes turns reliably (the live-turns list
  // only ever grows for the lifetime of this hook).
  const nextTurnIndexRef = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // turnsRef mirrors the state array so turn updates can index into it
  // reliably (the array only ever grows within a session).
  const setTurnsSafe = useCallback((updater: (prev: AgentTurn[]) => AgentTurn[]) => {
    setTurns((prev) => {
      const next = updater(prev);
      turnsRef.current = next;
      return next;
    });
  }, []);

  const finalize = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || pending.finalizing) return;
    pending.finalizing = true;
    setTurnsSafe((prev) => {
      const next = [...prev];
      next[pending.turnIndex] = {
        utterance: pending.utterance,
        response: pending.reply.trim() || 'On it.',
        toolCalls: pending.toolCalls,
        status: 'SPEAKING',
      };
      return next;
    });
    pendingRef.current = null;
  }, [setTurnsSafe]);

  const beginTurn = useCallback(
    (utterance: string) => {
      // A previous turn that never completed (e.g. barge-in) is closed first.
      if (pendingRef.current) finalize();
      const turnIndex = nextTurnIndexRef.current;
      nextTurnIndexRef.current += 1;
      pendingRef.current = {
        turnIndex,
        utterance,
        reply: '',
        toolCalls: [],
        finalizing: false,
      };
      setTurnsSafe((prev) => [...prev, { utterance, response: '', toolCalls: [], status: 'THINKING' }]);
      setStatus('THINKING');
    },
    [finalize, setTurnsSafe],
  );

  const appendReply = useCallback(
    (text: string) => {
      const pending = pendingRef.current;
      if (!pending || pending.finalizing) return;
      pending.reply = pending.reply ? `${pending.reply} ${text}`.trim() : text;
      setTurnsSafe((prev) => {
        const next = [...prev];
        next[pending.turnIndex] = { ...next[pending.turnIndex], response: pending.reply.trim() };
        return next;
      });
      setStatus('SPEAKING');
    },
    [setTurnsSafe],
  );

  const executeToolCalls = useCallback(
    async (functionCalls: { id: string; name: string; args: Record<string, unknown> }[]) => {
      const pending = pendingRef.current;
      const token = optsRef.current.getToken ? await optsRef.current.getToken() : null;
      const responses: GeminiLiveFunctionResponse[] = [];
      const executed: ExecutedToolCall[] = [];

      for (const fc of functionCalls) {
        let result: ToolResult;
        try {
          const res = await fetch(toolsEndpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(await appCheckHeaders()),
            },
            body: JSON.stringify({ tool: fc.name, arguments: fc.args }),
          });
          result = (await res.json()) as ToolResult;
        } catch (e) {
          result = {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: e instanceof Error ? e.message : 'Tool execution failed',
              recoverable: true,
            },
          };
        }
        responses.push({ id: fc.id, name: fc.name, response: result as unknown as Record<string, unknown> });
        executed.push({ tool: fc.name, arguments: fc.args, result });
      }

      if (pending && !pending.finalizing) {
        pending.toolCalls = [...pending.toolCalls, ...executed];
        setTurnsSafe((prev) => {
          const next = [...prev];
          next[pending.turnIndex] = { ...next[pending.turnIndex], toolCalls: pending.toolCalls };
          return next;
        });
      }

      clientRef.current?.sendToolResponse(responses);
    },
    [toolsEndpoint, setTurnsSafe],
  );

  const stop = useCallback(() => {
    const client = clientRef.current;
    clientRef.current = null;
    client?.disconnect();
    pendingRef.current = null;
    setMode('off');
    setStatus('IDLE');
    setError(null);
  }, []);

  // Mark activity (a spoken turn, a reply, a tool call, a tap) — resets the
  // silence watchdog so the awaiting state only appears after REAL quiet.
  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setAwaiting(false);
  }, []);

  const toggle = useCallback(async () => {
    setError(null);
    if (mode !== 'off') {
      stop();
      return;
    }
    if (!available) {
      setError('Live voice is not supported in this browser — you can type instead.');
      setStatus('ERROR');
      return;
    }

    setMode('connecting');
    setStatus('LISTENING');
    setHearing(false);
    lastErrorRef.current = null;
    markActivity();

    const o = optsRef.current;
    const client = new GeminiLiveClient({
      tokenUrl: o.tokenUrl ?? DEFAULT_TOKEN_URL,
      getToken: o.getToken,
      getAppCheckHeaders: appCheckHeaders,
      systemInstruction: buildLiveSystemInstruction(o.systemContext ?? {}),
      tools: TOOL_DECLARATIONS,
      ...(o.connectTimeoutMs !== undefined ? { connectTimeoutMs: o.connectTimeoutMs } : {}),
    });
    clientRef.current = client;

    client.on('status', (s) => {
      if (s === 'CONNECTED') {
        setMode('live');
        setStatus('LISTENING');
        markActivity();
        void client.startListening();
      } else if (s === 'ERROR') {
        // The error event (fired just before this) owns the message — do not
        // clobber the specific reason with a generic one here.
        setMode('off');
        setStatus('ERROR');
        setHearing(false);
        setMicReplying(false);
      } else if (s === 'DISCONNECTED') {
        setMode((m) => (m === 'live' || m === 'connecting' ? 'off' : m));
        setStatus('IDLE');
        setHearing(false);
        setMicReplying(false);
      }
    });
    client.on('hearing', (h) => setHearing(h));
    client.on('playback', (p) => setMicReplying(p));
    client.on('transcript', (t) => {
      if (t.type === 'final' && t.text.trim()) {
        markActivity();
        beginTurn(t.text.trim());
      }
    });
    client.on('agentSpeech', (text) => {
      if (text.trim()) {
        markActivity();
        appendReply(text.trim());
      }
    });
    client.on('turn', (t) => {
      if (t.kind === 'end') {
        markActivity();
        finalize();
        setStatus('LISTENING');
      }
    });
    client.on('toolcall', ({ functionCalls }) => {
      markActivity();
      void executeToolCalls(functionCalls);
    });
    client.on('error', (e) => {
      const immediate = fallbackReason(e.message);
      setStatus('ERROR');
      setError(immediate);
      lastErrorRef.current = immediate;
      // Probe the two hops independently (token endpoint + Live WebSocket) so
      // the banner names the exact failing hop — a rejected request (bad
      // key), an unreachable endpoint, or a blocked socket.
      void runVoiceSelfCheck({
        tokenUrl: optsRef.current.tokenUrl ?? DEFAULT_TOKEN_URL,
        getToken: optsRef.current.getToken,
        getAppCheckHeaders: appCheckHeaders,
      }).then((check) => {
        const enriched = composeHopReason(immediate, check);
        // Structured verdict — logged even if the banner was dismissed, so a
        // console paste always names the failing hop.
        console.error(`[voice:self-check] verdict: ${enriched}`);
        if (lastErrorRef.current !== immediate) return; // dismissed or superseded
        lastErrorRef.current = enriched;
        setError(enriched);
      });
    });

    void client.connect();
  }, [available, mode, stop, beginTurn, appendReply, executeToolCalls, finalize, markActivity]);

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (mode !== 'live' || !clientRef.current) return;
      beginTurn(trimmed);
      clientRef.current.sendText(trimmed);
    },
    [mode, beginTurn],
  );

  // No dangling live session after navigation.
  useEffect(() => () => clientRef.current?.disconnect(), []);

  const clearError = useCallback(() => {
    lastErrorRef.current = null;
    setError(null);
  }, []);

  // Snapshot for the "copy voice details" affordance: hook state + client
  // session diagnostics + browser capabilities, so a dropped mic can be
  // diagnosed without the user opening the console.
  const getDiagnostics = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
      AudioContext?: unknown;
      webkitAudioContext?: unknown;
    };
    return {
      engine: 'gemini-live',
      mode,
      status,
      hearing,
      micReplying,
      awaiting,
      connectTimeoutMs: optsRef.current.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      error: error ?? null,
      client: clientRef.current?.getDiagnostics() ?? null,
      browser: {
        userAgent: navigator.userAgent,
        webSpeech: Boolean(w.SpeechRecognition || w.webkitSpeechRecognition),
        audioContext: Boolean(w.AudioContext || w.webkitAudioContext),
        webSocket: typeof WebSocket !== 'undefined',
      },
    };
  }, [mode, status, hearing, micReplying, awaiting, error]);

  // Watchdog: poll while the session is live; if the mic is listening and
  // nothing happened for silentThresholdMs, surface the awaiting state.
  useEffect(() => {
    if (mode !== 'live') {
      setAwaiting(false);
      return;
    }
    const threshold = optsRef.current.silentThresholdMs ?? DEFAULT_SILENT_THRESHOLD_MS;
    const id = setInterval(() => {
      if (status === 'LISTENING' && Date.now() - lastActivityRef.current >= threshold) {
        setAwaiting(true);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [mode, status]);

  return {
    available,
    mode,
    status,
    hearing,
    micReplying,
    error,
    turns,
    awaiting,
    toggle,
    stop,
    sendText,
    clearError,
    getDiagnostics,
  };
}
