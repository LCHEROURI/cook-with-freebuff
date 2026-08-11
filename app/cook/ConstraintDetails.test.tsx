// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import ConstraintDetails from './ConstraintDetails';

// ============================================================================
// app/cook/ConstraintDetails.test.tsx — rendered behavior lock for the
// expandable "Generation constraints applied" view on the ready card.
//
// The string-level wiring test used to be the only guard; this test renders
// the REAL component in jsdom and locks the actual expand/collapse behavior:
//  1. no constraints → nothing renders (a plain "chicken, rice" card stays
//     minimal),
//  2. collapsed by default → the rows are NOT exposed until the summary is
//     clicked,
//  3. clicking the summary expands the <details> and the three rows surface,
//  4. the rows map each constraint exactly (servings / diet / allergens
//     avoided).
// ============================================================================

const PREFS = {
  servings: 4,
  allergies: ['peanuts'],
  dietaryRestrictions: ['vegetarian'],
};

describe('ConstraintDetails — expandable generation-constraints view', () => {
  it('renders nothing when the prompt carried no constraints', () => {
    const { container } = render(
      <ConstraintDetails preferences={{ servings: null, allergies: [], dietaryRestrictions: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is collapsed by default — no open attribute until the summary is clicked', () => {
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('Generation constraints applied')).toBeInTheDocument();
  });

  it('expands on summary click and exposes the three constraint rows', () => {
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    fireEvent.click(screen.getByText('Generation constraints applied'));
    expect(details).toHaveAttribute('open');
    // The servings row nests a <strong> (the number), which splits the text
    // node — match the <li>'s full textContent instead of a plain string.
    const liWithText = (expected: string) => (content: string, el?: Element | null) =>
      !!el && el.tagName === 'LI' && el.textContent === expected;
    expect(screen.getByText(liWithText('Servings: 4'))).toBeInTheDocument();
    expect(screen.getByText('Diet: vegetarian')).toBeInTheDocument();
    expect(screen.getByText('Allergens avoided: no peanuts')).toBeInTheDocument();
  });

  it('collapses again when the summary is clicked a second time', () => {
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    const summary = screen.getByText('Generation constraints applied');
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute('open');
  });

  it('toggles with the Enter key — keyboard accessibility, locked via keyDown', () => {
    // jsdom cannot simulate native <summary> keyboard activation, so the
    // component handles Enter/Space itself (preventDefault + flip open). This
    // test locks that explicit handling: one Enter keydown opens, a second
    // closes — the same contract a sighted user gets from the browser.
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    const summary = screen.getByText('Generation constraints applied');
    fireEvent.keyDown(summary, { key: 'Enter', code: 'Enter' });
    expect(details).toHaveAttribute('open');
    fireEvent.keyDown(summary, { key: 'Enter', code: 'Enter' });
    expect(details).not.toHaveAttribute('open');
  });

  it('toggles with the Space key — keyboard accessibility, locked via keyDown', () => {
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    const summary = screen.getByText('Generation constraints applied');
    fireEvent.keyDown(summary, { key: ' ', code: 'Space' });
    expect(details).toHaveAttribute('open');
    fireEvent.keyDown(summary, { key: ' ', code: 'Space' });
    expect(details).not.toHaveAttribute('open');
  });

  it('single keypress = exactly one toggle (preventDefault suppresses the native activation)', () => {
    // Without preventDefault, browsers would ALSO run their native summary
    // activation on top of the handler — double-toggle. The handler calls
    // preventDefault for Enter/Space; a single keydown must land in exactly
    // the open state, never flipped twice (which would end closed again).
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    fireEvent.keyDown(screen.getByText('Generation constraints applied'), { key: 'Enter', code: 'Enter' });
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('Diet: vegetarian')).toBeInTheDocument();
  });

  it('ignores non-activation keys (Tab, letters) — the details stays put', () => {
    render(<ConstraintDetails preferences={PREFS} />);
    const details = screen.getByTestId('constraint-details');
    const summary = screen.getByText('Generation constraints applied');
    fireEvent.keyDown(summary, { key: 'Tab', code: 'Tab' });
    fireEvent.keyDown(summary, { key: 'a', code: 'KeyA' });
    expect(details).not.toHaveAttribute('open');
  });

  it('maps only the constraints that were present', () => {
    render(
      <ConstraintDetails
        preferences={{ servings: null, allergies: ['peanuts'], dietaryRestrictions: [] }}
      />,
    );
    fireEvent.click(screen.getByText('Generation constraints applied'));
    expect(screen.queryByText(/Servings:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Diet:/)).not.toBeInTheDocument();
    expect(screen.getByText('Allergens avoided: no peanuts')).toBeInTheDocument();
  });

  it('joins multiple allergens with "no" like the summary copy ("no X, no Y")', () => {
    render(
      <ConstraintDetails
        preferences={{ servings: 2, allergies: ['peanuts', 'shellfish'], dietaryRestrictions: ['vegan'] }}
      />,
    );
    fireEvent.click(screen.getByText('Generation constraints applied'));
    expect(screen.getByText('Allergens avoided: no peanuts, no shellfish')).toBeInTheDocument();
    expect(screen.getByText('Diet: vegan')).toBeInTheDocument();
  });
});
