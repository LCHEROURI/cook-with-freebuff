// Client-safe ranking for "Use These Soon" (Candidate C).
// No server dependencies - safe for app/ and components/ imports.

export interface ExpiringSoonRankable {
  recipeId: string;
  title: string;
  matchPercent: number;
  matchedCount: number;
  missingCount: number;
  expiringSoonCount: number;
  allIngredientsFound: boolean;
}

function compareExpiringSoon(a: ExpiringSoonRankable, b: ExpiringSoonRankable): number {
  if (a.expiringSoonCount !== b.expiringSoonCount) {
    return b.expiringSoonCount - a.expiringSoonCount;
  }
  if (a.allIngredientsFound !== b.allIngredientsFound) {
    return a.allIngredientsFound ? -1 : 1;
  }
  if (a.missingCount !== b.missingCount) {
    return a.missingCount - b.missingCount;
  }
  if (a.matchPercent !== b.matchPercent) {
    return b.matchPercent - a.matchPercent;
  }
  if (a.matchedCount !== b.matchedCount) {
    return b.matchedCount - a.matchedCount;
  }
  const titleCmp = a.title.localeCompare(b.title);
  if (titleCmp !== 0) return titleCmp;
  return a.recipeId.localeCompare(b.recipeId);
}

export function rankExpiringSoonMatches<T extends ExpiringSoonRankable>(
  matches: T[],
): T[] {
  return matches
    .filter((m) => m.expiringSoonCount > 0)
    .sort(compareExpiringSoon);
}
