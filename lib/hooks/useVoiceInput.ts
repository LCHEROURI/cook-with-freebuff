'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useVoiceInput — real microphone capture with speech-to-text for /cook.
//
// Wraps the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition):
//   - walkie-talkie style: tap to start listening, recognition auto-stops after
//     the utterance, the FINAL transcript is handed to `onFinal` — the caller
//     sends it through the EXISTING /api/agent flow (the backend is untouched).
//   - tap again while listening to cancel (barge-in) — `abort()` discards the
//     partial utterance.
//   - interim results stream live for the on-screen caption; errors map to
//     human messages (permission denied, no speech heard, network).
//   - `supported` is false when the browser has no SpeechRecognition (Firefox,
//     some mobile browsers, headless CI) — the caller renders a disabled mic
//     and the text input stays the fallback. Voice-first never means voice-only.
//
// Privacy: the Web Speech API sends audio to the browser vendor's speech
// service (Google for Chrome). The transcript that lands in the app is what
// the user said and is treated like any other utterance.
//
// The recognition instance is created fresh per toggle and aborted on unmount —
// no dangling listeners, no cross-navigation state.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal structural type for the API — keeps the hook mockable and TS-safe. */
export interface SpeechRecognitionResultItem {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionResultItem;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultLike[] }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The browser's SpeechRecognition constructor, or null when unsupported. */
export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceInputOptions {
  /** BCP-47 tag; defaults to navigator.language (falls back to en-US). */
  lang?: string;
  /** Called with the trimmed FINAL transcript — the caller sends it to the agent. */
  onFinal?: (transcript: string) => void;
  /** Called with a human-readable message on a real (non-cancelled) error. */
  onError?: (message: string) => void;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}) {
  const [supported] = useState<boolean>(() => getSpeechRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const createRecognition = useCallback((): SpeechRecognitionLike | null => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return null;
    const lang =
      optionsRef.current.lang ??
      (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US');
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Single utterance per tap — the recognition ends after a pause in speech.
    rec.continuous = false;

    rec.onresult = (event) => {
      let transcript = '';
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        transcript += results[i][0].transcript;
      }
      const last = results[results.length - 1];
      if (last?.isFinal) {
        const finalText = transcript.trim();
        setInterim('');
        if (finalText) optionsRef.current.onFinal?.(finalText);
      } else {
        setInterim(transcript);
      }
    };

    rec.onend = () => {
      // Recognition finished (final result delivered, or the user let it end).
      setListening(false);
      recognitionRef.current = null;
    };

    rec.onerror = (event) => {
      if (event.error === 'aborted') return; // user-cancelled — not an error
      setListening(false);
      recognitionRef.current = null;
      const message =
        event.error === 'not-allowed'
          ? 'Microphone permission denied — enable it in your browser to speak.'
          : event.error === 'no-speech'
            ? 'I did not hear anything — try again.'
            : event.error === 'network'
              ? 'Speech recognition is unavailable right now — you can type instead.'
              : `Speech recognition failed (${event.error}).`;
      setError(message);
      optionsRef.current.onError?.(message);
    };

    return rec;
  }, []);

  const toggle = useCallback(() => {
    setError(null);
    // Already listening → cancel (barge-in: discard the partial utterance).
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
      return;
    }
    const rec = createRecognition();
    if (!rec) return;
    recognitionRef.current = rec;
    setListening(true);
    setInterim('');
    try {
      rec.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError('Could not start the microphone.');
    }
  }, [createRecognition]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  // No dangling recognition after unmount / navigation.
  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return { supported, listening, interim, error, toggle, stop, clearError: () => setError(null) };
}
