// ─────────────────────────────────────────────────────────────────────────────
// Ingredient extraction
//
// Turns a spoken brain-dump ("I have some chicken thighs, three tomatoes,
// half an onion, garlic, cilantro and some rice") into structured ingredients.
// Unknown quantities are explicitly null — never invented.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient } from '../domain/types';

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  couple: 2,
};

/** Words that mean "present, quantity unknown". */
const UNKNOWN_QUANTITY = new Set([
  'some', 'any', 'few', 'a few', 'little', 'a little', 'a bit', 'bit', 'enough', 'several', 'plenty',
]);

const UNITS = new Set([
  'cups', 'cup', 'tablespoons', 'tablespoon', 'tbsp', 'tbsps', 'teaspoons', 'teaspoon',
  'tsp', 'tsps', 'grams', 'gram', 'g', 'kilograms', 'kilogram', 'kg', 'milliliters',
  'milliliter', 'ml', 'liters', 'liter', 'l', 'pieces', 'piece', 'pcs', 'cloves', 'clove',
  'cans', 'can', 'ounces', 'ounce', 'oz', 'pounds', 'pound', 'lb', 'lbs', 'bunch',
  'bunches', 'handful', 'handfuls', 'pinch', 'pinches', 'splash', 'splashes', 'slices',
  'slice', 'head', 'heads', 'stalk', 'stalks', 'sprig', 'sprigs', 'bottles', 'bottle',
  'jars', 'jar', 'boxes', 'box', 'packs', 'pack', 'packages', 'package', 'sticks', 'stick',
  'tins', 'tin', 'drops', 'drop', 'tubs', 'tub',
]);

