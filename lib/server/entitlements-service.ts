import 'server-only';

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import {
  TIER_LIMITS,
  type EntitlementCheckResult,
  type SubscriptionTier,
  type UserEntitlement,
} from '@/lib/domain/entitlements';

const COLLECTION = 'entitlements';
const CYCLE_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class EntitlementsService {
  constructor(private readonly getDb: () => Firestore | null = getAdminDb) {}

  /**
   * Fetch or initialize user entitlements. If the 30-day billing cycle has
   * rolled over, reset usage counters automatically.
   */
  async getEntitlement(userId: string): Promise<UserEntitlement> {
    const db = this.getDb();
    const now = Date.now();

    const defaultEntitlement: UserEntitlement = {
      userId,
      tier: 'free',
      status: 'active',
      usage: {
        voiceSecondsUsed: 0,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: now,
      },
      updatedAtMs: now,
    };

    if (!db) {
      // Memory fallback when Firestore is unavailable (e.g. initial setup)
      return defaultEntitlement;
    }

    const ref = db.collection(COLLECTION).doc(userId);
    const snap = await ref.get();

    if (!snap.exists) {
      await ref.set(defaultEntitlement);
      return defaultEntitlement;
    }

    const data = snap.data() as UserEntitlement;

    // Check if subscription has expired
    if (data.tier === 'pro' && data.expiresAtMs && data.expiresAtMs < now) {
      data.tier = 'free';
      data.status = 'past_due';
      await ref.update({
        tier: 'free',
        status: 'past_due',
        updatedAtMs: now,
      });
    }

    // Check if 30-day usage cycle needs to reset
    if (now - (data.usage?.cycleStartMs || 0) > CYCLE_DURATION_MS) {
      data.usage = {
        voiceSecondsUsed: 0,
        recipesGeneratedCount: 0,
        visionScansCount: 0,
        cycleStartMs: now,
      };
      data.updatedAtMs = now;
      await ref.update({
        usage: data.usage,
        updatedAtMs: now,
      });
    }

    return data;
  }

  /**
   * Check whether the user is permitted to start/continue a live voice session.
   */
  async checkVoiceQuota(userId: string, requestedSeconds: number = 60): Promise<EntitlementCheckResult> {
    const entitlement = await this.getEntitlement(userId);
    if (entitlement.tier === 'pro') {
      return { allowed: true, tier: 'pro', remaining: Infinity };
    }

    const limit = TIER_LIMITS.free.voiceSecondsPerCycle;
    const used = entitlement.usage.voiceSecondsUsed;
    const remaining = Math.max(0, limit - used);

    if (remaining < requestedSeconds) {
      return {
        allowed: false,
        tier: 'free',
        limit,
        remaining,
        reason: 'VOICE_QUOTA_EXCEEDED',
      };
    }

    return { allowed: true, tier: 'free', limit, remaining };
  }

  /**
   * Record voice seconds consumed by an active session.
   */
  async recordVoiceUsage(userId: string, seconds: number): Promise<void> {
    const db = this.getDb();
    if (!db || seconds <= 0) return;

    const ref = db.collection(COLLECTION).doc(userId);
    await ref.set(
      {
        'usage.voiceSecondsUsed': FieldValue.increment(seconds),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    );
  }

  /**
   * Check whether the user can generate an AI recipe.
   */
  async checkRecipeQuota(userId: string): Promise<EntitlementCheckResult> {
    const entitlement = await this.getEntitlement(userId);
    if (entitlement.tier === 'pro') {
      return { allowed: true, tier: 'pro', remaining: Infinity };
    }

    const limit = TIER_LIMITS.free.recipeGenerationsPerCycle;
    const used = entitlement.usage.recipesGeneratedCount;
    const remaining = Math.max(0, limit - used);

    if (remaining <= 0) {
      return {
        allowed: false,
        tier: 'free',
        limit,
        remaining: 0,
        reason: 'RECIPE_QUOTA_EXCEEDED',
      };
    }

    return { allowed: true, tier: 'free', limit, remaining };
  }

  /**
   * Record an AI recipe generation.
   */
  async recordRecipeGeneration(userId: string): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    const ref = db.collection(COLLECTION).doc(userId);
    await ref.set(
      {
        'usage.recipesGeneratedCount': FieldValue.increment(1),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    );
  }

  /**
   * Check whether the user can perform a fridge photo scan.
   */
  async checkVisionQuota(userId: string): Promise<EntitlementCheckResult> {
    const entitlement = await this.getEntitlement(userId);
    if (entitlement.tier === 'pro') {
      return { allowed: true, tier: 'pro', remaining: Infinity };
    }

    const limit = TIER_LIMITS.free.visionScansPerCycle;
    const used = entitlement.usage.visionScansCount;
    const remaining = Math.max(0, limit - used);

    if (remaining <= 0) {
      return {
        allowed: false,
        tier: 'free',
        limit,
        remaining: 0,
        reason: 'VISION_QUOTA_EXCEEDED',
      };
    }

    return { allowed: true, tier: 'free', limit, remaining };
  }

  /**
   * Record a photo scan.
   */
  async recordVisionScan(userId: string): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    const ref = db.collection(COLLECTION).doc(userId);
    await ref.set(
      {
        'usage.visionScansCount': FieldValue.increment(1),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    );
  }

  /**
   * Grant Pro entitlement upon verified purchase (Google Play / Web).
   */
  async upgradeToPro(
    userId: string,
    details: {
      platform: 'google_play' | 'web';
      purchaseToken?: string;
      orderId?: string;
      expiresAtMs?: number;
    },
  ): Promise<UserEntitlement> {
    const db = this.getDb();
    const now = Date.now();

    const updatePayload = {
      tier: 'pro' as SubscriptionTier,
      status: 'active' as const,
      platform: details.platform,
      purchaseToken: details.purchaseToken ?? null,
      orderId: details.orderId ?? null,
      expiresAtMs: details.expiresAtMs ?? null,
      updatedAtMs: now,
    };

    if (db) {
      const ref = db.collection(COLLECTION).doc(userId);
      await ref.set(updatePayload, { merge: true });
    }

    return this.getEntitlement(userId);
  }
}

export const entitlementsService = new EntitlementsService();
