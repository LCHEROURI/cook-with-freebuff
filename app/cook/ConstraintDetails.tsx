'use client';

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
  const hasConstraints =
    preferences.servings != null ||
    preferences.dietaryRestrictions.length > 0 ||
    preferences.allergies.length > 0;
  if (!hasConstraints) return null;
  return (
    <details className={styles.constraintDetails} data-testid="constraint-details">
      <summary className={styles.constraintSummary}>Generation constraints applied</summary>
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
