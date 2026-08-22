import { describe, expect, it } from 'vitest';
import type { DietaryProfile, Ingredient, Recipe } from '../domain/types';
import { validateRecipe } from '../recipe/validate';
import {
  evaluateGeneratedRecipeSafety,
  evaluateStoredRecipeSafety,
} from './recipe-safety';

function ingredient(
  name: string,
  extras: Pick<Ingredient, 'preparation' | 'condition'> = {},
): Ingredient {
  return { id: `ingredient-${name}`, name, quantity: 1, unit: 'cup', optional: false, ...extras };
}

function recipe(ingredients: Ingredient[], allergens: string[] = []): Recipe {
  return {
    id: 'recipe-safety-corpus',
    userId: 'user-safety',
    title: 'Safety corpus recipe',
    servings: 2,
    estimatedPrepMinutes: 5,
    estimatedCookMinutes: 10,
    totalMinutes: 15,
    ingredients,
    equipment: [],
    prepSteps: [],
    cookingSteps: [],
    dietaryTags: [],
    allergens,
    safetyNotes: [],
    generatedAt: 1,
    updatedAt: 1,
  };
}

const profile = (
  allergies: string[] = [],
  dietaryRestrictions: string[] = [],
): DietaryProfile => ({
  userId: 'user-safety',
  allergies,
  dietaryRestrictions,
  dislikedIngredients: [],
  preferredCuisines: [],
  preferredEquipment: [],
  updatedAt: 1,
});

describe('ingredient-derived recipe safety', () => {
  it.each([
    ['peanut butter', ['peanuts'], []],
    ['almond', ['tree nuts'], []],
    ['almond milk', ['tree nuts'], []],
    ['whole milk', [], ['vegan']],
    ['butter', [], ['vegan']],
    ['cheddar cheese', [], ['vegan']],
    ['heavy cream', [], ['vegan']],
    ['egg', [], ['vegan']],
    ['chicken', [], ['vegetarian']],
    ['beef', [], ['vegetarian']],
    ['pork', [], ['vegetarian']],
    ['fish', [], ['vegetarian']],
    ['chicken', [], ['vegan']],
    ['beef', [], ['vegan']],
    ['pork', [], ['vegan']],
    ['fish', [], ['vegan']],
    ['wheat flour', [], ['gluten-free']],
    ['bread', [], ['gluten-free']],
    ['pasta', [], ['gluten-free']],
    ['barley malt', [], ['gluten-free']],
    ['rye crackers', [], ['gluten-free']],
    ['seitan', [], ['gluten-free']],
  ])('blocks direct ingredient evidence %s with missing metadata', (name, allergies, restrictions) => {
    const unsafe = recipe([ingredient(name)], []);
    const generated = evaluateGeneratedRecipeSafety(unsafe, {
      ingredientsAvailable: unsafe.ingredients,
      allergies,
      dietaryRestrictions: restrictions,
      cuisinePreferences: [],
      dislikedIngredients: [],
      availableEquipment: [],
    });
    const stored = evaluateStoredRecipeSafety(unsafe, profile(allergies, restrictions));

    expect(generated.canPersist).toBe(false);
    expect(stored.canList).toBe(false);
    expect(stored.canLaunch).toBe(false);
    expect(generated.blockingErrors).toEqual(stored.blockingErrors);
  });

  it.each([
    ['peanut allergy', ingredient('satay sauce', { condition: 'contains peanut oil' }), ['peanuts'], []],
    ['tree-nut allergy', ingredient('cream', { preparation: 'blended with raw cashews' }), ['tree nuts'], []],
    ['vegan', ingredient('pasta', { condition: 'made with egg yolks' }), [], ['vegan']],
    ['vegetarian', ingredient('stock', { preparation: 'simmered with chicken bones' }), [], ['vegetarian']],
    ['gluten-free', ingredient('tempeh', { condition: 'marinated in wheat soy sauce' }), [], ['gluten-free']],
  ])('blocks %s from name, preparation, or condition without generated metadata', (
    _label,
    unsafeIngredient,
    allergies,
    restrictions,
  ) => {
    const decision = validateRecipe(recipe([unsafeIngredient as Ingredient]), {
      allergies: allergies as string[],
      dietaryRestrictions: restrictions as string[],
    });

    expect(decision.blockingErrors).not.toEqual([]);
    expect(decision).toMatchObject({ canPersist: false, canList: false, canLaunch: false });
  });

  it.each([
    ['peanut-free sunflower seed butter', ['peanuts'], []],
    ['nut-free oat granola', ['tree nuts'], []],
    ['vegan chicken-style strips', [], ['vegan']],
    ['plant-based beef crumbles', [], ['vegetarian']],
    ['certified gluten-free bread', [], ['gluten-free']],
    ['gluten-free wheat-free pasta', [], ['gluten-free']],
    ['gluten-free crackers', [], ['gluten-free']],
    ['almond milk', [], ['vegan']],
    ['vegan butter', [], ['vegan']],
  ])('accepts the explicit safe equivalent %s', (name, allergies, restrictions) => {
    const decision = validateRecipe(recipe([ingredient(name)]), {
      allergies,
      dietaryRestrictions: restrictions,
    });

    expect(decision.blockingErrors).toEqual([]);
  });

  it('treats generated allergen metadata as supplemental, never exculpatory', () => {
    const ingredientBlock = validateRecipe(recipe([ingredient('peanut butter')], ['dairy']), {
      allergies: ['peanuts'],
    });
    const metadataBlock = validateRecipe(recipe([ingredient('sunflower seed butter')], ['peanuts']), {
      allergies: ['peanuts'],
    });

    expect(ingredientBlock.canPersist).toBe(false);
    expect(metadataBlock.canPersist).toBe(false);
  });

  it('blocks a stored legacy recipe whose generated metadata is missing or incorrect', () => {
    const missing = evaluateStoredRecipeSafety(
      recipe([ingredient('almond milk')], []),
      profile(['tree nuts']),
    );
    const incorrect = evaluateStoredRecipeSafety(
      recipe([ingredient('peanut butter')], ['dairy']),
      profile(['peanuts']),
    );

    expect(missing).toMatchObject({ canList: false, canLaunch: false });
    expect(incorrect).toMatchObject({ canList: false, canLaunch: false });
  });

  it('makes generated persistence and stored list/launch agree for one safety context', () => {
    const unsafe = recipe([ingredient('almond flour')]);
    const currentProfile = profile(['tree nuts']);
    const request = {
      ingredientsAvailable: unsafe.ingredients,
      dietaryRestrictions: [],
      allergies: ['tree nuts'],
      cuisinePreferences: [],
      dislikedIngredients: [],
      availableEquipment: [],
    };

    const generated = evaluateGeneratedRecipeSafety(unsafe, request);
    const stored = evaluateStoredRecipeSafety(unsafe, currentProfile);

    expect(generated.canPersist).toBe(false);
    expect(stored.canList).toBe(false);
    expect(stored.canLaunch).toBe(false);
    expect(generated.blockingErrors).toEqual(stored.blockingErrors);
  });
});
