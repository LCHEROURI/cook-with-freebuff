'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { composeWebSpeechReason, runWebSpeechSelfCheck } from '@/lib/voice/self-check';

// Retryable failures (network / audio-capture) are retried this many times
// before surfacing an honest error — a genuinely broken mic or a dead network
// must not restart forever under a fake "Listening…".
const MAX_WEB_SPEECH_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// useVoiceInput — real microphone capture with speech-to-text for /cook.
//
// Wraps the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition):
//   - Continuous: tap to start listening, speak as long as you want (the
//     recognition accumulates every utterance), tap again to stop and send the
//     full transcript to `onFinal`. No per-word tapping.
//   - Chrome's SpeechRecognition is fragile even with continuous: true — it
//     fires no-speech errors on silence, onend on timeouts, and network errors
//     on flaky connections. This hook treats all of those as retryable: it
//     restarts transparently so the mic stays open until the user explicitly
//     stops it. Only permission-denied and unrecoverable errors surface.
//   - Interim results stream live for the on-screen caption.
//   - `supported` is false when the browser has no SpeechRecognition (Firefox,
//     some mobile browsers, headless CI) — the caller renders a disabled mic
//     and the text input stays the fallback. Voice-first never means voice-only.
//
// Privacy: the Web Speech API sends audio to the browser vendor's speech
// service (Google for Chrome). The transcript that lands in the app is what
// the user said and is treated like any other utterance.
// ─────────────────────────────────────────────────────────────────────────────

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

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceInputOptions {
  lang?: string;
  onFinal?: (transcript: string) => void;
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
  const bufferRef = useRef<string[]>([]);
  // Tracks whether the user explicitly stopped — prevents the onend handler
  // from restarting after a deliberate stop() call.
  const stoppedByUserRef = useRef(false);
  // Consecutive retryable failures (network / audio-capture) — bounded so a
  // broken mic or dead network surfaces an honest hop-named reason instead of
  // restarting forever under a fake "Listening…".
  const consecutiveFailuresRef = useRef(0);

  const safeRestart = useCallback((rec: SpeechRecognitionLike) => {
    if (stoppedByUserRef.current) return;
    // Small delay to avoid tight restart loops on flaky browsers.
    setTimeout(() => {
      if (stoppedByUserRef.current || recognitionRef.current !== rec) return;
      try {
        rec.start();
      } catch {
        setListening(false);
        recognitionRef.current = null;
      }
    }, 100);
  }, []);

  // Drain the accumulated final utterances and deliver them once. Idempotent:
  // an empty buffer delivers nothing, so onresult and onend can both call it.
  const flushAndDeliver = useCallback(() => {
    const fullText = bufferRef.current.join(' ').trim();
    bufferRef.current = [];
    if (fullText) optionsRef.current.onFinal?.(fullText);
  }, []);

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
        // A real utterance — the retry-exhaustion counter resets.
        consecutiveFailuresRef.current = 0;
        const finalText = raw.trim();
        setInterim('');
        if (finalText) bufferRef.current.push(finalText);
        // A user stop drains on the FINAL result (browsers deliver it after
        // stop() returns), not on the stop call itself.
        if (stoppedByUserRef.current) flushAndDeliver();
      } else {
        setInterim(raw);
      }
    };

    rec.onend = () => {
      if (stoppedByUserRef.current) {
        // The user asked to stop: deliver whatever final text arrived (a stop
        // with no final result delivers nothing) — never restart.
        flushAndDeliver();
        return;
      }
      // Browser timed out or auto-stopped — restart transparently.
      if (recognitionRef.current === rec) {
        safeRestart(rec);
      }
    };

    rec.onerror = (event) => {
      if (event.error === 'aborted') return;
      const code = event.error;
      // Normal silence — not a failure, keep the mic open.
      if (code === 'no-speech') {
        if (!stoppedByUserRef.current && recognitionRef.current === rec) {
          safeRestart(rec);
        }
        return;
      }
      // Flaky-network / capture hiccups are retryable a few times, then must
      // surface honestly instead of restarting forever (the silent drop).
      if (code === 'network' || code === 'audio-capture') {
        consecutiveFailuresRef.current += 1;
        if (
          consecutiveFailuresRef.current < MAX_WEB_SPEECH_RETRIES &&
          !stoppedByUserRef.current &&
          recognitionRef.current === rec
        ) {
          safeRestart(rec);
          return;
        }
      } else {
        consecutiveFailuresRef.current = 0;
      }
      // Fatal: show an immediate reason, then the self-check names the exact
      // failing hop (API missing, mic permission, device, or speech service).
      const immediate =
        code === 'not-allowed'
          ? 'Microphone permission denied — enable it in your browser to speak.'
          : `Speech recognition failed (${code}).`;
      setListening(false);
      recognitionRef.current = null;
      setError(immediate);
      optionsRef.current.onError?.(immediate);
      void runWebSpeechSelfCheck().then((check) => {
        const reason = composeWebSpeechReason(code, check);
        // Structured verdict — logged even if the banner was dismissed.
        console.error(`[voice:self-check] verdict: ${reason}`);
        setError(reason);
      });
    };

    return rec;
  }, [safeRestart, flushAndDeliver]);

  const toggle = useCallback(() => {
    setError(null);
    if (recognitionRef.current) {
      // User explicitly stopping — the final result arrives async, so the
      // flush happens on the final onresult/onend, not here.
      stoppedByUserRef.current = true;
      recognitionRef.current.stop();
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
      return;
    }
    // Starting fresh.
    stoppedByUserRef.current = false;
    consecutiveFailuresRef.current = 0;
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
    stoppedByUserRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setListening(false);
    setInterim('');
    // The flush happens on the final onresult/onend (async), not here.
  }, []);

  useEffect(
    () => () => {
      stoppedByUserRef.current = true;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return { supported, listening, interim, error, toggle, stop, clearError: () => setError(null) };
}
