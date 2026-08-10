// ─────────────────────────────────────────────────────────────────────────────
// Vision layer — provider interfaces (K9 Part A — camera readiness)
//
// Camera recognition is deliberately NOT a dependency of the main cooking
// experience. These interfaces exist so future V4 capabilities (ingredient
// recognition, barcode scanning, quantity estimation, expiration recognition,
// grocery + smart-device integration) can plug in without touching the cooking
// core. Any recognition result must be CONFIRMED by the user before it becomes
// trusted pantry state when confidence is insufficient — see
// `recognitionToPantryDecision` below.
// ─────────────────────────────────────────────────────────────────────────────

/** A single recognized item, always carrying an honest confidence. */
export interface RecognitionResult {
  name: string;
  /** 0..1 — how sure the provider is about this recognition. */
  confidence: number;
  quantity?: number;
  unit?: string;
  /** When the image shows an expiration date, the provider may surface it. */
  expirationDate?: number;
  source: 'VISION' | 'BARCODE';
  /** Provider identifier for observability (e.g. 'gemini-vision', 'zxing'). */
  provider: string;
}

/** A barcode read + optional product lookup. */
export interface BarcodeResult {
  barcode: string;
  confidence: number;
  provider: string;
}

export interface ProductLookup {
  barcode: string;
  name?: string;
  /** The lookup itself is uncertain unless the provider says otherwise. */
  confidence: number;
}

/**
 * Camera ingredient recognition. Implementations are registered in the
 * production wiring when a provider is configured; absent that, the cooking
 * flow never touches this interface.
 */
export interface VisualIngredientProvider {
  readonly id: string;
  /** Recognize ingredients (and optionally quantities) from an image. */
  detectIngredients(imageRef: string, hint?: string): Promise<RecognitionResult[]>;
}

/**
 * Barcode scanning. A future camera path can chain scanBarcode → lookupProduct
 * to turn a scan into a pantry candidate.
 */
export interface BarcodeProvider {
  readonly id: string;
  scanBarcode(imageRef: string): Promise<BarcodeResult>;
  lookupProduct(barcode: string): Promise<ProductLookup>;
}

/**
 * Confidence below which a recognition result must not become trusted pantry
 * state without explicit user confirmation.
 */
export const RECOGNITION_CONFIRM_THRESHOLD = 0.9;

export type RecognitionToPantryDecision =
  | { trusted: true; item: RecognitionResult }
  | { trusted: false; pending: RecognitionResult; reason: 'LOW_CONFIDENCE' };

/**
 * The confirmation gate for recognition results (the spec's "any recognition
 * result must be confirmed before becoming trusted pantry state when
 * confidence is insufficient"). High-confidence results may be trusted
 * directly; anything below the threshold must be surfaced for confirmation.
 * This is the contract a provider must go through before writing pantry state.
 */
export function recognitionToPantryDecision(
  result: RecognitionResult,
): RecognitionToPantryDecision {
  if (result.confidence >= RECOGNITION_CONFIRM_THRESHOLD) {
    return { trusted: true, item: result };
  }
  return { trusted: false, pending: result, reason: 'LOW_CONFIDENCE' };
}
