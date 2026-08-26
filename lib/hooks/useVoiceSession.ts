'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { nextVoiceStatus } from '@/lib/agent/voice-status';
import type { AgentTurn, VoiceStatus } from '@/lib/agent/types';
import { appCheckHeaders } from '@/lib/firebase/app-check';

export interface UseVoiceSessionOptions {
  endpoint?: string;
  getToken?: () => Promise<string | null> | string | null;
}

/**
 * Manages the persistent voice-status indicator and the turn transcript.
 * Sends utterances to /api/agent; never claims success without a response.
 */
export function useVoiceSession(opts: UseVoiceSessionOptions = {}) {
  const endpoint = opts.endpoint ?? '/api/agent';
  const [status, setStatus] = useState<VoiceStatus>('OFFLINE');
  const [transcript, setTranscript] = useState<AgentTurn[]>([]);
  const statusRef = useRef<VoiceStatus>('OFFLINE');

  const set = useCallback((next: VoiceStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const transition = useCallback((event: Parameters<typeof nextVoiceStatus>[1]) => {
    set(nextVoiceStatus(statusRef.current, event));
  }, [set]);

  // A new cooking session must start with a blank conversation — the previous
  // session's last agent reply (e.g. "Done — next: Enjoy your meal!") must
  // not linger over the first step of the new one.
  const clearTranscript = useCallback(() => setTranscript([]), []);

  // Honest offline state until the endpoint responds.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const headers = { 'content-type': 'application/json', ...(await appCheckHeaders()) };
      fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ utterance: '__ping__' }) })
        .then(() => !cancelled && set('LISTENING'))
        .catch(() => !cancelled && set('OFFLINE'));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const send = useCallback(
    async (utterance: string) => {
      const text = utterance.trim();
      if (!text) return;

      transition('USER_SPEAKING');
      transition('UTTERANCE_SENT');

      try {
        const token = opts.getToken ? await opts.getToken() : null;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(await appCheckHeaders()),
          },
          body: JSON.stringify({ utterance: text }),
        });
        if (!res.ok) throw new Error(`Agent request failed: ${res.status}`);
        const turn = (await res.json()) as AgentTurn;
        setTranscript((prev) => [...prev, turn]);
        transition('AGENT_RESPONSE');
        // SPEAKING → LISTENING once speech ends (simulated after the turn).
        window.setTimeout(() => transition('AGENT_FINISHED'), 600);
      } catch (e) {
        transition('ERROR');
        setTranscript((prev) => [
          ...prev,
          {
            utterance: text,
            response: `Sorry, I could not reach the agent: ${e instanceof Error ? e.message : 'unknown error'}`,
            toolCalls: [],
            status: 'ERROR',
          },
        ]);
        // Allow recovery.
        window.setTimeout(() => set('LISTENING'), 1200);
      }
    },
    [endpoint, opts, set, transition],
  );

  return { status, transcript, send, setStatus: set, clearTranscript };
}