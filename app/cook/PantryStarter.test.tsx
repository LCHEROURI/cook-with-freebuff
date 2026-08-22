// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import {
  PantryStarter,
  type PantryStarterSelection,
  type PantryStarterSnapshot,
} from './PantryStarter';

const snapshot: PantryStarterSnapshot = {
  items: [
    {
      id: 'spinach',
      name: 'spinach',
      quantity: 1,
      unit: 'bag',
      confidence: 1,
      stale: false,
      expiresSoon: true,
      daysUntilExpiration: 1,
      requiresConfirmation: false,
      selectedByDefault: true,
    },
    {
      id: 'rice',
      name: 'rice',
      quantity: 2,
      unit: 'cups',
      confidence: 0.6,
      stale: false,
      expiresSoon: false,
      daysUntilExpiration: null,
      requiresConfirmation: true,
      selectedByDefault: false,
    },
    {
      id: 'beans',
      name: 'beans',
      confidence: 1,
      stale: true,
      expiresSoon: false,
      daysUntilExpiration: null,
      requiresConfirmation: true,
      selectedByDefault: false,
    },
  ],
  profile: {
    allergies: ['peanuts'],
    dietaryRestrictions: ['gluten-free'],
    dislikedIngredients: ['cilantro'],
    preferredCuisines: ['Italian'],
    defaultServings: 3,
    preferredEquipment: ['air fryer'],
  },
};

function Harness() {
  const [submitted, setSubmitted] = useState<PantryStarterSelection | null>(null);
  return (
    <>
      <PantryStarter snapshot={snapshot} creating={false} onCreate={setSubmitted} />
      <output aria-label="submitted pantry request">
        {submitted ? JSON.stringify(submitted) : ''}
      </output>
    </>
  );
}

describe('PantryStarter', () => {
  it('selects trusted ingredients by default and requires a deliberate uncertain-item check', () => {
    render(<Harness />);

    expect(screen.getByRole('checkbox', { name: /spinach/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /confirm and use rice/i })).not.toBeChecked();
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.getByText('Confidence 60%')).toBeInTheDocument();
    expect(screen.getByText('Freshness check')).toBeInTheDocument();
    expect(screen.getAllByText('Confirm first')).toHaveLength(2);
  });

  it('submits selected IDs, explicit confirmations, and bounded refinements', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('checkbox', { name: /confirm and use rice/i }));
    fireEvent.change(screen.getByLabelText('Cuisine for this recipe'), { target: { value: 'Thai' } });
    fireEvent.change(screen.getByLabelText('Maximum cooking time in minutes'), { target: { value: '35' } });
    fireEvent.change(screen.getByLabelText('What are you craving?'), { target: { value: 'something comforting' } });
    fireEvent.change(screen.getByLabelText('Servings for this recipe'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create from my pantry' }));

    const submitted = JSON.parse(screen.getByLabelText('submitted pantry request').textContent ?? '{}');
    expect(submitted).toEqual({
      pantryItemIds: ['spinach', 'rice'],
      confirmedPantryItemIds: ['rice'],
      cuisine: 'Thai',
      maxTimeMinutes: 35,
      craving: 'something comforting',
      servings: 4,
    });
  });

  it('shows the applied safety and preference context', () => {
    render(<Harness />);

    expect(screen.getByText(/Allergies: peanuts/)).toBeInTheDocument();
    expect(screen.getByText(/Diet: gluten-free/)).toBeInTheDocument();
    expect(screen.getByText(/Avoid: cilantro/)).toBeInTheDocument();
    expect(screen.getByText(/Equipment: air fryer/)).toBeInTheDocument();
    expect(screen.getByText(/Default: 3 servings/)).toBeInTheDocument();
  });

  it('links an empty pantry to My Kitchen while preserving other starter paths', () => {
    render(
      <PantryStarter
        snapshot={{ ...snapshot, items: [] }}
        creating={false}
        onCreate={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'Add pantry items in My Kitchen' })).toHaveAttribute('href', '/kitchen');
    expect(screen.getByText(/You can still type, speak, or scan ingredients below/)).toBeInTheDocument();
  });
});
