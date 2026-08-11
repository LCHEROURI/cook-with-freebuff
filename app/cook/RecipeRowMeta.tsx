'use client';

import styles from './recipe-row-meta.module.css';

export interface RecipeRowMetaProps {
  servings: number;
  totalMinutes: number;
  ingredientCount: number;
  /** What the recipe was built for — optional so pre-feature recipes (or a
      stale API) render the plain meta line, never `undefined` in the copy. */
  preferences?: {
    servings: number | null;
    allergies: string[];
    dietaryRestrictions: string[];
  };
}

/**
 * The meta line under a "Your recipes" row title: servings · time ·
 * ingredient count, plus the build constraints the recipe was created for
 * ("· vegetarian · no peanuts") — same copy style as the ready card. The
 * servings prefix is hidden for single-serving recipes, and the diet /
 * allergy lines only render when present.
 */
export default function RecipeRowMeta({ servings, totalMinutes, ingredientCount, preferences }: RecipeRowMetaProps) {
  return (
    <p className={styles.recipeMeta}>
      {servings > 1 ? `${servings} servings · ` : ''}
      {totalMinutes} min · {ingredientCount} ingredients
      {preferences?.dietaryRestrictions?.length
        ? ` · ${preferences.dietaryRestrictions.join(', ')}`
        : ''}
      {preferences?.allergies?.length
        ? ` · no ${preferences.allergies.join(', no ')}`
        : ''}
    </p>
  );
}
