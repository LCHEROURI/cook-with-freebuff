// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  StarterTour,
  STARTER_TOUR_KEY,
  dismissStarterTour,
  isStarterTourDismissed,
} from './StarterTour';

// ============================================================================
// components/StarterTour.test.tsx — the first-visit guide on the /cook
// starter. It must (a) show only on the first visit (localStorage flag), (b)
// walk through the three steps pointing at the input, mic, and create button,
// (c) dismiss forever on Skip / Finish / close / Escape, and (d) be
// dismissible by the page when the user engages with the flow.
// ============================================================================

function setup(onDismiss = vi.fn()) {
  const utils = render(<StarterTour onDismiss={onDismiss} />);
  return { onDismiss, ...utils };
}

beforeEach(() => {
  localStorage.clear();
});

describe('StarterTour · first-visit gating', () => {
  it('renders the first step on a fresh visit', () => {
    setup();
    expect(screen.getByText('Tell me what you have')).toBeInTheDocument();
    expect(screen.getByLabelText(/step 1 of 3/)).toBeInTheDocument();
    expect(screen.getByText('Next →')).toBeInTheDocument();
  });

  it('does not render after the tour has been dismissed (repeat visits)', () => {
    dismissStarterTour();
    const { container } = setup();
    expect(isStarterTourDismissed()).toBe(true);
    expect(container.firstChild).toBeNull();
  });
});

describe('StarterTour · step navigation', () => {
  it('walks through all three steps in order', () => {
    setup();
    expect(screen.getByText('Tell me what you have')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText('…or just say it')).toBeInTheDocument();
    expect(screen.getByText(/microphone button/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText('Create your recipe')).toBeInTheDocument();
    expect(screen.getByText(/create recipe button/)).toBeInTheDocument();
    // Last step swaps Next → Let's cook.
    expect(screen.getByText('Let’s cook')).toBeInTheDocument();
    expect(screen.queryByText('Next →')).not.toBeInTheDocument();
  });

  it('goes back a step and remembers the target', () => {
    setup();
    fireEvent.click(screen.getByLabelText('Next step'));
    fireEvent.click(screen.getByLabelText('Previous step'));
    expect(screen.getByText('Tell me what you have')).toBeInTheDocument();
    expect(screen.getByText(/ingredient input/)).toBeInTheDocument();
  });
});

describe('StarterTour · dismissal', () => {
  it('finishing on the last step persists the flag and calls onDismiss', () => {
    const { onDismiss } = setup();
    fireEvent.click(screen.getByLabelText('Next step'));
    fireEvent.click(screen.getByLabelText('Next step'));
    fireEvent.click(screen.getByText('Let’s cook'));
    expect(localStorage.getItem(STARTER_TOUR_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('skip persists the flag and calls onDismiss', () => {
    const { onDismiss } = setup();
    fireEvent.click(screen.getByText('Skip tour'));
    expect(localStorage.getItem(STARTER_TOUR_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the close button persists and dismisses', () => {
    const { onDismiss } = setup();
    fireEvent.click(screen.getByLabelText('Close the tour'));
    expect(localStorage.getItem(STARTER_TOUR_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape dismisses the tour', () => {
    const { onDismiss } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(localStorage.getItem(STARTER_TOUR_KEY)).toBe('1');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
