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
//   - AUDIO reply modality — the constrained Live endpoint REJECTS TEXT
//     modality (CLOSED(1007), proven live); the model's audio reply is
//     irrelevant because the session disconnects on the final transcript.
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
import { composeHopReason, runVoiceSelfCheck } from '@/lib/voice/self-check';
import { appCheckLimitedUseHeaders } from '@/lib/firebase/app-check';

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
  const [hearing, setHearing] = useState(false);
  // True while the model's audio reply plays: the mic is muted during that
  // window, so the caption must not invite more speech into a dead mic.
  const [micReplying, setMicReplying] = useState(false);

  const clientRef = useRef<GeminiLiveClient | null>(null);
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when WE close the session (barge-in, final transcript, unmount) — an
  // unexpected server close must surface as an error, not silence.
  const intentionalRef = useRef(false);
  // The error message currently on screen, so an async self-check can enrich
  // it without resurrecting a banner the user already dismissed.
  const lastErrorRef = useRef<string | null>(null);
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
    intentionalRef.current = true;
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

    // A fresh session starts with an EMPTY intentional flag — an unexpected
    // server close in THIS session must surface as an error.
    intentionalRef.current = false;
    const o = optionsRef.current;
    const client = new GeminiLiveClient({
      tokenUrl: o.tokenUrl ?? DEFAULT_TOKEN_URL,
      getToken: o.getToken,
      getAppCheckHeaders: appCheckLimitedUseHeaders,
      systemInstruction: DICTATION_SYSTEM_INSTRUCTION,
      // No tools: the model can never act on the spoken prompt — the user
      // reviews the transcribed text in the input before anything happens.
      tools: [],
      // The constrained native-audio Live endpoint rejects TEXT modality.
      // The audio reply is unused because the session closes on the final
      // input transcription.
      responseModalities: ['AUDIO'],
    });
    clientRef.current = client;

    client.on('status', (s) => {
      if (s === 'CONNECTED') {
        setStatus('LISTENING');
        void client.startListening();
      } else if (s === 'ERROR') {
        // The error event (fired just before this) owns the message — do not
        // clobber the specific reason with a generic one here.
        clearQuietTimer();
        clientRef.current = null;
        setStatus('ERROR');
        setHearing(false);
        setMicReplying(false);
      } else if (s === 'DISCONNECTED') {
        clearQuietTimer();
        setHearing(false);
        setMicReplying(false);
        if (clientRef.current === client) {
          clientRef.current = null;
          if (intentionalRef.current) {
            // We closed it (barge-in / final transcript / unmount) — clean idle.
            intentionalRef.current = false;
            setStatus('IDLE');
          } else {
            // The server dropped the session (e.g. a rejected setup) — never
            // swallow that: the user must know they can type instead.
            setStatus('ERROR');
            setError('The voice session could not start — you can type your ingredients instead.');
          }
        }
      }
    });
    client.on('hearing', (h) => setHearing(h));
    client.on('playback', (p) => setMicReplying(p));
    client.on('transcript', (t) => {
      // Only the FINAL input transcription is a real utterance — partials
      // stream in this API too, but the starter waits for the finished one.
      if (t.type !== 'final' || !t.text.trim()) return;
      setHearing(false);
      setMicReplying(false);
      clearQuietTimer();
      intentionalRef.current = true;
      clientRef.current = null;
      optionsRef.current.onFinal?.(t.text.trim());
      // A final can arrive AFTER the quiet-timeout flushed the stream (the
      // server emits it 1-2s after audioStreamEnd) — clear the timeout's
      // "did not hear anything" error: the user DID speak, the text landed.
      lastErrorRef.current = null;
      setError(null);
      // The dictation is one utterance per tap — close the session so the
      // model's (unneeded) audio reply never streams or lingers.
      client.disconnect();
      setStatus('IDLE');
    });
    client.on('error', (e) => {
      clearQuietTimer();
      const immediate = e.message.includes('Microphone')
        ? 'Microphone permission denied — enable it in your browser, or type your ingredients instead.'
        : `Gemini Live couldn't start: ${e.message} — you can type your ingredients instead.`;
      setStatus('ERROR');
      setError(immediate);
      lastErrorRef.current = immediate;
      // Probe the two hops independently (token endpoint + Live WebSocket) so
      // the error names the exact failing hop — same as the cooking mic.
      void runVoiceSelfCheck({
        tokenUrl: optionsRef.current.tokenUrl ?? DEFAULT_TOKEN_URL,
        getToken: optionsRef.current.getToken,
        getAppCheckHeaders: appCheckLimitedUseHeaders,
      }).then((check) => {
        const enriched = composeHopReason(immediate, check, 'you can type your ingredients instead.');
        // Structured verdict — logged even if the banner was dismissed.
        console.error(`[voice:self-check] verdict: ${enriched}`);
        if (lastErrorRef.current !== immediate) return; // dismissed or superseded
        lastErrorRef.current = enriched;
        setError(enriched);
      });
    });

    setStatus('LISTENING');
    setHearing(false);
    void client.connect();

    // Quiet timeout: nothing spoken → stop with an honest message.
    clearQuietTimer();
    quietTimerRef.current = setTimeout(() => {
      if (clientRef.current !== client) return;
      clientRef.current = null;
      client.disconnect();
      setStatus('ERROR');
      // A fresh error owns the screen — a late self-check probe from an
      // earlier failure must not overwrite it.
      lastErrorRef.current = null;
      setError('I did not hear anything — tap the mic and speak, or type your ingredients instead.');
    }, o.quietTimeoutMs ?? 15000);
  }, [available, stop, clearQuietTimer]);

  // No dangling session after navigation.
  useEffect(
    () => () => {
      clearQuietTimer();
      intentionalRef.current = true;
      clientRef.current?.disconnect();
      clientRef.current = null;
    },
    [clearQuietTimer],
  );

  const clearError = useCallback(() => {
    lastErrorRef.current = null;
    setError(null);
  }, []);

  return {
    available,
    status,
    listening: status === 'LISTENING',
    hearing,
    micReplying,
    error,
    toggle,
    stop,
    clearError,
  };
}
