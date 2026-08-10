// ─────────────────────────────────────────────────────────────────────────────
// Ingredient substitution (K7 Part A)
//
// Deterministic, honest substitution suggestions. Candidates come from a
// curated culinary map; the user's pantry/available ingredients are preferred
// and anything already in the recipe is excluded. No candidate is invented —
// when nothing maps, the engine returns [].
// ─────────────────────────────────────────────────────────────────────────────

export interface SubstitutionCandidate {
  ingredient: string;
  ratio: string;
  notes?: string;
}

/**
 * Curated culinary substitutions. Keys are normalized (lowercase); matching is
 * word-aware so "garlic" also matches a recipe's "garlic clove".
 */
const SUBSTITUTION_MAP: Record<string, SubstitutionCandidate[]> = {
  garlic: [
    { ingredient: 'garlic powder', ratio: '1 clove = 1/8 tsp', notes: 'Add early so it blooms in the fat' },
    { ingredient: 'granulated garlic', ratio: '1 clove = 1/4 tsp' },
  ],
  milk: [
    { ingredient: 'water + butter', ratio: '1 cup milk = 1 cup water + 1 tbsp butter' },
    { ingredient: 'heavy cream', ratio: '1:1', notes: 'Thinner with a splash of water' },
  ],
  'heavy cream': [
    { ingredient: 'milk + butter', ratio: '1 cup cream = 3/4 cup milk + 1/4 cup melted butter' },
    { ingredient: 'coconut cream', ratio: '1:1', notes: 'Slightly sweet' },
  ],
  buttermilk: [
    { ingredient: 'milk + lemon juice', ratio: '1 cup milk + 1 tbsp lemon juice, rest 5 min' },
    { ingredient: 'plain yogurt thinned with water', ratio: '1:1' },
  ],
  butter: [
    { ingredient: 'olive oil', ratio: '1:1', notes: 'Best for sautéing; not for baking' },
    { ingredient: 'coconut oil', ratio: '1:1' },
  ],
  egg: [
    { ingredient: 'flax egg', ratio: '1 egg = 1 tbsp flax + 3 tbsp water' },
    { ingredient: 'applesauce', ratio: '1 egg = 1/4 cup' },
  ],
  eggs: [
    { ingredient: 'flax egg', ratio: '1 egg = 1 tbsp flax + 3 tbsp water' },
    { ingredient: 'applesauce', ratio: '1 egg = 1/4 cup' },
  ],
  'soy sauce': [
    { ingredient: 'tamari', ratio: '1:1', notes: 'Gluten-free' },
    { ingredient: 'coconut aminos', ratio: '1:1' },
  ],
  honey: [
    { ingredient: 'maple syrup', ratio: '1:1' },
    { ingredient: 'agave nectar', ratio: '1:1' },
  ],
  yogurt: [
    { ingredient: 'sour cream', ratio: '1:1' },
    { ingredient: 'buttermilk', ratio: '1:1' },
  ],
  'sour cream': [
    { ingredient: 'plain yogurt', ratio: '1:1' },
    { ingredient: 'crème fraîche', ratio: '1:1' },
  ],
  'white wine': [
    { ingredient: 'chicken stock', ratio: '1:1', notes: 'For cooking; not for drinking' },
    { ingredient: 'white wine vinegar + stock', ratio: '1 tsp vinegar + rest stock' },
  ],
  breadcrumbs: [
    { ingredient: 'crushed crackers', ratio: '1:1' },
    { ingredient: 'panko', ratio: '1:1' },
  ],
  'baking powder': [
    { ingredient: 'baking soda + cream of tartar', ratio: '1 tsp baking powder = 1/4 tsp soda + 1/2 tsp cream of tartar' },
  ],
  'tomato paste': [
    { ingredient: 'crushed tomatoes reduced', ratio: '1 tbsp paste = 3 tbsp crushed tomatoes simmered down' },
  ],
  parmesan: [
    { ingredient: 'nutritional yeast', ratio: '1:1', notes: 'For a savory, cheesy finish' },
    { ingredient: 'pecorino', ratio: '1:1' },
  ],
  lemon: [
    { ingredient: 'lime juice', ratio: '1:1' },
    { ingredient: 'white vinegar', ratio: '1/2 tsp per tsp of juice', notes: 'For acidity only' },
  ],
  'olive oil': [
    { ingredient: 'neutral oil (canola/sunflower)', ratio: '1:1', notes: 'For high-heat cooking' },
    { ingredient: 'avocado oil', ratio: '1:1' },
  ],
  cilantro: [
    { ingredient: 'parsley', ratio: '1:1' },
    { ingredient: 'fresh mint', ratio: '1:1' },
  ],
  'chicken broth': [
    { ingredient: 'water + bouillon', ratio: '1:1' },
    { ingredient: 'vegetable stock', ratio: '1:1' },
  ],
};

function normalize(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Match a map key against an ingredient name (word-aware, either direction). */
function matchesKey(name: string, key: string): boolean {
  if (name === key) return true;
  const nameWords = new Set(name.split(' '));
  const keyWords = key.split(' ');
  // Exact multi-word containment in either direction.
  if (name.includes(key) || key.includes(name)) return true;
  // Every key word appears in the name (e.g. key "heavy cream" vs "heavy cream substitute").
  return keyWords.length > 1 && keyWords.every((w) => nameWords.has(w));
}

/**
 * Deterministic substitution candidates for an unavailable ingredient.
 * - Curated map lookups (word-aware)
 * - Pantry/available items ranked first
 * - Anything already in the recipe is excluded
 * - Capped at 3 candidates; [] when nothing is known (never invented)
 */
export function findSubstitutionCandidates(
  recipe: { ingredients: { name: string }[] },
  unavailableIngredient: string,
  availablePantry: string[] = [],
): SubstitutionCandidate[] {
  const target = normalize(unavailableIngredient);
  if (!target) return [];

  const inRecipe = new Set(recipe.ingredients.map((i) => normalize(i.name)));
  const pantry = new Set(availablePantry.map(normalize));

  const matches = new Map<string, SubstitutionCandidate>();
  for (const [key, candidates] of Object.entries(SUBSTITUTION_MAP)) {
    if (!matchesKey(target, key)) continue;
    for (const c of candidates) {
      const already = inRecipe.has(normalize(c.ingredient));
      if (already) continue;
      // First map hit for a key wins (order in the map is priority).
      if (!matches.has(normalize(c.ingredient))) {
        matches.set(normalize(c.ingredient), c);
      }
    }
  }

  const ranked = Array.from(matches.values()).sort((a, b) => {
    const aIn = pantry.has(normalize(a.ingredient)) ? 0 : 1;
    const bIn = pantry.has(normalize(b.ingredient)) ? 0 : 1;
    return aIn - bIn;
  });

  return ranked.slice(0, 3);
}
