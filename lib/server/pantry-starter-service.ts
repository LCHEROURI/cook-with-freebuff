import { z } from 'zod';
import type { RecipeRequest } from '../ai/types';
import type { DietaryProfile } from '../domain/types';
import { PantryService } from './pantry-service';
import { emptyProfile } from './profile-service';
import {
  mergeSafetyAllergies,
  preparePantryCandidates,
  type PantryStarterCandidate,
} from './kitchen-context';
import type { DietaryProfileStore, PantryStore } from './tools/types';

const boundedText = z.string().trim().min(1).max(200);
const itemId = z.string().trim().min(1).max(100);
function uniqueIds(minimum: number) {
  return z.array(itemId).min(minimum).max(50).superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pantry item IDs must be unique' });
    }
  });
}

export const pantryRecipeInputSchema = z.object({
  pantryItemIds: uniqueIds(1),
  confirmedPantryItemIds: uniqueIds(0).default([]),
  servings: z.number().int().min(1).max(50).optional(),
  maxTimeMinutes: z.number().int().min(1).max(24 * 60).optional(),
  cuisine: boundedText.optional(),
  craving: boundedText.optional(),
  allergies: z.array(boundedText).max(20).default([]),
  dietaryRestrictions: z.array(boundedText).max(20).default([]),
});

export type PantryRecipeInput = z.infer<typeof pantryRecipeInputSchema>;

export interface PantryStarterProfile {
  allergies: string[];
  dietaryRestrictions: string[];
  dislikedIngredients: string[];
  preferredCuisines: string[];
  defaultServings?: number;
  preferredEquipment: string[];
}

export interface PantryStarterSnapshot {
  items: PantryStarterCandidate[];
  profile: PantryStarterProfile;
}

export class PantryStarterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'PantryStarterError';
  }
}

function publicProfile(profile: DietaryProfile): PantryStarterProfile {
  return {
    allergies: profile.allergies ?? [],
    dietaryRestrictions: profile.dietaryRestrictions ?? [],
    dislikedIngredients: profile.dislikedIngredients ?? [],
    preferredCuisines: profile.preferredCuisines ?? [],
    ...(profile.defaultServings ? { defaultServings: profile.defaultServings } : {}),
    preferredEquipment: profile.preferredEquipment ?? [],
  };
}

export class PantryStarterService {
  private readonly pantry: PantryService;

  constructor(
    pantryStore: PantryStore,
    private readonly profileStore: DietaryProfileStore,
  ) {
    this.pantry = new PantryService(pantryStore);
  }

  async getSnapshot(userId: string): Promise<PantryStarterSnapshot> {
    const [items, storedProfile] = await Promise.all([
      this.pantry.listPantry(userId),
      this.profileStore.getProfile(userId),
    ]);
    const profile = storedProfile ?? emptyProfile(userId);
    return {
      items: preparePantryCandidates(items),
      profile: publicProfile(profile),
    };
  }

  async buildRecipeRequest(userId: string, input: PantryRecipeInput): Promise<RecipeRequest> {
    const [allItems, storedProfile] = await Promise.all([
      this.pantry.listPantry(userId),
      this.profileStore.getProfile(userId),
    ]);
    const ownedById = new Map(allItems.map((item) => [item.id, item]));
    const candidatesById = new Map(
      preparePantryCandidates(allItems).map((candidate) => [candidate.id, candidate]),
    );
    const confirmed = new Set(input.confirmedPantryItemIds);

    const selected = input.pantryItemIds.map((id) => {
      const owned = ownedById.get(id);
      if (!owned) {
        throw new PantryStarterError(
          'A selected pantry item is not available.',
          'PANTRY_ITEM_NOT_FOUND',
          false,
        );
      }
      if (owned.expired) {
        throw new PantryStarterError(
          `${owned.name} is expired and cannot be used for recipe generation.`,
          'PANTRY_ITEM_INELIGIBLE',
          true,
        );
      }
      const candidate = candidatesById.get(id);
      if (!candidate) {
        throw new PantryStarterError(
          'A selected pantry item is not eligible.',
          'PANTRY_ITEM_INELIGIBLE',
          true,
        );
      }
      if (candidate.requiresConfirmation && !confirmed.has(id)) {
        throw new PantryStarterError(
          `Confirm that you still have ${candidate.name} before using it.`,
          'PANTRY_CONFIRMATION_REQUIRED',
          true,
        );
      }
      return candidate;
    });

    const profile = storedProfile ?? emptyProfile(userId);
    return {
      ingredientsAvailable: selected.map((item) => ({
        id: `ing-${item.id}`,
        name: item.name,
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        optional: false,
      })),
      servings: input.servings ?? profile.defaultServings ?? 2,
      maxTimeMinutes: input.maxTimeMinutes,
      dietaryRestrictions: mergeSafetyAllergies(
        profile.dietaryRestrictions ?? [],
        input.dietaryRestrictions,
      ),
      allergies: mergeSafetyAllergies(profile.allergies ?? [], input.allergies),
      cuisinePreferences: input.cuisine
        ? [input.cuisine]
        : (profile.preferredCuisines ?? []),
      dislikedIngredients: profile.dislikedIngredients ?? [],
      availableEquipment: profile.preferredEquipment ?? [],
      craving: input.craving,
    };
  }
}
