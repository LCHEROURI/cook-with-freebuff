import { describe, expect, it } from 'vitest';
import type { PantryItemView } from './pantry-service';
import { mergeSafetyAllergies, preparePantryCandidates } from './kitchen-context';

function item(overrides: Partial<PantryItemView> = {}): PantryItemView {
  return {
    id: 'pantry-eggs',
    userId: 'user-1',
    name: 'eggs',
    quantity: 6,
    unit: 'count',
    confidence: 1,
    source: 'MANUAL',
    lastConfirmedAt: Date.now(),
    stale: false,
    expiresSoon: false,
    expired: false,
    daysUntilExpiration: null,
    ...overrides,
  };
}

describe('preparePantryCandidates', () => {
  it('excludes expired pantry items even when they have high confidence', () => {
    const candidates = preparePantryCandidates([
      item({ id: 'expired', name: 'yogurt', expired: true, confidence: 1 }),
      item({ id: 'fresh', name: 'eggs' }),
    ]);

    expect(candidates.map((candidate) => candidate.id)).toEqual(['fresh']);
  });

  it('requires explicit confirmation for stale or low-confidence items', () => {
    const candidates = preparePantryCandidates([
      item({ id: 'stale', name: 'garlic', stale: true, confidence: 1 }),
      item({ id: 'uncertain', name: 'spinach', confidence: 0.79 }),
      item({ id: 'trusted', name: 'rice', confidence: 0.8 }),
    ]);

    expect(candidates.map(({ id, requiresConfirmation, selectedByDefault }) => ({
      id,
      requiresConfirmation,
      selectedByDefault,
    }))).toEqual([
      { id: 'trusted', requiresConfirmation: false, selectedByDefault: true },
      { id: 'stale', requiresConfirmation: true, selectedByDefault: false },
      { id: 'uncertain', requiresConfirmation: true, selectedByDefault: false },
    ]);
  });

  it('prioritizes expiring-soon ingredients within each trust group', () => {
    const candidates = preparePantryCandidates([
      item({ id: 'trusted-later', name: 'rice' }),
      item({ id: 'confirm-later', name: 'lentils', confidence: 0.5 }),
      item({ id: 'confirm-soon', name: 'milk', confidence: 0.5, expiresSoon: true }),
      item({ id: 'trusted-soon', name: 'spinach', expiresSoon: true }),
    ]);

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'trusted-soon',
      'trusted-later',
      'confirm-soon',
      'confirm-later',
    ]);
  });
});

describe('mergeSafetyAllergies', () => {
  it('retains stored allergies and adds explicit constraints without duplicates', () => {
    expect(
      mergeSafetyAllergies(['Peanuts', ' shellfish '], ['peanuts', 'Sesame']),
    ).toEqual(['Peanuts', 'shellfish', 'Sesame']);
  });
});
