import type { Ingredient } from '../domain/types';

export type IngredientSafetyHazard =
  | 'peanut'
  | 'tree_nut'
  | 'meat'
  | 'animal_product'
  | 'gluten';

export interface IngredientSafetyEvidence {
  ingredient: string;
  hazard: IngredientSafetyHazard;
  term: string;
}

const normalize = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[-_]+/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const TREE_NUT_TERMS = [
  'almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut',
  'macadamia', 'brazil nut', 'pine nut', 'chestnut', 'tree nut',
];
const MEAT_TERMS = [
  'chicken', 'beef', 'pork', 'bacon', 'lamb', 'turkey', 'duck', 'veal',
  'steak', 'sausage', 'ham', 'prosciutto', 'fish', 'shrimp', 'salmon',
  'tuna', 'anchovy', 'crab', 'lobster', 'scallop', 'gelatin', 'lard',
];
const ANIMAL_PRODUCT_TERMS = [
  'milk', 'butter', 'cheese', 'cream', 'whey', 'casein', 'yogurt',
  'egg', 'honey', 'ghee',
];
const GLUTEN_TERMS = [
  'wheat', 'barley', 'rye', 'malt', 'seitan', 'spelt', 'farro',
  'bread', 'pasta', 'cracker',
];

function includesTerm(text: string, term: string): boolean {
  return new RegExp(`\\b${term.replace(/ /g, '\\s+')}s?\\b`, 'i').test(text);
}

function removeSafeEquivalents(text: string): string {
  return text
    .replace(/\b(?:peanut|peanuts)\s+free\b/g, '')
    .replace(/\b(?:tree\s+)?nut\s+free\b/g, '')
    .replace(/\b(?:certified\s+)?(?:gluten|wheat)\s+free\s+(?:bread|pasta|cracker)s?\b/g, '')
    .replace(/\bgluten\s+free\b/g, '')
    .replace(/\bwheat\s+free\b/g, '')
    .replace(
      new RegExp(`\\b(?:vegan|vegetarian|plant based|meatless)\\s+(?:${MEAT_TERMS.join('|')})(?:\\s+style)?\\b`, 'g'),
      '',
    )
    .replace(
      new RegExp(`\\b(?:vegan|plant based|dairy free|egg free)\\s+(?:${ANIMAL_PRODUCT_TERMS.join('|')})\\b`, 'g'),
      '',
    );
}

function firstTerm(text: string, terms: string[]): string | undefined {
  return terms.find((term) => includesTerm(text, term));
}

/** Normalize all authoritative ingredient fields and classify supported hazards once. */
export function classifyIngredientSafety(ingredient: Ingredient): IngredientSafetyEvidence[] {
  const evidence = removeSafeEquivalents(normalize([
    ingredient.name,
    ingredient.preparation ?? '',
    ingredient.condition ?? '',
  ].join(' ')));
  const hazards: IngredientSafetyEvidence[] = [];
  const add = (hazard: IngredientSafetyHazard, term: string | undefined) => {
    if (term) hazards.push({ ingredient: ingredient.name, hazard, term });
  };

  add('peanut', firstTerm(evidence, ['peanut']));
  add('tree_nut', firstTerm(evidence, TREE_NUT_TERMS));
  add('meat', firstTerm(evidence, MEAT_TERMS));
  const animalEvidence = evidence.replace(
    /\b(?:almond|oat|soy|coconut|rice|cashew|plant based)\s+milk\b/g,
    '',
  );
  add('animal_product', firstTerm(animalEvidence, ANIMAL_PRODUCT_TERMS));
  add('gluten', firstTerm(evidence, GLUTEN_TERMS));
  return hazards;
}

export function normalizeAllergyCategory(value: string): 'peanut' | 'tree_nut' | null {
  const normalized = normalize(value);
  if (normalized === 'peanut' || normalized === 'peanuts') return 'peanut';
  if (normalized === 'tree nut' || normalized === 'tree nuts' || normalized === 'nut' || normalized === 'nuts') {
    return 'tree_nut';
  }
  return null;
}

export function normalizeRestriction(value: string): 'vegan' | 'vegetarian' | 'gluten_free' | null {
  const normalized = normalize(value);
  if (normalized === 'vegan') return 'vegan';
  if (normalized === 'vegetarian') return 'vegetarian';
  if (normalized === 'gluten free' || normalized === 'glutenfree') return 'gluten_free';
  return null;
}
