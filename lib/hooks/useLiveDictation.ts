'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useLiveDictation — speak ingredient brain-dumps into the /cook starter.
//
// Same first-party voice engine as the active-screen mic (useGeminiLive), but
// in DICTATION mode: the Live session exists ONLY to turn the user's spoken
// prompt ("I have chicken, rice and onion — for 4, no peanuts, vegetarian")
// into text that lands in the starter input. Key differences:
//   - NO tools are passed in setup — the model cannot act on the utterance
//     (no pantry writes, no session creation) before the user reviews it.
//   - TEXT reply modality — no audio reply is needed, so none is generated.
//   - Walkie-talkie + auto-stop: tap → speak → the FINAL input transcription
//     is handed to `onFinal`, the session disconnects, and the caller fills
//     the prompt for review. Tap again mid-listen to cancel (barge-in).
//   - A quiet timeout (default 15s) ends a session where nothing was said,
//     with an honest "did not hear anything" message — the typed path stays
//     the fallback (voice-first never means voice-only).
//
// Privacy is first-party: audio streams straight to Gemini via the ephemeral
// token from /api/voice/token (the API key never leaves the server); only the
// final transcript ever touches app state.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { GeminiLiveClient, DEFAULT_TOKEN_URL } from '@/lib/voice/gemini-live';

export type LiveDictationStatus = 'IDLE' | 'LISTENING' | 'THINKING' | 'ERROR';

export const DICTATION_SYSTEM_INSTRUCTION = [
  'You are a dictation assistant inside a cooking app.',
  'The user will speak a short cooking prompt: ingredients they have, servings, allergies, dietary needs.',
  'Transcribe exactly what they say. Do not call tools and do not elaborate.',
  'Reply with a single word: “ok”.',
].join('\n');

export interface UseLiveDictationOptions {
  getToken?: () => Promise<string | null> | string | null;
  tokenUrl?: string;
  /** Called with the trimmed FINAL transcription of the spoken utterance. */
  onFinal?: (text: string) => void;
  /** Give up on silence after this long (ms). Default 15000. */
  quietTimeoutMs?: number;
}

export function useLiveDictation(options: UseLiveDictationOptions = {}) {
  // Browser capability check — computed once, SSR-safe (same as useGeminiLive).
  const [available] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (typeof WebSocket === 'undefined' || typeof fetch !== 'function') return false;
    const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
    return Boolean(w.AudioContext || w.webkitAudioContext);
  });

  const [status, setStatus] = useState<LiveDictationStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<GeminiLiveClient | null>(null);
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearQuietTimer = useCallback(() => {
    if (quietTimerRef.current) {
      clearTimeout(quietTimerRef.current);
      quietTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearQuietTimer();
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus('IDLE');
    setError(null);
  }, [clearQuietTimer]);

  const toggle = useCallback(() => {
    setError(null);
    if (clientRef.current) {
      // Barge-in: tap again mid-listen to cancel (discard the partial).
      stop();
      return;
    }
    if (!available) {
      setStatus('ERROR');
      setError('Live voice is not supported in this browser — you can type your ingredients instead.');
      return;
    }

    const o = optionsRef.current;
    const client = new GeminiLiveClient({
      tokenUrl: o.tokenUrl ?? DEFAULT_TOKEN_URL,
      getToken: o.getToken,
      systemInstruction: DICTATION_SYSTEM_INSTRUCTION,
      // No tools: the model can never act on the spoken prompt — the user
      // reviews the transcribed text in the input before anything happens.
      tools: [],
      responseModalities: ['TEXT'],
    });
    clientRef.current = client;

    client.on('status', (s) => {
      if (s === 'CONNECTED') {
        setStatus('LISTENING');
        void client.startListening();
      } else if (s === 'ERROR') {
        clearQuietTimer();
        clientRef.current = null;
        setStatus('ERROR');
        setError('The voice session could not start — you can type your ingredients instead.');
      } else if (s === 'DISCONNECTED') {
        clearQuietTimer();
        if (clientRef.current === client) {
          clientRef.current = null;
          setStatus('IDLE');
        }
      }
    });
    client.on('transcript', (t) => {
      // Only the FINAL input transcription is a real utterance — partials
      // stream in this API too, but the starter waits for the finished one.
      if (t.type !== 'final' || !t.text.trim()) return;
      clearQuietTimer();
      clientRef.current = null;
      optionsRef.current.onFinal?.(t.text.trim());
      // The dictation is one utterance per tap — close the session so the
      // model's (unneeded) reply never streams or lingers.
      client.disconnect();
      setStatus('IDLE');
    });
    client.on('error', (e) => {
      clearQuietTimer();
      const message = e.message.includes('Microphone')
        ? 'Microphone permission denied — enable it in your browser, or type your ingredients instead.'
        : 'The voice session could not start — you can type your ingredients instead.';
      setStatus('ERROR');
      setError(message);
    });

    setStatus('LISTENING');
    void client.connect();

    // Quiet timeout: nothing spoken → stop with an honest message.
    clearQuietTimer();
    quietTimerRef.current = setTimeout(() => {
      if (clientRef.current !== client) return;
      clientRef.current = null;
      client.disconnect();
      setStatus('ERROR');
      setError('I did not hear anything — tap the mic and speak, or type your ingredients instead.');
    }, o.quietTimeoutMs ?? 15000);
  }, [available, stop, clearQuietTimer]);

  // No dangling session after navigation.
  useEffect(
    () => () => {
      clearQuietTimer();
      clientRef.current?.disconnect();
      clientRef.current = null;
    },
    [clearQuietTimer],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    available,
    status,
    listening: status === 'LISTENING',
    error,
    toggle,
    stop,
    clearError,
  };
}
