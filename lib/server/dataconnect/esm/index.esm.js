import { validateAdminArgs } from 'firebase-admin/data-connect';

export const GroceryItemSource = {
  MANUAL: "MANUAL",
  PANTRY_DEPLETION: "PANTRY_DEPLETION",
  EXPIRATION: "EXPIRATION",
}

export const GroceryItemStatus = {
  OPEN: "OPEN",
  BOUGHT: "BOUGHT",
  DISMISSED: "DISMISSED",
}

export const LeftoverStatus = {
  ACTIVE: "ACTIVE",
  CONSUMED: "CONSUMED",
}

export const PantryItemSource = {
  VOICE: "VOICE",
  MANUAL: "MANUAL",
  RECIPE_USAGE: "RECIPE_USAGE",
  BARCODE: "BARCODE",
  VISION: "VISION",
  IMPORT: "IMPORT",
}

export const SessionEventType = {
  SESSION_STARTED: "SESSION_STARTED",
  INGREDIENT_ADDED: "INGREDIENT_ADDED",
  INGREDIENT_REMOVED: "INGREDIENT_REMOVED",
  INGREDIENT_CORRECTED: "INGREDIENT_CORRECTED",
  RECIPE_GENERATION_STARTED: "RECIPE_GENERATION_STARTED",
  RECIPE_GENERATED: "RECIPE_GENERATED",
  RECIPE_VALIDATED: "RECIPE_VALIDATED",
  RECIPE_VALIDATION_FAILED: "RECIPE_VALIDATION_FAILED",
  STEP_STARTED: "STEP_STARTED",
  STEP_COMPLETED: "STEP_COMPLETED",
  STEP_REPEATED: "STEP_REPEATED",
  STEP_REVERSED: "STEP_REVERSED",
  SESSION_PAUSED: "SESSION_PAUSED",
  SESSION_RESUMED: "SESSION_RESUMED",
  TIMER_STARTED: "TIMER_STARTED",
  TIMER_COMPLETED: "TIMER_COMPLETED",
  TIMER_CANCELLED: "TIMER_CANCELLED",
  SUBSTITUTION_REQUESTED: "SUBSTITUTION_REQUESTED",
  SUBSTITUTION_APPLIED: "SUBSTITUTION_APPLIED",
  SAFETY_WARNING_TRIGGERED: "SAFETY_WARNING_TRIGGERED",
  PANTRY_ITEM_CONFIRMED: "PANTRY_ITEM_CONFIRMED",
  ERROR_OCCURRED: "ERROR_OCCURRED",
  ERROR_RECOVERED: "ERROR_RECOVERED",
  SESSION_COMPLETED: "SESSION_COMPLETED",
  LEFTOVER_LOGGED: "LEFTOVER_LOGGED",
  GROCERY_ITEM_ADDED: "GROCERY_ITEM_ADDED",
  GROCERY_ITEM_REMOVED: "GROCERY_ITEM_REMOVED",
  GROCERY_ITEM_BOUGHT: "GROCERY_ITEM_BOUGHT",
  PANTRY_ITEM_EXPIRED: "PANTRY_ITEM_EXPIRED",
}

export const SessionPhase = {
  IDLE: "IDLE",
  COLLECTING_INGREDIENTS: "COLLECTING_INGREDIENTS",
  CONFIRMING_INGREDIENTS: "CONFIRMING_INGREDIENTS",
  COLLECTING_REQUIREMENTS: "COLLECTING_REQUIREMENTS",
  GENERATING_RECIPE: "GENERATING_RECIPE",
  VALIDATING_RECIPE: "VALIDATING_RECIPE",
  RECIPE_READY: "RECIPE_READY",
  PREP_GUIDANCE: "PREP_GUIDANCE",
  COOKING_GUIDANCE: "COOKING_GUIDANCE",
  PLATING: "PLATING",
  WAITING_FOR_TIMER: "WAITING_FOR_TIMER",
  PAUSED: "PAUSED",
  SUBSTITUTION_REQUIRED: "SUBSTITUTION_REQUIRED",
  USER_CORRECTION: "USER_CORRECTION",
  SAFETY_WARNING: "SAFETY_WARNING",
  COMPLETED: "COMPLETED",
  ERROR_RECOVERY: "ERROR_RECOVERY",
}

export const SessionStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  ERROR_RECOVERY: "ERROR_RECOVERY",
  ABANDONED: "ABANDONED",
}

export const TimerStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
}

export const connectorConfig = {
  connector: 'example',
  serviceId: 'cook-with-freebuff',
  location: 'us-central1'
};

export function insertRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertRecipe', inputVars, inputOpts);
}

export function saveRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('SaveRecipe', inputVars, inputOpts);
}

export function deleteRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteRecipe', inputVars, inputOpts);
}

export function insertCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertCookingSession', inputVars, inputOpts);
}

export function deleteCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteCookingSession', inputVars, inputOpts);
}

export function updateSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateSession', inputVars, inputOpts);
}

export function updateSessionWithMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateSessionWithMarker', inputVars, inputOpts);
}

export function insertSessionEvent(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertSessionEvent', inputVars, inputOpts);
}

export function insertCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertCookingTimer', inputVars, inputOpts);
}

export function updateCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateCookingTimer', inputVars, inputOpts);
}

export function rebaseTimers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('RebaseTimers', inputVars, inputOpts);
}

export function upsertPantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertPantryItem', inputVars, inputOpts);
}

export function deletePantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeletePantryItem', inputVars, inputOpts);
}

export function upsertLeftover(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertLeftover', inputVars, inputOpts);
}

export function upsertGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertGroceryItem', inputVars, inputOpts);
}

export function deleteGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteGroceryItem', inputVars, inputOpts);
}

export function upsertDietaryProfile(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertDietaryProfile', inputVars, inputOpts);
}

export function upsertDeployStatus(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertDeployStatus', inputVars, inputOpts);
}

export function insertAgentToolLog(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertAgentToolLog', inputVars, inputOpts);
}

export function upsertCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertCorrelationMarker', inputVars, inputOpts);
}

export function deleteCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteCorrelationMarker', inputVars, inputOpts);
}

export function getRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetRecipe', inputVars, inputOpts);
}

export function listRecipes(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListRecipes', inputVars, inputOpts);
}

export function getCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCookingSession', inputVars, inputOpts);
}

export function getActiveSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetActiveSession', inputVars, inputOpts);
}

export function getSessionEvents(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetSessionEvents', inputVars, inputOpts);
}

export function getCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCookingTimer', inputVars, inputOpts);
}

export function getActiveTimers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetActiveTimers', inputVars, inputOpts);
}

export function getPantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetPantryItem', inputVars, inputOpts);
}

export function getLeftover(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetLeftover', inputVars, inputOpts);
}

export function getGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetGroceryItem', inputVars, inputOpts);
}

export function listPantryItems(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListPantryItems', inputVars, inputOpts);
}

export function listLeftovers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListLeftovers', inputVars, inputOpts);
}

export function listGroceryItems(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListGroceryItems', inputVars, inputOpts);
}

export function getDietaryProfile(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetDietaryProfile', inputVars, inputOpts);
}

export function getDeployStatus(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetDeployStatus', inputVars, inputOpts);
}

export function getAgentToolLog(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetAgentToolLog', inputVars, inputOpts);
}

export function getCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCorrelationMarker', inputVars, inputOpts);
}

