'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useVoiceInput — real microphone capture with speech-to-text for /cook.
//
// Wraps the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition):
//   - Continuous: tap to start listening, speak as long as you want (the
//     recognition accumulates every utterance), tap again to stop and send the
//     full transcript to `onFinal`. No per-word tapping.
//   - The browser sometimes auto-stops continuous recognition after a silence;
//     this hook restarts it transparently so the user never notices.
//   - Tap while listening to cancel (barge-in) — the accumulated utterance is
//     discarded and the mic stops.
//   - Interim results stream live for the on-screen caption; errors map to
//     human messages (permission denied, no speech heard, network).
//   - `supported` is false when the browser has no SpeechRecognition (Firefox,
//     some mobile browsers, headless CI) — the caller renders a disabled mic
//     and the text input stays the fallback. Voice-first never means voice-only.
//
// Privacy: the Web Speech API sends audio to the browser vendor's speech
// service (Google for Chrome). The transcript that lands in the app is what
// the user said and is treated like any other utterance.
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
  /** Called with the full accumulated transcript when the user stops the mic. */
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
  // Accumulated final transcripts across utterances in a continuous session.
  const bufferRef = useRef<string[]>([]);

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
    rec.continuous = true;

    rec.onresult = (event) => {
      let raw = '';
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        raw += results[i][0].transcript;
      }
      const last = results[results.length - 1];
      if (last?.isFinal) {
        const finalText = raw.trim();
        setInterim('');
        if (finalText) bufferRef.current.push(finalText);
      } else {
        setInterim(raw);
      }
    };

    rec.onend = () => {
      // If the user explicitly stopped (recognitionRef cleared), do nothing.
      // Otherwise the browser timed out — restart transparently.
      if (recognitionRef.current === rec) {
        try {
          rec.start();
        } catch {
          // Can't restart — clean up.
          setListening(false);
          recognitionRef.current = null;
        }
      }
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
    // Already listening → stop gracefully, flush the accumulated buffer.
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
      const fullText = bufferRef.current.join(' ').trim();
      bufferRef.current = [];
      if (fullText) optionsRef.current.onFinal?.(fullText);
      return;
    }
    // Not listening → start fresh.
    const rec = createRecognition();
    if (!rec) return;
    recognitionRef.current = rec;
    bufferRef.current = [];
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
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setListening(false);
    setInterim('');
    const fullText = bufferRef.current.join(' ').trim();
    bufferRef.current = [];
    if (fullText) optionsRef.current.onFinal?.(fullText);
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