/** Lead-in phrases to strip before parsing ("I have", "I've got", …). */
const LEAD_IN =
  /^(?:i'?ve also got|i also have|i'?ve got|i have got|i have|we'?ve got|we have|also|so|okay|ok|well|right)\b/i;

/**
 * Possession lead-ins are the strongest brain-dump signal ("I have …",
 * "we've got …"). Used by the extraction gate below.
 */
const POSSESSION_LEAD_IN =
  /^(?:i'?ve also got|i also have|i'?ve got|i have got|i have|we'?ve got|we have)\b/i;

/**
 * Quantity/unit tokens that mark an ingredient list even without a
 * lead-in ("two cups of flour and three eggs"). Articles (a/an) are
 * deliberately excluded — they appear in every sentence.
 */
const QUANTITY_GATE_SOURCES = [
  ...Object.keys(NUMBER_WORDS).filter((w) => w !== 'a' && w !== 'an'),
  ...[...UNKNOWN_QUANTITY].filter((w) => w !== 'a' && w !== 'an'),
  'half',
  ...[...UNITS].filter((u) => u !== 'can' && u !== 'cans'),
];
const QUANTITY_GATE = new RegExp(
  `\\b(?:${[...QUANTITY_GATE_SOURCES].sort((a, b) => b.length - a.length).join('|')}|\\d+(?:\\.\\d+)?|\\d+\\s*/\\s*\\d+)\\b`,
  'i',
);

export interface ParsedIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}

const stripArticle = (text: string): string => text.replace(/^(a |an |the )/, '');

function parseQuantity(text: string): { quantity: number | null; rest: string } {
  // "two and a half" / "one and a half" → 2.5
  const andHalf = text.match(/^(\d+|[a-z]+)\s+and\s+a\s+half\b/);
  if (andHalf) {
    const base = NUMBER_WORDS[andHalf[1]] ?? Number(andHalf[1]);
    if (base) {
      return { quantity: base + 0.5, rest: text.slice(andHalf[0].length).trim() };
    }
  }

  // fraction "1/2" / "1 1/2" (bare fraction first)
  const frac = text.match(/^(\d+)\s*\/\s*(\d+)\b/);
  if (frac && Number(frac[2]) > 0) {
    return { quantity: Number(frac[1]) / Number(frac[2]), rest: text.slice(frac[0].length).trim() };
  }

  // decimal / integer
  const num = text.match(/^(\d+(?:\.\d+)?)\b/);
  if (num) {
    return { quantity: Number(num[1]), rest: text.slice(num[0].length).trim() };
  }

  // number word
  const firstWord = text.split(/\s+/)[0];
  if (firstWord && NUMBER_WORDS[firstWord] !== undefined) {
    return { quantity: NUMBER_WORDS[firstWord], rest: text.slice(firstWord.length).trim() };
  }

  // "half" alone
  if (firstWord === 'half') {
    return { quantity: 0.5, rest: text.slice(5).trim() };
  }

  // unknown-quantity marker
  for (const marker of UNKNOWN_QUANTITY) {
    if (text.startsWith(marker)) {
      return { quantity: null, rest: text.slice(marker.length).trim() };
    }
  }

  return { quantity: null, rest: text };
}

/**
 * Parse a single ingredient segment. Returns null when the segment contains
 * nothing parseable.
 */
export function parseIngredientSegment(raw: string): ParsedIngredient | null {
  let text = stripArticle(raw.trim().toLowerCase().replace(/[.!?]+$/, '').trim());
  if (!text) return null;

  const { quantity, rest } = parseQuantity(text);
  text = rest;
  text = stripArticle(text);

  // unit (possibly multi-token before "of", e.g. "cups of flour")
  let unit: string | null = null;
  const unitMatch = text.match(/^([a-z]+)\b/);
  if (unitMatch && UNITS.has(unitMatch[1])) {
    unit = unitMatch[1];
    text = text.slice(unitMatch[1].length).trim();
  }
  text = text.replace(/^of\b/, '').trim();

  // trailing filler
  text = text.replace(/\b(please|thanks|thank you|thx)\b/g, '').replace(/\s+/g, ' ').trim();

  if (!text) return null;
  return { name: text, quantity, unit };
}

/**
 * Extract structured ingredients from a spoken brain-dump.
 * Handles comma/plus/"and" separators, mixed quantities, and multi-item
 * phrases ("salt and pepper" → two entries).
 */
export function extractIngredients(utterance: string): Ingredient[] {
  // Questions are NEVER brain-dumps: an utterance that looks like a question
  // (ends with '?' or opens with a question word) falls straight through to
  // the free-form provider instead of becoming a fake ingredient. This is
  // load-bearing: number-words inside questions ("what is ONE good tip for
  // seasoning chicken") would otherwise trip the quantity gate below and
  // swallow the whole sentence as a single ingredient.
  const trimmedUtterance = utterance.trim();
  if (
    trimmedUtterance.endsWith('?') ||
    /^(?:what|whats|what's|how|why|when|where|which|who|can|could|do|does|is|are|should|would|will|tell me)\b/i.test(
      trimmedUtterance,
    )
  ) {
    return [];
  }

  let text = utterance.toLowerCase().replace(/[.!?]+$/, '').trim();

  // Gate: only treat this as a brain-dump when there is explicit evidence —
  // a possession lead-in ("I have …") or a quantity/unit token. Conversational
  // turns ("go ahead and start cooking", "hello") must fall through to the
  // provider instead of becoming fake ingredients. The possession probe strips
  // filler words (so/okay/well/…) but NOT the lead-in itself.
  const possessionProbe = text.replace(/^(?:also|so|okay|ok|well|right)\b/i, ' ').trim();
  const hasLeadIn = POSSESSION_LEAD_IN.test(possessionProbe);

  text = text.replace(LEAD_IN, ' ').replace(/\s+/g, ' ').trim();
  if (!hasLeadIn && !QUANTITY_GATE.test(text)) {
    return [];
  }

  // Split on commas / semicolons / "plus"; keep "and" for quantity handling.
  const chunks = text
    .split(/[,;]|\bplus\b/)
    .map((c) => c.trim())
    .filter(Boolean);

  const results: ParsedIngredient[] = [];

  for (const chunk of chunks) {
    const parsed = parseIngredientSegment(chunk);

    if (parsed && !parsed.name.includes(' and ')) {
      results.push(parsed);
      continue;
    }

    // Multi-item chunk ("cilantro and some rice") or name containing " and ":
    // split the name into parts and parse each side fresh.
    const nameParts = (parsed?.name ?? chunk).split(/\s+and\s+/).filter(Boolean);
    if (parsed) {
      // First part keeps the quantity/unit already parsed.
      const [first, ...rest] = nameParts;
      if (first) results.push({ name: first, quantity: parsed.quantity, unit: parsed.unit });
      for (const part of rest) {
        const p = parseIngredientSegment(part);
        if (p) results.push(p);
      }
    } else {
      for (const part of nameParts) {
        const p = parseIngredientSegment(part);
        if (p) results.push(p);
      }
    }
  }

  return dedupe(results).map((p, i) => ({
    id: `ing-${slug(p.name)}-${i}`,
    name: p.name,
    quantity: p.quantity,
    unit: p.unit,
    optional: false,
  }));
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function dedupe(items: ParsedIngredient[]): ParsedIngredient[] {
  const seen = new Set<string>();
  const out: ParsedIngredient[] = [];
  for (const item of items) {
    const key = item.name.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}