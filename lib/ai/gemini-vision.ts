// ─────────────────────────────────────────────────────────────────────────────
// Gemini Vision — ingredient scanner
//
// Sends an image to Gemini with a structured prompt asking it to identify
// food ingredients. Returns RecognitionResult[] compatible with the existing
// VisualIngredientProvider interface. Server-only: the API key never reaches
// the browser.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { RecognitionResult, VisualIngredientProvider } from '../vision/types';

const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';

function getKey(): string | undefined {
  return process.env.GOOGLE_AI_API_KEY;
}

/**
 * Prompt Gemini to identify food ingredients in an image.
 * Returns a structured JSON array of recognized items with honest confidences.
 * The model is instructed to ONLY name items it can see — never invent.
 */
async function scanImage(base64Image: string, mimeType: string, modelName: string): Promise<RecognitionResult[]> {
  const key = getKey();
  if (!key) throw new Error('GOOGLE_AI_API_KEY is not configured');

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = [
    'You are a kitchen ingredient scanner. Look at this image and identify ONLY food ingredients, groceries, and pantry items you can actually see.',
    '',
    'Rules:',
    '- Return STRICT JSON — an array of objects, nothing else. No markdown, no prose.',
    '- Each object has: name (string), confidence (number 0-1), quantity (number|null), unit (string|null).',
    '- Only name items you can actually identify with reasonable certainty.',
    '- For loose items (vegetables, fruits), estimate quantity if visible. Use null when unclear.',
    '- For packaged items, name the product if the label is readable. Skip if unreadable.',
    '- Confidence 0.9+ = clearly visible and unambiguous. 0.6-0.8 = plausible but not certain.',
    '- Never invent items. An empty array is better than guessing.',
    '- Include expiration dates only when clearly visible on packaging (as an epochMs number, or null).',
    '',
    'Return shape: [{"name":"string","confidence":0.0-1.0,"quantity":number|null,"unit":"string|null","expirationDate":number|null}]',
  ].join('\n');

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType, data: base64Image } },
  ]);

  const text = result.response.text();
  // Extract JSON array from response (handles ``` fences).
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();

  const start = cleaned.indexOf('[');
  if (start === -1) throw new Error('No JSON array found in model response');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const json = cleaned.slice(start, i + 1);
        const raw = JSON.parse(json) as Array<{
          name?: unknown;
          confidence?: unknown;
          quantity?: unknown;
          unit?: unknown;
          expirationDate?: unknown;
        }>;

        return raw.map((item): RecognitionResult => ({
          name: typeof item.name === 'string' ? item.name.trim() : 'unknown item',
          confidence: typeof item.confidence === 'number'
            ? Math.max(0, Math.min(1, item.confidence))
            : 0.5,
          quantity: typeof item.quantity === 'number' ? item.quantity : undefined,
          unit: typeof item.unit === 'string' ? item.unit : undefined,
          expirationDate: typeof item.expirationDate === 'number' ? item.expirationDate : undefined,
          source: 'VISION',
          provider: 'gemini-vision',
        }));
      }
    }
  }
  throw new Error('Unbalanced JSON array in model response');
}

export interface GeminiVisionScannerOptions {
  /** Remote Config model resolver — returns a model name or undefined. */
  resolveModel?: () => Promise<string | undefined>;
}

export function createGeminiVisionScanner(opts: GeminiVisionScannerOptions = {}): VisualIngredientProvider {
  return {
    id: 'gemini-vision',
    async detectIngredients(imageRef: string): Promise<RecognitionResult[]> {
      // imageRef is base64 data: either "data:image/jpeg;base64,<data>" or raw base64.
      let mimeType = 'image/jpeg';
      let base64 = imageRef;
      const dataUri = imageRef.match(/^data:(image\/\w+);base64,(.+)$/);
      if (dataUri) {
        mimeType = dataUri[1];
        base64 = dataUri[2];
      }
      const modelName = (await opts.resolveModel?.()) ?? process.env.VISION_MODEL ?? DEFAULT_VISION_MODEL;
      return scanImage(base64, mimeType, modelName);
    },
  };
}
