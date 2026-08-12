// ─────────────────────────────────────────────────────────────────────────────
// Deterministic protein classifier
//
// Maps ingredient names to protein categories using an exact-match lookup
// table against the FIRST word of each ingredient name (the primary protein).
// "chicken thighs" → chicken, "ground beef" → beef, "salmon fillet" → seafood.
//
// Unknown ingredients contribute nothing — this classifier is conservative,
// never inventing a category. "Vegetarian" is set when zero protein categories
// resolve and no meat/poultry/seafood ingredient names are present. "Vegan"
// is set when vegetarian AND no dairy/egg/honey ingredients are present.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ingredient } from '../domain/types';

/** Standardized protein category labels. */
export type ProteinCategory =
  | 'chicken'
  | 'beef'
  | 'lamb'
  | 'pork'
  | 'seafood'
  | 'poultry'
  | 'tofu'
  | 'eggs'
  | 'vegetarian'
  | 'vegan';

/**
 * First-word → protein category lookup.
 * Every key is the normalized first word of an ingredient name.
 */
const PROTEIN_MAP: Readonly<Record<string, ProteinCategory>> = {
  // ── Chicken ──
  chicken: 'chicken',
  // ── Beef ──
  beef: 'beef', steak: 'beef', veal: 'beef', brisket: 'beef',
  sirloin: 'beef', tenderloin: 'beef', ribeye: 'beef',
  // ── Lamb ──
  lamb: 'lamb', mutton: 'lamb',
  // ── Pork ──
  pork: 'pork', bacon: 'pork', ham: 'pork', sausage: 'pork',
  chorizo: 'pork', prosciutto: 'pork', pancetta: 'pork',
  // ── Seafood ──
  salmon: 'seafood', tuna: 'seafood', shrimp: 'seafood',
  cod: 'seafood', tilapia: 'seafood', trout: 'seafood',
  halibut: 'seafood', sardine: 'seafood', mackerel: 'seafood',
  bass: 'seafood', snapper: 'seafood', haddock: 'seafood',
  mahi: 'seafood', swordfish: 'seafood', crab: 'seafood',
  lobster: 'seafood', mussel: 'seafood', clam: 'seafood',
  oyster: 'seafood', scallop: 'seafood', squid: 'seafood',
  octopus: 'seafood', calamari: 'seafood', anchovy: 'seafood',
  catfish: 'seafood', pollock: 'seafood', perch: 'seafood',
  // ── Poultry ──
  turkey: 'poultry', duck: 'poultry', goose: 'poultry',
  quail: 'poultry', pheasant: 'poultry', cornish: 'poultry',
  // ── Tofu / plant protein ──
  tofu: 'tofu', tempeh: 'tofu', seitan: 'tofu',
  // ── Eggs ──
  egg: 'eggs', eggs: 'eggs',
};

/** Ingredients that indicate the dish is NOT vegetarian/vegan. */
const MEAT_FIRST_WORDS = new Set(Object.keys(PROTEIN_MAP).filter(
  (k) => PROTEIN_MAP[k] !== 'tofu' && PROTEIN_MAP[k] !== 'eggs',
));

/** Ingredients that indicate the dish is NOT vegan. */
const DAIRY_EGG_HONEY = new Set([
  'butter', 'milk', 'cream', 'cheese', 'yogurt', 'yoghurt',
  'egg', 'eggs', 'honey', 'ghee', 'sour', 'ricotta', 'mozzarella',
  'parmesan', 'cheddar', 'feta', 'goat', 'brie', 'mascarpone',
  'buttermilk', 'half', 'heavy', 'whipping', 'creme', 'crème',
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function firstWord(s: string): string {
  return normalize(s).split(' ')[0];
}

/**
 * Classify protein categories from the ingredient list.
 * Returns a deduplicated, sorted array of category labels.
 * Sets "vegetarian" or "vegan" when appropriate.
 */
export function classifyProteins(ingredients: Ingredient[]): string[] {
  const cats = new Set<ProteinCategory>();
  const allWords: string[] = [];

  // Check every word of every ingredient against the protein map.
  // "ground beef" → "ground" (miss), "beef" (hit).
  for (const ing of ingredients) {
    const words = normalize(ing.name).split(' ');
    allWords.push(...words);
    for (const w of words) {
      const cat = PROTEIN_MAP[w];
      if (cat) cats.add(cat);
    }
  }

  // Vegetarian: zero meat/poultry/seafood matches AND no meat words present.
  const hasMeat = allWords.some((w) => MEAT_FIRST_WORDS.has(w));
  if (!hasMeat) {
    cats.add('vegetarian');

    // Vegan: vegetarian AND no dairy/egg/honey ingredients present.
    const hasAnimalProduct = ingredients.some((ing) => {
      // Check the first two words of each ingredient (catches "sour cream",
      // "goat cheese", "heavy cream").
      const words = normalize(ing.name).split(' ');
      return DAIRY_EGG_HONEY.has(words[0]) ||
        (words.length >= 2 && DAIRY_EGG_HONEY.has(`${words[0]} ${words[1]}`));
    });
    if (!hasAnimalProduct) cats.add('vegan');
  }

  // Deduplicate + sort for deterministic output.
  const sorted = Array.from(cats).sort();
  // vegetarian/vegan always last for readability, in that order.
  const dietary: string[] = [];
  if (cats.has('vegetarian')) dietary.push('vegetarian');
  if (cats.has('vegan')) dietary.push('vegan');
  return [
    ...sorted.filter((c) => c !== 'vegetarian' && c !== 'vegan'),
    ...dietary,
  ];
}
