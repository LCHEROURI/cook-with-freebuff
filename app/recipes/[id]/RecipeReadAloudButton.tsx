'use client';

import { useSpeech } from '@/lib/hooks/useSpeech';

/**
 * Per-step read-aloud. The accessible name carries the phase because
 * prepSteps and cookingSteps are numbered independently, so "Read step 1"
 * would be ambiguous between the two lists.
 */
export function RecipeReadAloudButton({
  phase,
  stepNumber,
  text,
}: {
  phase: 'prep' | 'cooking';
  stepNumber: number;
  text: string;
}) {
  const { speak } = useSpeech();
  return (
    <button
      type="button"
      aria-label={`Read ${phase} step ${stepNumber}`}
      onClick={() => speak(text)}
    >
      Read this step
    </button>
  );
}

/**
 * Read-all in order with a Stop control. `useSpeech.speaking` flips the
 * control between speaking the joined texts and cancelling the current
 * utterance.
 */
export function RecipeReadAll({ texts }: { texts: string[] }) {
  const { speak, stop, speaking } = useSpeech();
  const label = speaking ? 'Stop reading' : 'Read all steps';
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => (speaking ? stop() : speak(texts.join(' ')))}
    >
      {label}
    </button>
  );
}
