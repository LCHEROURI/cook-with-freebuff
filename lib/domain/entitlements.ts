// ─────────────────────────────────────────────────────────────────────────────
// User Entitlements & Subscription Tiers (Google Play & Web)
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionTier = 'free' | 'pro';
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trial';

export interface TierLimits {
  voiceSecondsPerCycle: number;
  recipeGenerationsPerCycle: number;
  visionScansPerCycle: number;
  maxSavedRecipes: number;
  maxConcurrentTimers: number;
}

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    voiceSecondsPerCycle: 15 * 60, // 15 minutes of Gemini Live
    recipeGenerationsPerCycle: 5,  // 5 AI recipe generations
    visionScansPerCycle: 3,        // 3 fridge photo scans
    maxSavedRecipes: 10,
    maxConcurrentTimers: 1,
  },
  pro: {
    voiceSecondsPerCycle: Infinity,
    recipeGenerationsPerCycle: Infinity,
    visionScansPerCycle: Infinity,
    maxSavedRecipes: Infinity,
    maxConcurrentTimers: Infinity,
  },
};

export interface UserUsage {
  voiceSecondsUsed: number;
  recipesGeneratedCount: number;
  visionScansCount: number;
  cycleStartMs: number;
}

export interface UserEntitlement {
  userId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  isOwner?: boolean;
  platform?: 'google_play' | 'web';
  purchaseToken?: string;
  orderId?: string;
  expiresAtMs?: number;
  activeProbeRunId?: string;
  usage: UserUsage;
  updatedAtMs: number;
}

export interface EntitlementCheckResult {
  allowed: boolean;
  tier: SubscriptionTier;
  remaining?: number;
  limit?: number;
  reason?: 'VOICE_QUOTA_EXCEEDED' | 'RECIPE_QUOTA_EXCEEDED' | 'VISION_QUOTA_EXCEEDED' | 'UPGRADE_REQUIRED';
}

export const PRO_SUBSCRIPTION_SKU = 'chef_pro_monthly';

