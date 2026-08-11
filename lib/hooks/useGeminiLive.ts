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
  DEFAULT_TOKEN_URL,
  type GeminiLiveFunctionResponse,
} from '@/lib/voice/gemini-live';
import { TOOL_DECLARATIONS, buildLiveSystemInstruction } from '@/lib/ai/tool-declarations';
import type { AgentTurn, ExecutedToolCall } from '@/lib/agent/types';
import type { ToolResult } from '@/lib/server/tools/types';

export type LiveMode = 'off' | 'connecting' | 'live';
export type LiveStatus = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'OFFLINE' | 'ERROR';

export interface UseGeminiLiveOptions {
  getToken?: () => Promise<string | null> | string | null;
  tokenUrl?: string;
  toolsEndpoint?: string;
  /** Session context embedded in the Live system instruction (like the orchestrator's). */
  systemContext?: { currentPhase?: string; currentStep?: string; activeTimerIds?: string[] };
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

  const clientRef = useRef<GeminiLiveClient | null>(null);
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

    const o = optsRef.current;
    const client = new GeminiLiveClient({
      tokenUrl: o.tokenUrl ?? DEFAULT_TOKEN_URL,
      getToken: o.getToken,
      systemInstruction: buildLiveSystemInstruction(o.systemContext ?? {}),
      tools: TOOL_DECLARATIONS,
    });
    clientRef.current = client;

    client.on('status', (s) => {
      if (s === 'CONNECTED') {
        setMode('live');
        setStatus('LISTENING');
        void client.startListening();
      } else if (s === 'ERROR') {
        setMode('off');
        setStatus('ERROR');
        setError('The voice session could not start — try the typed chat instead.');
      } else if (s === 'DISCONNECTED') {
        setMode((m) => (m === 'live' || m === 'connecting' ? 'off' : m));
        setStatus('IDLE');
      }
    });
    client.on('transcript', (t) => {
      if (t.type === 'final' && t.text.trim()) beginTurn(t.text.trim());
    });
    client.on('agentSpeech', (text) => {
      if (text.trim()) appendReply(text.trim());
    });
    client.on('turn', (t) => {
      if (t.kind === 'end') {
        finalize();
        setStatus('LISTENING');
      }
    });
    client.on('toolcall', ({ functionCalls }) => {
      void executeToolCalls(functionCalls);
    });
    client.on('error', (e) => {
      setStatus('ERROR');
      setError(e.message);
    });

    void client.connect();
  }, [available, mode, stop, beginTurn, appendReply, executeToolCalls, finalize]);

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

  const clearError = useCallback(() => setError(null), []);

  return {
    available,
    mode,
    status,
    error,
    turns,
    toggle,
    stop,
    sendText,
    clearError,
  };
}
