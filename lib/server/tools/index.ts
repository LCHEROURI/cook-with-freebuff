// ─────────────────────────────────────────────────────────────────────────────
// Tool layer — public surface
// ─────────────────────────────────────────────────────────────────────────────

import { ToolRegistry } from './registry';
import {
  saveAvailableIngredientsTool,
  updateAvailableIngredientsTool,
  confirmAvailableIngredientsTool,
} from './ingredient-tools';
import {
  startCookingSessionTool,
  getCookingSessionTool,
  getCurrentStepTool,
  completeCurrentStepTool,
  repeatCurrentStepTool,
  previousStepTool,
  pauseCookingSessionTool,
  resumeCookingSessionTool,
  endCookingSessionTool,
} from './session-tools';
import {
  startTimerTool,
  getActiveTimersTool,
  cancelTimerTool,
  completeTimerTool,
} from './timer-tools';
import {
  generateRecipeTool,
  validateRecipeTool,
  resizeRecipeTool,
  findSubstitutionTool,
  replaceIngredientTool,
} from './recipe-tools';
import {
  cookWithMeTool,
  checkTimersTool,
  requestSubstitutionTool,
  applySubstitutionTool,
  correctIngredientTool,
  recoverSessionTool,
} from './guide-tools';
import {
  getPantryTool,
  addPantryItemTool,
  updatePantryItemTool,
  removePantryItemTool,
  confirmPantryItemTool,
  confirmPendingPantryItemsTool,
  getDietaryProfileTool,
  updateDietaryProfileTool,
} from './pantry-tools';

export * from './types';
export * from './registry';

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    // Ingredient tools
    .register(saveAvailableIngredientsTool)
    .register(updateAvailableIngredientsTool)
    .register(confirmAvailableIngredientsTool)
    // Session tools
    .register(startCookingSessionTool)
    .register(getCookingSessionTool)
    .register(getCurrentStepTool)
    .register(completeCurrentStepTool)
    .register(repeatCurrentStepTool)
    .register(previousStepTool)
    .register(pauseCookingSessionTool)
    .register(resumeCookingSessionTool)
    .register(endCookingSessionTool)
    // Timer tools
    .register(startTimerTool)
    .register(getActiveTimersTool)
    .register(cancelTimerTool)
    .register(completeTimerTool)
    // Recipe tools
    .register(generateRecipeTool)
    .register(validateRecipeTool)
    .register(resizeRecipeTool)
    .register(findSubstitutionTool)
    .register(replaceIngredientTool)
    // Guided cooking (K6)
    .register(cookWithMeTool)
    .register(checkTimersTool)
    // Substitutions, corrections & recovery (K7)
    .register(requestSubstitutionTool)
    .register(applySubstitutionTool)
    .register(correctIngredientTool)
    .register(recoverSessionTool)
    // Pantry + dietary profile (K8)
    .register(getPantryTool)
    .register(addPantryItemTool)
    .register(updatePantryItemTool)
    .register(removePantryItemTool)
    .register(confirmPantryItemTool)
    .register(confirmPendingPantryItemsTool)
    .register(getDietaryProfileTool)
    .register(updateDietaryProfileTool);
}

/** Singleton used by the API route and the agent (K5). */
export const defaultToolRegistry = createDefaultToolRegistry();