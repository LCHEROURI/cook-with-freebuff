const { validateAdminArgs } = require('firebase-admin/data-connect');

const GroceryItemSource = {
  MANUAL: "MANUAL",
  PANTRY_DEPLETION: "PANTRY_DEPLETION",
  EXPIRATION: "EXPIRATION",
}
exports.GroceryItemSource = GroceryItemSource;

const GroceryItemStatus = {
  OPEN: "OPEN",
  BOUGHT: "BOUGHT",
  DISMISSED: "DISMISSED",
}
exports.GroceryItemStatus = GroceryItemStatus;

const LeftoverStatus = {
  ACTIVE: "ACTIVE",
  CONSUMED: "CONSUMED",
}
exports.LeftoverStatus = LeftoverStatus;

const PantryItemSource = {
  VOICE: "VOICE",
  MANUAL: "MANUAL",
  RECIPE_USAGE: "RECIPE_USAGE",
  BARCODE: "BARCODE",
  VISION: "VISION",
  IMPORT: "IMPORT",
}
exports.PantryItemSource = PantryItemSource;

const SessionEventType = {
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
exports.SessionEventType = SessionEventType;

const SessionPhase = {
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
exports.SessionPhase = SessionPhase;

const SessionStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  ERROR_RECOVERY: "ERROR_RECOVERY",
  ABANDONED: "ABANDONED",
}
exports.SessionStatus = SessionStatus;

const TimerStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
}
exports.TimerStatus = TimerStatus;

const connectorConfig = {
  connector: 'example',
  serviceId: 'cook-with-freebuff',
  location: 'us-central1'
};
exports.connectorConfig = connectorConfig;

function insertRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertRecipe', inputVars, inputOpts);
}
exports.insertRecipe = insertRecipe;

function saveRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('SaveRecipe', inputVars, inputOpts);
}
exports.saveRecipe = saveRecipe;

function deleteRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteRecipe', inputVars, inputOpts);
}
exports.deleteRecipe = deleteRecipe;

function insertCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertCookingSession', inputVars, inputOpts);
}
exports.insertCookingSession = insertCookingSession;

function deleteCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteCookingSession', inputVars, inputOpts);
}
exports.deleteCookingSession = deleteCookingSession;

function updateSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateSession', inputVars, inputOpts);
}
exports.updateSession = updateSession;

function updateSessionWithMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateSessionWithMarker', inputVars, inputOpts);
}
exports.updateSessionWithMarker = updateSessionWithMarker;

function updateSessionWithTwoMarkers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateSessionWithTwoMarkers', inputVars, inputOpts);
}
exports.updateSessionWithTwoMarkers = updateSessionWithTwoMarkers;

function insertSessionEvent(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertSessionEvent', inputVars, inputOpts);
}
exports.insertSessionEvent = insertSessionEvent;

function insertCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertCookingTimer', inputVars, inputOpts);
}
exports.insertCookingTimer = insertCookingTimer;

function updateCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpdateCookingTimer', inputVars, inputOpts);
}
exports.updateCookingTimer = updateCookingTimer;

function rebaseTimers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('RebaseTimers', inputVars, inputOpts);
}
exports.rebaseTimers = rebaseTimers;

function upsertPantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertPantryItem', inputVars, inputOpts);
}
exports.upsertPantryItem = upsertPantryItem;

function deletePantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeletePantryItem', inputVars, inputOpts);
}
exports.deletePantryItem = deletePantryItem;

function upsertLeftover(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertLeftover', inputVars, inputOpts);
}
exports.upsertLeftover = upsertLeftover;

function upsertGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertGroceryItem', inputVars, inputOpts);
}
exports.upsertGroceryItem = upsertGroceryItem;

function deleteGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteGroceryItem', inputVars, inputOpts);
}
exports.deleteGroceryItem = deleteGroceryItem;

function upsertDietaryProfile(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertDietaryProfile', inputVars, inputOpts);
}
exports.upsertDietaryProfile = upsertDietaryProfile;

function upsertDeployStatus(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertDeployStatus', inputVars, inputOpts);
}
exports.upsertDeployStatus = upsertDeployStatus;

function insertAgentToolLog(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('InsertAgentToolLog', inputVars, inputOpts);
}
exports.insertAgentToolLog = insertAgentToolLog;

function upsertCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('UpsertCorrelationMarker', inputVars, inputOpts);
}
exports.upsertCorrelationMarker = upsertCorrelationMarker;

function deleteCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('DeleteCorrelationMarker', inputVars, inputOpts);
}
exports.deleteCorrelationMarker = deleteCorrelationMarker;

function getRecipe(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetRecipe', inputVars, inputOpts);
}
exports.getRecipe = getRecipe;

function listRecipes(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListRecipes', inputVars, inputOpts);
}
exports.listRecipes = listRecipes;

function getCookingSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCookingSession', inputVars, inputOpts);
}
exports.getCookingSession = getCookingSession;

function getActiveSession(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetActiveSession', inputVars, inputOpts);
}
exports.getActiveSession = getActiveSession;

function getSessionEvents(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetSessionEvents', inputVars, inputOpts);
}
exports.getSessionEvents = getSessionEvents;

function getCookingTimer(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCookingTimer', inputVars, inputOpts);
}
exports.getCookingTimer = getCookingTimer;

function getActiveTimers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetActiveTimers', inputVars, inputOpts);
}
exports.getActiveTimers = getActiveTimers;

function getPantryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetPantryItem', inputVars, inputOpts);
}
exports.getPantryItem = getPantryItem;

function getLeftover(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetLeftover', inputVars, inputOpts);
}
exports.getLeftover = getLeftover;

function getGroceryItem(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetGroceryItem', inputVars, inputOpts);
}
exports.getGroceryItem = getGroceryItem;

function listPantryItems(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListPantryItems', inputVars, inputOpts);
}
exports.listPantryItems = listPantryItems;

function listLeftovers(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListLeftovers', inputVars, inputOpts);
}
exports.listLeftovers = listLeftovers;

function listGroceryItems(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ListGroceryItems', inputVars, inputOpts);
}
exports.listGroceryItems = listGroceryItems;

function getDietaryProfile(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetDietaryProfile', inputVars, inputOpts);
}
exports.getDietaryProfile = getDietaryProfile;

function getDeployStatus(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetDeployStatus', inputVars, inputOpts);
}
exports.getDeployStatus = getDeployStatus;

function getAgentToolLog(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetAgentToolLog', inputVars, inputOpts);
}
exports.getAgentToolLog = getAgentToolLog;

function getCorrelationMarker(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('GetCorrelationMarker', inputVars, inputOpts);
}
exports.getCorrelationMarker = getCorrelationMarker;

