import {
  CONSUME_CONFIDENCE_THRESHOLD,
  type PantryItemView,
} from './pantry-service';

export interface PantryStarterCandidate extends PantryItemView {
  requiresConfirmation: boolean;
  selectedByDefault: boolean;
}

export function preparePantryCandidates(
  items: PantryItemView[],
): PantryStarterCandidate[] {
  return items
    .filter((item) => !item.expired)
    .map((item) => {
      const requiresConfirmation =
        item.stale || item.confidence < CONSUME_CONFIDENCE_THRESHOLD;
      return {
        ...item,
        requiresConfirmation,
        selectedByDefault: !requiresConfirmation,
      };
    })
    .sort((left, right) => {
      if (left.requiresConfirmation !== right.requiresConfirmation) {
        return left.requiresConfirmation ? 1 : -1;
      }
      if (left.expiresSoon !== right.expiresSoon) {
        return left.expiresSoon ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export function mergeSafetyAllergies(
  stored: string[],
  explicit: string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const raw of [...stored, ...explicit]) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }

  return merged;
}
