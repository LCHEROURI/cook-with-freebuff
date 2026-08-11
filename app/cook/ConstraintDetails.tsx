'use client';

import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import styles from './constraint-details.module.css';

export interface ConstraintDetailsProps {
  /** The parsed build constraints (from the starter prompt) to surface. */
  preferences: {
    servings: number | null;
    allergies: string[];
    dietaryRestrictions: string[];
  };
}

/**
 * Expandable "Generation constraints applied" view on the ready card.
 *
 * Transparency before Start cooking: what generation constraints were
 * applied (servings, diet, allergens avoided). Rendered only when the prompt
 * actually carried constraints — a plain "chicken, rice" card stays minimal.
 * Closed by default; the rows spell out each constraint instead of trusting
 * the one-line summary.
 */
export default function ConstraintDetails({ preferences }: ConstraintDetailsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const hasConstraints =
    preferences.servings != null ||
    preferences.dietaryRestrictions.length > 0 ||
    preferences.allergies.length > 0;
  if (!hasConstraints) return null;

  // Keyboard accessibility. Native <summary> keyboard activation is a
  // browser-internal behavior (jsdom cannot simulate it, so it is untestable
  // as-is). Handle Enter/Space explicitly with the standard disclosure
  // pattern: preventDefault (which suppresses the native activation so there
  // is EXACTLY one toggle per keypress) and flip `open` ourselves. Click
  // activation stays native.
  const onSummaryKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const details = detailsRef.current;
    if (details) details.open = !details.open;
  };

  return (
    <details ref={detailsRef} className={styles.constraintDetails} data-testid="constraint-details">
      <summary className={styles.constraintSummary} onKeyDown={onSummaryKeyDown}>Generation constraints applied</summary>
      <ul className={styles.constraintList}>
        {preferences.servings != null && (
          <li>
            Servings: <strong>{preferences.servings}</strong>
          </li>
        )}
        {preferences.dietaryRestrictions.length > 0 && (
          <li>Diet: {preferences.dietaryRestrictions.join(', ')}</li>
        )}
        {preferences.allergies.length > 0 && (
          <li>Allergens avoided: no {preferences.allergies.join(', no ')}</li>
        )}
      </ul>
    </details>
  );
}
