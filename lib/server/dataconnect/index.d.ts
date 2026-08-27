import { ConnectorConfig, DataConnect, OperationOptions, ExecuteOperationResponse } from 'firebase-admin/data-connect';

export const connectorConfig: ConnectorConfig;

export type TimestampString = string;
export type UUIDString = string;
export type Int64String = string;
export type DateString = string;

export enum GroceryItemSource {
  MANUAL = "MANUAL",
  PANTRY_DEPLETION = "PANTRY_DEPLETION",
  EXPIRATION = "EXPIRATION",
}
export enum GroceryItemStatus {
  OPEN = "OPEN",
  BOUGHT = "BOUGHT",
  DISMISSED = "DISMISSED",
}
export enum LeftoverStatus {
  ACTIVE = "ACTIVE",
  CONSUMED = "CONSUMED",
}
export enum PantryItemSource {
  VOICE = "VOICE",
  MANUAL = "MANUAL",
  RECIPE_USAGE = "RECIPE_USAGE",
  BARCODE = "BARCODE",
  VISION = "VISION",
  IMPORT = "IMPORT",
}
export enum SessionEventType {
  SESSION_STARTED = "SESSION_STARTED",
  INGREDIENT_ADDED = "INGREDIENT_ADDED",
  INGREDIENT_REMOVED = "INGREDIENT_REMOVED",
  INGREDIENT_CORRECTED = "INGREDIENT_CORRECTED",
  RECIPE_GENERATION_STARTED = "RECIPE_GENERATION_STARTED",
  RECIPE_GENERATED = "RECIPE_GENERATED",
  RECIPE_VALIDATED = "RECIPE_VALIDATED",
  RECIPE_VALIDATION_FAILED = "RECIPE_VALIDATION_FAILED",
  STEP_STARTED = "STEP_STARTED",
  STEP_COMPLETED = "STEP_COMPLETED",
  STEP_REPEATED = "STEP_REPEATED",
  STEP_REVERSED = "STEP_REVERSED",
  SESSION_PAUSED = "SESSION_PAUSED",
  SESSION_RESUMED = "SESSION_RESUMED",
  TIMER_STARTED = "TIMER_STARTED",
  TIMER_COMPLETED = "TIMER_COMPLETED",
  TIMER_CANCELLED = "TIMER_CANCELLED",
  SUBSTITUTION_REQUESTED = "SUBSTITUTION_REQUESTED",
  SUBSTITUTION_APPLIED = "SUBSTITUTION_APPLIED",
  SAFETY_WARNING_TRIGGERED = "SAFETY_WARNING_TRIGGERED",
  PANTRY_ITEM_CONFIRMED = "PANTRY_ITEM_CONFIRMED",
  ERROR_OCCURRED = "ERROR_OCCURRED",
  ERROR_RECOVERED = "ERROR_RECOVERED",
  SESSION_COMPLETED = "SESSION_COMPLETED",
  LEFTOVER_LOGGED = "LEFTOVER_LOGGED",
  GROCERY_ITEM_ADDED = "GROCERY_ITEM_ADDED",
  GROCERY_ITEM_REMOVED = "GROCERY_ITEM_REMOVED",
  GROCERY_ITEM_BOUGHT = "GROCERY_ITEM_BOUGHT",
  PANTRY_ITEM_EXPIRED = "PANTRY_ITEM_EXPIRED",
}
export enum SessionPhase {
  IDLE = "IDLE",
  COLLECTING_INGREDIENTS = "COLLECTING_INGREDIENTS",
  CONFIRMING_INGREDIENTS = "CONFIRMING_INGREDIENTS",
  COLLECTING_REQUIREMENTS = "COLLECTING_REQUIREMENTS",
  GENERATING_RECIPE = "GENERATING_RECIPE",
  VALIDATING_RECIPE = "VALIDATING_RECIPE",
  RECIPE_READY = "RECIPE_READY",
  PREP_GUIDANCE = "PREP_GUIDANCE",
  COOKING_GUIDANCE = "COOKING_GUIDANCE",
  PLATING = "PLATING",
  WAITING_FOR_TIMER = "WAITING_FOR_TIMER",
  PAUSED = "PAUSED",
  SUBSTITUTION_REQUIRED = "SUBSTITUTION_REQUIRED",
  USER_CORRECTION = "USER_CORRECTION",
  SAFETY_WARNING = "SAFETY_WARNING",
  COMPLETED = "COMPLETED",
  ERROR_RECOVERY = "ERROR_RECOVERY",
}
export enum SessionStatus {
  ACTIVE = "ACTIVE",
  PAUSED = "PAUSED",
  COMPLETED = "COMPLETED",
  ERROR_RECOVERY = "ERROR_RECOVERY",
  ABANDONED = "ABANDONED",
}
export enum TimerStatus {
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export interface AgentToolLog_Key {
  id: string;
  __typename?: 'AgentToolLog_Key';
}

export interface CookingSessionEvent_Key {
  id: string;
  __typename?: 'CookingSessionEvent_Key';
}

export interface CookingSession_Key {
  id: string;
  __typename?: 'CookingSession_Key';
}

export interface CookingTimer_Key {
  id: string;
  __typename?: 'CookingTimer_Key';
}

export interface CorrelationMarker_Key {
  key: string;
  __typename?: 'CorrelationMarker_Key';
}

export interface DeleteCookingSessionData {
  cookingSession_delete?: CookingSession_Key | null;
}

export interface DeleteCookingSessionVariables {
  id: string;
}

export interface DeleteCorrelationMarkerData {
  correlationMarker_delete?: CorrelationMarker_Key | null;
}

export interface DeleteCorrelationMarkerVariables {
  key: string;
}

export interface DeleteGroceryItemData {
  groceryItem_delete?: GroceryItem_Key | null;
}

export interface DeleteGroceryItemVariables {
  id: string;
}

export interface DeletePantryItemData {
  pantryItem_delete?: PantryItem_Key | null;
}

export interface DeletePantryItemVariables {
  id: string;
}

export interface DeleteRecipeData {
  recipe_delete?: Recipe_Key | null;
}

export interface DeleteRecipeVariables {
  id: string;
}

export interface DeployStatus_Key {
  slot: string;
  __typename?: 'DeployStatus_Key';
}

export interface DietaryProfile_Key {
  userId: string;
  __typename?: 'DietaryProfile_Key';
}

export interface GetActiveSessionData {
  cookingSessions: ({
    id: string;
    userId: string;
    recipeId?: string | null;
    status: SessionStatus;
    currentPhase: SessionPhase;
    currentPrepStepIndex: number;
    currentCookingStepIndex: number;
    previousState?: unknown | null;
    resumableState?: unknown | null;
    activeTimerIds: string[];
    availableIngredients: unknown;
    recoveryContext?: unknown | null;
    pendingSubstitution?: string | null;
    pendingPantryItems?: unknown | null;
    startedAt: TimestampString;
    lastActivityAt: TimestampString;
    pausedAt?: TimestampString | null;
    completedAt?: TimestampString | null;
    version: number;
  } & CookingSession_Key)[];
}

export interface GetActiveSessionVariables {
  userId: string;
}

export interface GetActiveTimersData {
  cookingTimers: ({
    id: string;
    userId: string;
    sessionId: string;
    label: string;
    durationSeconds: number;
    startedAt: TimestampString;
    endsAt: TimestampString;
    status: TimerStatus;
    stepId?: string | null;
    completedAt?: TimestampString | null;
  } & CookingTimer_Key)[];
}

export interface GetActiveTimersVariables {
  sessionId: string;
}

export interface GetAgentToolLogData {
  agentToolLog?: {
    id: string;
    userId: string;
    sessionId?: string | null;
    tool: string;
    sanitizedArguments: unknown;
    result: unknown;
    latencyMs: number;
    at: TimestampString;
    correlationId?: string | null;
  } & AgentToolLog_Key;
}

export interface GetAgentToolLogVariables {
  id: string;
}

export interface GetCookingSessionData {
  cookingSession?: {
    id: string;
    userId: string;
    recipeId?: string | null;
    status: SessionStatus;
    currentPhase: SessionPhase;
    currentPrepStepIndex: number;
    currentCookingStepIndex: number;
    previousState?: unknown | null;
    resumableState?: unknown | null;
    activeTimerIds: string[];
    availableIngredients: unknown;
    recoveryContext?: unknown | null;
    pendingSubstitution?: string | null;
    pendingPantryItems?: unknown | null;
    startedAt: TimestampString;
    lastActivityAt: TimestampString;
    pausedAt?: TimestampString | null;
    completedAt?: TimestampString | null;
    version: number;
  } & CookingSession_Key;
}

export interface GetCookingSessionVariables {
  id: string;
}

export interface GetCookingTimerData {
  cookingTimer?: {
    id: string;
    userId: string;
    sessionId: string;
    label: string;
    durationSeconds: number;
    startedAt: TimestampString;
    endsAt: TimestampString;
    status: TimerStatus;
    stepId?: string | null;
    completedAt?: TimestampString | null;
  } & CookingTimer_Key;
}

export interface GetCookingTimerVariables {
  id: string;
}

export interface GetCorrelationMarkerData {
  correlationMarker?: {
    key: string;
    rawId: string;
    legacyRawId?: string | null;
    markedAt: TimestampString;
  } & CorrelationMarker_Key;
}

export interface GetCorrelationMarkerVariables {
  key: string;
}

export interface GetDeployStatusData {
  deployStatus?: {
    slot: string;
    verdict?: string | null;
    commitSha?: string | null;
    reason?: string | null;
    source?: string | null;
    recordedAt: TimestampString;
    active?: boolean | null;
    recurringCount?: number | null;
    signature?: string | null;
    weeks?: string[] | null;
    runUrl?: string | null;
  } & DeployStatus_Key;
}

export interface GetDeployStatusVariables {
  slot: string;
}

export interface GetDietaryProfileData {
  dietaryProfile?: {
    userId: string;
    allergies: string[];
    dietaryRestrictions: string[];
    dislikedIngredients: string[];
    preferredCuisines: string[];
    defaultServings?: number | null;
    preferredEquipment: string[];
    updatedAt: TimestampString;
  } & DietaryProfile_Key;
}

export interface GetDietaryProfileVariables {
  userId: string;
}

export interface GetGroceryItemData {
  groceryItem?: {
    id: string;
    userId: string;
    name: string;
    quantity?: number | null;
    unit?: string | null;
    source: GroceryItemSource;
    status: GroceryItemStatus;
    pantryItemId?: string | null;
    createdAt: TimestampString;
    updatedAt: TimestampString;
  } & GroceryItem_Key;
}

export interface GetGroceryItemVariables {
  id: string;
}

export interface GetLeftoverData {
  leftover?: {
    id: string;
    userId: string;
    recipeId?: string | null;
    title: string;
    servings: number;
    completedAt: TimestampString;
    storedAt: TimestampString;
    status: LeftoverStatus;
    notes?: string | null;
  } & Leftover_Key;
}

export interface GetLeftoverVariables {
  id: string;
}

export interface GetPantryItemData {
  pantryItem?: {
    id: string;
    userId: string;
    name: string;
    quantity?: number | null;
    unit?: string | null;
    confidence: number;
    source: PantryItemSource;
    lastConfirmedAt: TimestampString;
    expirationDate?: TimestampString | null;
    notes?: string | null;
  } & PantryItem_Key;
}

export interface GetPantryItemVariables {
  id: string;
}

export interface GetRecipeData {
  recipe?: {
    id: string;
    userId?: string | null;
    title: string;
    description?: string | null;
    servings: number;
    estimatedPrepMinutes: number;
    estimatedCookMinutes: number;
    totalMinutes: number;
    ingredients: unknown;
    prepSteps: unknown;
    cookingSteps: unknown;
    equipment: string[];
    dietaryTags: string[];
    allergens: string[];
    safetyNotes: string[];
    proteinCategories?: string[] | null;
    preferences?: unknown | null;
    generatedAt: TimestampString;
    updatedAt: TimestampString;
  } & Recipe_Key;
}

export interface GetRecipeVariables {
  id: string;
}

export interface GetSessionEventsData {
  cookingSessionEvents: ({
    id: string;
    sessionId: string;
    userId: string;
    type: SessionEventType;
    data: unknown;
    at: TimestampString;
    correlationId?: string | null;
  } & CookingSessionEvent_Key)[];
}

export interface GetSessionEventsVariables {
  sessionId: string;
}

export interface GroceryItem_Key {
  id: string;
  __typename?: 'GroceryItem_Key';
}

export interface InsertAgentToolLogData {
  agentToolLog_insert: AgentToolLog_Key;
}

export interface InsertAgentToolLogVariables {
  id: string;
  userId: string;
  sessionId?: string | null;
  tool: string;
  sanitizedArguments: unknown;
  result: unknown;
  latencyMs: number;
  at: TimestampString;
  correlationId?: string | null;
}

export interface InsertCookingSessionData {
  cookingSession_insert: CookingSession_Key;
}

export interface InsertCookingSessionVariables {
  id: string;
  userId: string;
  recipeId?: string | null;
  status: SessionStatus;
  currentPhase: SessionPhase;
  currentPrepStepIndex: number;
  currentCookingStepIndex: number;
  previousState?: unknown | null;
  resumableState?: unknown | null;
  activeTimerIds: string[];
  availableIngredients: unknown;
  recoveryContext?: unknown | null;
  pendingSubstitution?: string | null;
  pendingPantryItems?: unknown | null;
  startedAt: TimestampString;
  lastActivityAt: TimestampString;
  pausedAt?: TimestampString | null;
  completedAt?: TimestampString | null;
  version: number;
}

export interface InsertCookingTimerData {
  cookingTimer_insert: CookingTimer_Key;
}

export interface InsertCookingTimerVariables {
  id: string;
  userId: string;
  sessionId: string;
  label: string;
  durationSeconds: number;
  startedAt: TimestampString;
  endsAt: TimestampString;
  status: TimerStatus;
  stepId?: string | null;
  completedAt?: TimestampString | null;
}

export interface InsertRecipeData {
  recipe_insert: Recipe_Key;
}

export interface InsertRecipeVariables {
  id: string;
  userId?: string | null;
  title: string;
  description?: string | null;
  servings: number;
  estimatedPrepMinutes: number;
  estimatedCookMinutes: number;
  totalMinutes: number;
  ingredients: unknown;
  prepSteps: unknown;
  cookingSteps: unknown;
  equipment: string[];
  dietaryTags: string[];
  allergens: string[];
  safetyNotes: string[];
  proteinCategories?: string[] | null;
  preferences?: unknown | null;
  generatedAt: TimestampString;
  updatedAt: TimestampString;
}

export interface InsertSessionEventData {
  cookingSessionEvent_insert: CookingSessionEvent_Key;
}

export interface InsertSessionEventVariables {
  id: string;
  sessionId: string;
  userId: string;
  type: SessionEventType;
  data: unknown;
  at: TimestampString;
  correlationId?: string | null;
}

export interface Leftover_Key {
  id: string;
  __typename?: 'Leftover_Key';
}

export interface ListGroceryItemsData {
  groceryItems: ({
    id: string;
    userId: string;
    name: string;
    quantity?: number | null;
    unit?: string | null;
    source: GroceryItemSource;
    status: GroceryItemStatus;
    pantryItemId?: string | null;
    createdAt: TimestampString;
    updatedAt: TimestampString;
  } & GroceryItem_Key)[];
}

export interface ListGroceryItemsVariables {
  userId: string;
}

export interface ListLeftoversData {
  leftovers: ({
    id: string;
    userId: string;
    recipeId?: string | null;
    title: string;
    servings: number;
    completedAt: TimestampString;
    storedAt: TimestampString;
    status: LeftoverStatus;
    notes?: string | null;
  } & Leftover_Key)[];
}

export interface ListLeftoversVariables {
  userId: string;
}

export interface ListPantryItemsData {
  pantryItems: ({
    id: string;
    userId: string;
    name: string;
    quantity?: number | null;
    unit?: string | null;
    confidence: number;
    source: PantryItemSource;
    lastConfirmedAt: TimestampString;
    expirationDate?: TimestampString | null;
    notes?: string | null;
  } & PantryItem_Key)[];
}

export interface ListPantryItemsVariables {
  userId: string;
}

export interface ListRecipesData {
  recipes: ({
    id: string;
    userId?: string | null;
    title: string;
    description?: string | null;
    servings: number;
    estimatedPrepMinutes: number;
    estimatedCookMinutes: number;
    totalMinutes: number;
    ingredients: unknown;
    prepSteps: unknown;
    cookingSteps: unknown;
    equipment: string[];
    dietaryTags: string[];
    allergens: string[];
    safetyNotes: string[];
    proteinCategories?: string[] | null;
    preferences?: unknown | null;
    generatedAt: TimestampString;
    updatedAt: TimestampString;
  } & Recipe_Key)[];
}

export interface ListRecipesVariables {
  userId: string;
}

export interface PantryItem_Key {
  id: string;
  __typename?: 'PantryItem_Key';
}

export interface RebaseTimersData {
  rebaseTimers?: number | null;
}

export interface RebaseTimersVariables {
  sessionId: string;
  offsetMs: number;
}

export interface Recipe_Key {
  id: string;
  __typename?: 'Recipe_Key';
}

export interface SaveRecipeData {
  recipe_upsert: Recipe_Key;
}

export interface SaveRecipeVariables {
  id: string;
  userId?: string | null;
  title: string;
  description?: string | null;
  servings: number;
  estimatedPrepMinutes: number;
  estimatedCookMinutes: number;
  totalMinutes: number;
  ingredients: unknown;
  prepSteps: unknown;
  cookingSteps: unknown;
  equipment: string[];
  dietaryTags: string[];
  allergens: string[];
  safetyNotes: string[];
  proteinCategories?: string[] | null;
  preferences?: unknown | null;
  generatedAt: TimestampString;
  updatedAt: TimestampString;
}

export interface UpdateCookingTimerData {
  cookingTimer_update?: CookingTimer_Key | null;
}

export interface UpdateCookingTimerVariables {
  id: string;
  status?: TimerStatus | null;
  completedAt?: TimestampString | null;
  endsAt?: TimestampString | null;
}

export interface UpdateSessionData {
  session_ver?: CookingSession_Key | null;
}

export interface UpdateSessionVariables {
  id: string;
  expectedVersion: number;
  status?: SessionStatus | null;
  currentPhase?: SessionPhase | null;
  currentPrepStepIndex?: number | null;
  currentCookingStepIndex?: number | null;
  previousState?: unknown | null;
  resumableState?: unknown | null;
  activeTimerIds?: string[] | null;
  availableIngredients?: unknown | null;
  recoveryContext?: unknown | null;
  pendingSubstitution?: string | null;
  pendingPantryItems?: unknown | null;
  lastActivityAt?: TimestampString | null;
  pausedAt?: TimestampString | null;
  completedAt?: TimestampString | null;
}

export interface UpdateSessionWithMarkerData {
  session_ver?: CookingSession_Key | null;
  marker_write: CorrelationMarker_Key;
  marker_clear?: CorrelationMarker_Key | null;
}

export interface UpdateSessionWithMarkerVariables {
  id: string;
  expectedVersion: number;
  status?: SessionStatus | null;
  currentPhase?: SessionPhase | null;
  currentPrepStepIndex?: number | null;
  currentCookingStepIndex?: number | null;
  previousState?: unknown | null;
  resumableState?: unknown | null;
  activeTimerIds?: string[] | null;
  availableIngredients?: unknown | null;
  recoveryContext?: unknown | null;
  pendingSubstitution?: string | null;
  pendingPantryItems?: unknown | null;
  lastActivityAt?: TimestampString | null;
  pausedAt?: TimestampString | null;
  completedAt?: TimestampString | null;
  markerKey: string;
  markerRawId: string;
  markedAt: TimestampString;
  clearMarkerKey: string;
}

export interface UpsertCorrelationMarkerData {
  correlationMarker_upsert: CorrelationMarker_Key;
}

export interface UpsertCorrelationMarkerVariables {
  key: string;
  rawId: string;
  legacyRawId?: string | null;
  markedAt: TimestampString;
}

export interface UpsertDeployStatusData {
  deployStatus_upsert: DeployStatus_Key;
}

export interface UpsertDeployStatusVariables {
  slot: string;
  verdict?: string | null;
  commitSha?: string | null;
  reason?: string | null;
  source?: string | null;
  recordedAt: TimestampString;
  active?: boolean | null;
  recurringCount?: number | null;
  signature?: string | null;
  weeks?: string[] | null;
  runUrl?: string | null;
}

export interface UpsertDietaryProfileData {
  dietaryProfile_upsert: DietaryProfile_Key;
}

export interface UpsertDietaryProfileVariables {
  userId: string;
  allergies: string[];
  dietaryRestrictions: string[];
  dislikedIngredients: string[];
  preferredCuisines: string[];
  defaultServings?: number | null;
  preferredEquipment: string[];
  updatedAt: TimestampString;
}

export interface UpsertGroceryItemData {
  groceryItem_upsert: GroceryItem_Key;
}

export interface UpsertGroceryItemVariables {
  id: string;
  userId: string;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  source: GroceryItemSource;
  status: GroceryItemStatus;
  pantryItemId?: string | null;
  createdAt: TimestampString;
  updatedAt: TimestampString;
}

export interface UpsertLeftoverData {
  leftover_upsert: Leftover_Key;
}

export interface UpsertLeftoverVariables {
  id: string;
  userId: string;
  recipeId?: string | null;
  title: string;
  servings: number;
  completedAt: TimestampString;
  storedAt: TimestampString;
  status: LeftoverStatus;
  notes?: string | null;
}

export interface UpsertPantryItemData {
  pantryItem_upsert: PantryItem_Key;
}

export interface UpsertPantryItemVariables {
  id: string;
  userId: string;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  confidence: number;
  source: PantryItemSource;
  lastConfirmedAt: TimestampString;
  expirationDate?: TimestampString | null;
  notes?: string | null;
}

/** Generated Node Admin SDK operation action function for the 'InsertRecipe' Mutation. Allow users to execute without passing in DataConnect. */
export function insertRecipe(dc: DataConnect, vars: InsertRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertRecipeData>>;
/** Generated Node Admin SDK operation action function for the 'InsertRecipe' Mutation. Allow users to pass in custom DataConnect instances. */
export function insertRecipe(vars: InsertRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertRecipeData>>;

/** Generated Node Admin SDK operation action function for the 'SaveRecipe' Mutation. Allow users to execute without passing in DataConnect. */
export function saveRecipe(dc: DataConnect, vars: SaveRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<SaveRecipeData>>;
/** Generated Node Admin SDK operation action function for the 'SaveRecipe' Mutation. Allow users to pass in custom DataConnect instances. */
export function saveRecipe(vars: SaveRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<SaveRecipeData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteRecipe' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteRecipe(dc: DataConnect, vars: DeleteRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteRecipeData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteRecipe' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteRecipe(vars: DeleteRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteRecipeData>>;

/** Generated Node Admin SDK operation action function for the 'InsertCookingSession' Mutation. Allow users to execute without passing in DataConnect. */
export function insertCookingSession(dc: DataConnect, vars: InsertCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertCookingSessionData>>;
/** Generated Node Admin SDK operation action function for the 'InsertCookingSession' Mutation. Allow users to pass in custom DataConnect instances. */
export function insertCookingSession(vars: InsertCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertCookingSessionData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteCookingSession' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteCookingSession(dc: DataConnect, vars: DeleteCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteCookingSessionData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteCookingSession' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteCookingSession(vars: DeleteCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteCookingSessionData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateSession' Mutation. Allow users to execute without passing in DataConnect. */
export function updateSession(dc: DataConnect, vars: UpdateSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateSessionData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateSession' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateSession(vars: UpdateSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateSessionData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateSessionWithMarker' Mutation. Allow users to execute without passing in DataConnect. */
export function updateSessionWithMarker(dc: DataConnect, vars: UpdateSessionWithMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateSessionWithMarkerData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateSessionWithMarker' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateSessionWithMarker(vars: UpdateSessionWithMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateSessionWithMarkerData>>;

/** Generated Node Admin SDK operation action function for the 'InsertSessionEvent' Mutation. Allow users to execute without passing in DataConnect. */
export function insertSessionEvent(dc: DataConnect, vars: InsertSessionEventVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertSessionEventData>>;
/** Generated Node Admin SDK operation action function for the 'InsertSessionEvent' Mutation. Allow users to pass in custom DataConnect instances. */
export function insertSessionEvent(vars: InsertSessionEventVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertSessionEventData>>;

/** Generated Node Admin SDK operation action function for the 'InsertCookingTimer' Mutation. Allow users to execute without passing in DataConnect. */
export function insertCookingTimer(dc: DataConnect, vars: InsertCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertCookingTimerData>>;
/** Generated Node Admin SDK operation action function for the 'InsertCookingTimer' Mutation. Allow users to pass in custom DataConnect instances. */
export function insertCookingTimer(vars: InsertCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertCookingTimerData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateCookingTimer' Mutation. Allow users to execute without passing in DataConnect. */
export function updateCookingTimer(dc: DataConnect, vars: UpdateCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateCookingTimerData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateCookingTimer' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateCookingTimer(vars: UpdateCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateCookingTimerData>>;

/** Generated Node Admin SDK operation action function for the 'RebaseTimers' Mutation. Allow users to execute without passing in DataConnect. */
export function rebaseTimers(dc: DataConnect, vars: RebaseTimersVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<RebaseTimersData>>;
/** Generated Node Admin SDK operation action function for the 'RebaseTimers' Mutation. Allow users to pass in custom DataConnect instances. */
export function rebaseTimers(vars: RebaseTimersVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<RebaseTimersData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertPantryItem' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertPantryItem(dc: DataConnect, vars: UpsertPantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertPantryItemData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertPantryItem' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertPantryItem(vars: UpsertPantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertPantryItemData>>;

/** Generated Node Admin SDK operation action function for the 'DeletePantryItem' Mutation. Allow users to execute without passing in DataConnect. */
export function deletePantryItem(dc: DataConnect, vars: DeletePantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeletePantryItemData>>;
/** Generated Node Admin SDK operation action function for the 'DeletePantryItem' Mutation. Allow users to pass in custom DataConnect instances. */
export function deletePantryItem(vars: DeletePantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeletePantryItemData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertLeftover' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertLeftover(dc: DataConnect, vars: UpsertLeftoverVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertLeftoverData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertLeftover' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertLeftover(vars: UpsertLeftoverVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertLeftoverData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertGroceryItem' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertGroceryItem(dc: DataConnect, vars: UpsertGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertGroceryItemData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertGroceryItem' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertGroceryItem(vars: UpsertGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertGroceryItemData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteGroceryItem' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteGroceryItem(dc: DataConnect, vars: DeleteGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteGroceryItemData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteGroceryItem' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteGroceryItem(vars: DeleteGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteGroceryItemData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertDietaryProfile' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertDietaryProfile(dc: DataConnect, vars: UpsertDietaryProfileVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertDietaryProfileData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertDietaryProfile' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertDietaryProfile(vars: UpsertDietaryProfileVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertDietaryProfileData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertDeployStatus' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertDeployStatus(dc: DataConnect, vars: UpsertDeployStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertDeployStatusData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertDeployStatus' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertDeployStatus(vars: UpsertDeployStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertDeployStatusData>>;

/** Generated Node Admin SDK operation action function for the 'InsertAgentToolLog' Mutation. Allow users to execute without passing in DataConnect. */
export function insertAgentToolLog(dc: DataConnect, vars: InsertAgentToolLogVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertAgentToolLogData>>;
/** Generated Node Admin SDK operation action function for the 'InsertAgentToolLog' Mutation. Allow users to pass in custom DataConnect instances. */
export function insertAgentToolLog(vars: InsertAgentToolLogVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<InsertAgentToolLogData>>;

/** Generated Node Admin SDK operation action function for the 'UpsertCorrelationMarker' Mutation. Allow users to execute without passing in DataConnect. */
export function upsertCorrelationMarker(dc: DataConnect, vars: UpsertCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertCorrelationMarkerData>>;
/** Generated Node Admin SDK operation action function for the 'UpsertCorrelationMarker' Mutation. Allow users to pass in custom DataConnect instances. */
export function upsertCorrelationMarker(vars: UpsertCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpsertCorrelationMarkerData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteCorrelationMarker' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteCorrelationMarker(dc: DataConnect, vars: DeleteCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteCorrelationMarkerData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteCorrelationMarker' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteCorrelationMarker(vars: DeleteCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteCorrelationMarkerData>>;

/** Generated Node Admin SDK operation action function for the 'GetRecipe' Query. Allow users to execute without passing in DataConnect. */
export function getRecipe(dc: DataConnect, vars: GetRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetRecipeData>>;
/** Generated Node Admin SDK operation action function for the 'GetRecipe' Query. Allow users to pass in custom DataConnect instances. */
export function getRecipe(vars: GetRecipeVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetRecipeData>>;

/** Generated Node Admin SDK operation action function for the 'ListRecipes' Query. Allow users to execute without passing in DataConnect. */
export function listRecipes(dc: DataConnect, vars: ListRecipesVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListRecipesData>>;
/** Generated Node Admin SDK operation action function for the 'ListRecipes' Query. Allow users to pass in custom DataConnect instances. */
export function listRecipes(vars: ListRecipesVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListRecipesData>>;

/** Generated Node Admin SDK operation action function for the 'GetCookingSession' Query. Allow users to execute without passing in DataConnect. */
export function getCookingSession(dc: DataConnect, vars: GetCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCookingSessionData>>;
/** Generated Node Admin SDK operation action function for the 'GetCookingSession' Query. Allow users to pass in custom DataConnect instances. */
export function getCookingSession(vars: GetCookingSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCookingSessionData>>;

/** Generated Node Admin SDK operation action function for the 'GetActiveSession' Query. Allow users to execute without passing in DataConnect. */
export function getActiveSession(dc: DataConnect, vars: GetActiveSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetActiveSessionData>>;
/** Generated Node Admin SDK operation action function for the 'GetActiveSession' Query. Allow users to pass in custom DataConnect instances. */
export function getActiveSession(vars: GetActiveSessionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetActiveSessionData>>;

/** Generated Node Admin SDK operation action function for the 'GetSessionEvents' Query. Allow users to execute without passing in DataConnect. */
export function getSessionEvents(dc: DataConnect, vars: GetSessionEventsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetSessionEventsData>>;
/** Generated Node Admin SDK operation action function for the 'GetSessionEvents' Query. Allow users to pass in custom DataConnect instances. */
export function getSessionEvents(vars: GetSessionEventsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetSessionEventsData>>;

/** Generated Node Admin SDK operation action function for the 'GetCookingTimer' Query. Allow users to execute without passing in DataConnect. */
export function getCookingTimer(dc: DataConnect, vars: GetCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCookingTimerData>>;
/** Generated Node Admin SDK operation action function for the 'GetCookingTimer' Query. Allow users to pass in custom DataConnect instances. */
export function getCookingTimer(vars: GetCookingTimerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCookingTimerData>>;

/** Generated Node Admin SDK operation action function for the 'GetActiveTimers' Query. Allow users to execute without passing in DataConnect. */
export function getActiveTimers(dc: DataConnect, vars: GetActiveTimersVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetActiveTimersData>>;
/** Generated Node Admin SDK operation action function for the 'GetActiveTimers' Query. Allow users to pass in custom DataConnect instances. */
export function getActiveTimers(vars: GetActiveTimersVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetActiveTimersData>>;

/** Generated Node Admin SDK operation action function for the 'GetPantryItem' Query. Allow users to execute without passing in DataConnect. */
export function getPantryItem(dc: DataConnect, vars: GetPantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetPantryItemData>>;
/** Generated Node Admin SDK operation action function for the 'GetPantryItem' Query. Allow users to pass in custom DataConnect instances. */
export function getPantryItem(vars: GetPantryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetPantryItemData>>;

/** Generated Node Admin SDK operation action function for the 'GetLeftover' Query. Allow users to execute without passing in DataConnect. */
export function getLeftover(dc: DataConnect, vars: GetLeftoverVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetLeftoverData>>;
/** Generated Node Admin SDK operation action function for the 'GetLeftover' Query. Allow users to pass in custom DataConnect instances. */
export function getLeftover(vars: GetLeftoverVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetLeftoverData>>;

/** Generated Node Admin SDK operation action function for the 'GetGroceryItem' Query. Allow users to execute without passing in DataConnect. */
export function getGroceryItem(dc: DataConnect, vars: GetGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetGroceryItemData>>;
/** Generated Node Admin SDK operation action function for the 'GetGroceryItem' Query. Allow users to pass in custom DataConnect instances. */
export function getGroceryItem(vars: GetGroceryItemVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetGroceryItemData>>;

/** Generated Node Admin SDK operation action function for the 'ListPantryItems' Query. Allow users to execute without passing in DataConnect. */
export function listPantryItems(dc: DataConnect, vars: ListPantryItemsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListPantryItemsData>>;
/** Generated Node Admin SDK operation action function for the 'ListPantryItems' Query. Allow users to pass in custom DataConnect instances. */
export function listPantryItems(vars: ListPantryItemsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListPantryItemsData>>;

/** Generated Node Admin SDK operation action function for the 'ListLeftovers' Query. Allow users to execute without passing in DataConnect. */
export function listLeftovers(dc: DataConnect, vars: ListLeftoversVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListLeftoversData>>;
/** Generated Node Admin SDK operation action function for the 'ListLeftovers' Query. Allow users to pass in custom DataConnect instances. */
export function listLeftovers(vars: ListLeftoversVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListLeftoversData>>;

/** Generated Node Admin SDK operation action function for the 'ListGroceryItems' Query. Allow users to execute without passing in DataConnect. */
export function listGroceryItems(dc: DataConnect, vars: ListGroceryItemsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListGroceryItemsData>>;
/** Generated Node Admin SDK operation action function for the 'ListGroceryItems' Query. Allow users to pass in custom DataConnect instances. */
export function listGroceryItems(vars: ListGroceryItemsVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ListGroceryItemsData>>;

/** Generated Node Admin SDK operation action function for the 'GetDietaryProfile' Query. Allow users to execute without passing in DataConnect. */
export function getDietaryProfile(dc: DataConnect, vars: GetDietaryProfileVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetDietaryProfileData>>;
/** Generated Node Admin SDK operation action function for the 'GetDietaryProfile' Query. Allow users to pass in custom DataConnect instances. */
export function getDietaryProfile(vars: GetDietaryProfileVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetDietaryProfileData>>;

/** Generated Node Admin SDK operation action function for the 'GetDeployStatus' Query. Allow users to execute without passing in DataConnect. */
export function getDeployStatus(dc: DataConnect, vars: GetDeployStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetDeployStatusData>>;
/** Generated Node Admin SDK operation action function for the 'GetDeployStatus' Query. Allow users to pass in custom DataConnect instances. */
export function getDeployStatus(vars: GetDeployStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetDeployStatusData>>;

/** Generated Node Admin SDK operation action function for the 'GetAgentToolLog' Query. Allow users to execute without passing in DataConnect. */
export function getAgentToolLog(dc: DataConnect, vars: GetAgentToolLogVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetAgentToolLogData>>;
/** Generated Node Admin SDK operation action function for the 'GetAgentToolLog' Query. Allow users to pass in custom DataConnect instances. */
export function getAgentToolLog(vars: GetAgentToolLogVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetAgentToolLogData>>;

/** Generated Node Admin SDK operation action function for the 'GetCorrelationMarker' Query. Allow users to execute without passing in DataConnect. */
export function getCorrelationMarker(dc: DataConnect, vars: GetCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCorrelationMarkerData>>;
/** Generated Node Admin SDK operation action function for the 'GetCorrelationMarker' Query. Allow users to pass in custom DataConnect instances. */
export function getCorrelationMarker(vars: GetCorrelationMarkerVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetCorrelationMarkerData>>;

