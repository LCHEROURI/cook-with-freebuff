import { describe, it, expect } from 'vitest';
import {
  recognitionToPantryDecision,
  RECOGNITION_CONFIRM_THRESHOLD,
  type RecognitionResult,
  type VisualIngredientProvider,
  type BarcodeProvider,
} from './types';

function makeResult(confidence: number, overrides: Partial<RecognitionResult> = {}): RecognitionResult {
  return {
    name: 'tomato',
    confidence,
    source: 'VISION',
    provider: 'test-provider',
    ...overrides,
  };
}

describe('recognitionToPantryDecision (K9 camera-readiness contract)', () => {
  it('trusts high-confidence results directly', () => {
    const decision = recognitionToPantryDecision(makeResult(0.97));
    expect(decision.trusted).toBe(true);
    if (decision.trusted) {
      expect(decision.item.name).toBe('tomato');
    }
  });

  it('gates anything below the threshold for user confirmation', () => {
    const decision = recognitionToPantryDecision(makeResult(0.85));
    expect(decision.trusted).toBe(false);
    if (!decision.trusted) {
      expect(decision.reason).toBe('LOW_CONFIDENCE');
      expect(decision.pending.name).toBe('tomato');
    }
  });

  it('treats exactly the threshold as trusted', () => {
    const decision = recognitionToPantryDecision(makeResult(RECOGNITION_CONFIRM_THRESHOLD));
    expect(decision.trusted).toBe(true);
  });

  it('never trusts a zero-confidence result', () => {
    const decision = recognitionToPantryDecision(makeResult(0));
    expect(decision.trusted).toBe(false);
  });
});

describe('provider interfaces are registration-ready', () => {
  it('a VisualIngredientProvider exposes detectIngredients with a provider id', () => {
    const provider: VisualIngredientProvider = {
      id: 'test-vision',
      async detectIngredients(imageRef) {
        return [makeResult(0.99, { provider: this.id })];
      },
    };
    void provider;
    // Shape check: the interface requires id + detectIngredients — the above
    // object satisfies it, so a future real provider can register cleanly.
    expect(typeof provider.detectIngredients).toBe('function');
    expect(provider.id).toBe('test-vision');
  });

  it('a BarcodeProvider exposes scanBarcode + lookupProduct', () => {
    const provider: BarcodeProvider = {
      id: 'test-barcode',
      async scanBarcode() {
        return { barcode: '041333477019', confidence: 0.99, provider: 'test-barcode' };
      },
      async lookupProduct(barcode) {
        return { barcode, name: 'Olive oil', confidence: 0.98 };
      },
    };
    expect(typeof provider.scanBarcode).toBe('function');
    expect(typeof provider.lookupProduct).toBe('function');
  });
});
