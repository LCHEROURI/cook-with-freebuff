// ─────────────────────────────────────────────────────────────────────────────
// Dietary profile service (K8 — user memory)
//
// Long-term, inspectable preferences. Explicit allergies and safety
// constraints take priority over convenience — the profile is the single
// source of truth that recipe generation/validation consult.
// ─────────────────────────────────────────────────────────────────────────────

import type { DietaryProfileStore } from './tools/types';
import type { DietaryProfile } from '../domain/types';

export type DietaryProfilePatch = Partial<
  Pick<
    DietaryProfile,
    | 'allergies'
    | 'dietaryRestrictions'
    | 'dislikedIngredients'
    | 'preferredCuisines'
    | 'defaultServings'
    | 'preferredEquipment'
  >
>;

export function emptyProfile(userId: string): DietaryProfile {
  return {
    userId,
    allergies: [],
    dietaryRestrictions: [],
    dislikedIngredients: [],
    preferredCuisines: [],
    preferredEquipment: [],
    updatedAt: 0,
  };
}

export class DietaryProfileService {
  constructor(private readonly store: DietaryProfileStore) {}

  /** The stored profile, or null when the user has not set one yet. */
  async getProfile(userId: string): Promise<DietaryProfile | null> {
    return this.store.getProfile(userId);
  }

  /** Merge a patch into the current profile (creating a default when unset). */
  async updateProfile(userId: string, patch: DietaryProfilePatch): Promise<DietaryProfile> {
    const current = (await this.store.getProfile(userId)) ?? emptyProfile(userId);
    const updated: DietaryProfile = {
      ...current,
      ...patch,
      userId,
      updatedAt: Date.now(),
    };
    await this.store.upsertProfile(updated);
    return updated;
  }
}
