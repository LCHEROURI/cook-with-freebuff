'use client';

import { useCallback, useEffect, useState } from 'react';

function hasSpeechSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis?.speak === 'function' &&
    typeof window.speechSynthesis?.cancel === 'function' &&
    typeof globalThis.SpeechSynthesisUtterance === 'function'
  );
}

export function useSpeech() {
  const [supported] = useState(hasSpeechSupport);
  const [speaking, setSpeaking] = useState(false);

  const stop = useCallback(() => {
    if (!hasSpeechSupport()) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!hasSpeechSupport()) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  useEffect(() => () => stop(), [stop]);
  return { speak, stop, speaking, supported };
}
