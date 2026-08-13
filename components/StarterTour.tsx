'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from '@/app/cook/page.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// StarterTour — first-visit guide for the /cook recipe starter.
//
// New users land on the starter (the empty state) with an input, a mic, a
// camera button and a create button and no idea what the flow is. The tour
// shows three short steps pointing at the real controls: (1) type your
// ingredients, (2) speak them instead with the mic, (3) create the validated
// recipe. Dismissal is remembered in localStorage so it shows once, not on
// every visit. The tour is also dismissed by the page when the user actually
// engages with the flow (types, taps the mic, or submits) — seeing someone
// use it is proof they don't need it.
// ─────────────────────────────────────────────────────────────────────────────

export const STARTER_TOUR_KEY = 'cook-starter-tour-dismissed';

export function isStarterTourDismissed(): boolean {
  try {
    return localStorage.getItem(STARTER_TOUR_KEY) === '1';
  } catch {
    return false; // no storage (private mode) — the tour just shows again
  }
}

export function dismissStarterTour(): void {
  try {
    localStorage.setItem(STARTER_TOUR_KEY, '1');
  } catch {
    // no storage — nothing to remember, the tour shows on the next visit
  }
}

interface TourStep {
  /** The control this step points at, for the aria-label. */
  target: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    target: 'ingredient input',
    title: 'Tell me what you have',
    body: 'Type your ingredients in the box — e.g. “chicken, rice and onion”. Add servings and anything to avoid, like “for 4, no peanuts, vegetarian”.',
  },
  {
    target: 'microphone button',
    title: '…or just say it',
    body: 'Tap the mic once and speak your ingredients. They land in the box for review — nothing is created until you check it and press the button.',
  },
  {
    target: 'create recipe button',
    title: 'Create your recipe',
    body: 'Press “✨ Create my recipe” to generate and validate the recipe — then we start cooking, step by step.',
  },
];

export function StarterTour({ onDismiss }: { onDismiss: () => void }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  const finish = useCallback(() => {
    dismissStarterTour();
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    // Show only on the first visit — check the flag after mount so SSR and
    // client agree (the tour never flashes on repeat visits).
    setVisible(!isStarterTourDismissed());
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, finish]);

  if (!visible) return null;

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <div className={styles.tourCard} role="region" aria-label={`First-time tour, step ${step + 1} of ${STEPS.length}`}>
      <div className={styles.tourHeader}>
        <span className={styles.tourEyebrow}>First time here? Let’s get you cooking.</span>
        <button
          type="button"
          className={styles.tourClose}
          onClick={finish}
          aria-label="Close the tour"
        >
          ✕
        </button>
      </div>

      <div className={styles.tourDots} aria-hidden="true">
        {STEPS.map((_, i) => (
          <span key={i} className={`${styles.tourDot} ${i === step ? styles.tourDotActive : ''}`} />
        ))}
      </div>

      <p className={styles.tourTitle}>{current.title}</p>
      <p className={styles.tourBody}>{current.body}</p>
      <p className={styles.tourTarget}>Look for: {current.target}</p>

      <div className={styles.tourActions}>
        {step > 0 && (
          <button type="button" className={styles.tourBack} onClick={() => setStep((s) => s - 1)} aria-label="Previous step">
            ← Back
          </button>
        )}
        {isLast ? (
          <button type="button" className={styles.tourNext} onClick={finish}>
            Let’s cook
          </button>
        ) : (
          <button type="button" className={styles.tourNext} onClick={() => setStep((s) => s + 1)} aria-label="Next step">
            Next →
          </button>
        )}
      </div>

      <button type="button" className={styles.tourSkip} onClick={finish}>
        Skip tour
      </button>
    </div>
  );
}
