// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import RecipeRowMeta from './RecipeRowMeta';

// ============================================================================
// app/cook/RecipeRowMeta.test.tsx — rendered behavior lock for the meta line
// under each "Your recipes" row title: servings · time · ingredient count,
// plus the build constraints the recipe was created for.
//
// The string-level wiring test used to be the only guard; this test renders
// the REAL component and locks the copy construction:
//  1. single-serving recipes omit the servings prefix,
//  2. the diet and allergy lines only render when present,
//  3. multiple allergens join as "no X, no Y" (matching the ready-card copy),
//  4. a recipe with no preferences (pre-feature / stale API) renders the
//     plain meta line, never an `undefined` fragment.
// ============================================================================

describe('RecipeRowMeta — "Your recipes" row meta line', () => {
  it('renders servings · time · ingredients for a multi-serving recipe', () => {
    render(<RecipeRowMeta servings={2} totalMinutes={35} ingredientCount={2} />);
    expect(screen.getByText('2 servings · 35 min · 2 ingredients')).toBeInTheDocument();
  });

  it('omits the servings prefix for a single-serving recipe', () => {
    render(<RecipeRowMeta servings={1} totalMinutes={20} ingredientCount={1} />);
    expect(screen.getByText('20 min · 1 ingredients')).toBeInTheDocument();
    expect(screen.queryByText(/1 servings/)).not.toBeInTheDocument();
  });

  it('appends the diet and allergy lines when the recipe was built for them', () => {
    render(
      <RecipeRowMeta
        servings={4}
        totalMinutes={30}
        ingredientCount={2}
        preferences={{ servings: 4, allergies: ['peanuts'], dietaryRestrictions: ['vegetarian'] }}
      />,
    );
    expect(screen.getByText('4 servings · 30 min · 2 ingredients · vegetarian · no peanuts')).toBeInTheDocument();
  });

  it('omits the diet line when empty and the allergy line when empty (independently)', () => {
    render(
      <RecipeRowMeta
        servings={2}
        totalMinutes={25}
        ingredientCount={3}
        preferences={{ servings: 2, allergies: [], dietaryRestrictions: ['vegan'] }}
      />,
    );
    expect(screen.getByText('2 servings · 25 min · 3 ingredients · vegan')).toBeInTheDocument();
    expect(screen.queryByText(/no /)).not.toBeInTheDocument();
  });

  it('joins multiple allergens with "no" like the ready-card copy ("no X, no Y")', () => {
    render(
      <RecipeRowMeta
        servings={2}
        totalMinutes={40}
        ingredientCount={4}
        preferences={{ servings: 2, allergies: ['peanuts', 'shellfish'], dietaryRestrictions: [] }}
      />,
    );
    expect(screen.getByText('2 servings · 40 min · 4 ingredients · no peanuts, no shellfish')).toBeInTheDocument();
  });

  it('renders the plain meta line when preferences are absent (pre-feature recipes / stale API)', () => {
    render(<RecipeRowMeta servings={2} totalMinutes={15} ingredientCount={1} preferences={undefined} />);
    expect(screen.getByText('2 servings · 15 min · 1 ingredients')).toBeInTheDocument();
  });
});
