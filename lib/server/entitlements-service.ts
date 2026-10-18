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

export interface QuotaReservationResult extends EntitlementCheckResult {
  rollback: () => Promise<void>;
  issuedSeconds?: number;
}

export class EntitlementsService {
  private inMemoryFallback = new Map<string, UserEntitlement>();

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
      const existing = this.inMemoryFallback.get(userId);
      if (!existing) {
        this.inMemoryFallback.set(userId, defaultEntitlement);
        return { ...defaultEntitlement, usage: { ...defaultEntitlement.usage } };
      }
      return { ...existing, usage: { ...existing.usage } };
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
   * Atomically reserve voice duration for a session before issuing a token.
   * Eliminates the check-then-mint race and guarantees free users cannot
   * repeatedly mint tokens past the 15-minute allowance.
   */
  async reserveVoiceQuota(userId: string, requestedSeconds: number = 300): Promise<QuotaReservationResult> {
    const db = this.getDb();
    const now = Date.now();

    if (!db) {
      const ent = await this.getEntitlement(userId);
      if (ent.tier === 'pro') {
        return { allowed: true, tier: 'pro', remaining: Infinity, issuedSeconds: requestedSeconds, rollback: async () => {} };
      }
      const limit = TIER_LIMITS.free.voiceSecondsPerCycle;
      const used = ent.usage.voiceSecondsUsed;
      const remaining = Math.max(0, limit - used);
      if (remaining <= 0) {
        return { allowed: false, tier: 'free', limit, remaining: 0, reason: 'VOICE_QUOTA_EXCEEDED', rollback: async () => {} };
      }
      const issued = Math.min(requestedSeconds, remaining);
      ent.usage.voiceSecondsUsed += issued;
      this.inMemoryFallback.set(userId, ent);
      return {
        allowed: true,
        tier: 'free',
        limit,
        remaining: remaining - issued,
        issuedSeconds: issued,
        rollback: async () => {
          ent.usage.voiceSecondsUsed = Math.max(0, ent.usage.voiceSecondsUsed - issued);
          this.inMemoryFallback.set(userId, ent);
        },
      };
    }

    const ref = db.collection(COLLECTION).doc(userId);

    const reservation = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      let data: UserEntitlement;

      if (!snap.exists) {
        data = {
          userId,
          tier: 'free',
          status: 'active',
          usage: { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now },
          updatedAtMs: now,
        };
        t.set(ref, data);
      } else {
        data = snap.data() as UserEntitlement;
      }

      // Check rollover
      if (now - (data.usage?.cycleStartMs || 0) > CYCLE_DURATION_MS) {
        data.usage = { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now };
      }

      if (data.tier === 'pro' && (!data.expiresAtMs || data.expiresAtMs > now)) {
        return { allowed: true, tier: 'pro' as const, remaining: Infinity, issuedSeconds: requestedSeconds };
      }

      const limit = TIER_LIMITS.free.voiceSecondsPerCycle;
      const used = data.usage?.voiceSecondsUsed || 0;
      const remaining = Math.max(0, limit - used);

      if (remaining <= 0) {
        return { allowed: false, tier: 'free' as const, limit, remaining: 0, reason: 'VOICE_QUOTA_EXCEEDED' as const };
      }

      const issued = Math.min(requestedSeconds, remaining);
      const newUsed = used + issued;

      t.update(ref, {
        'usage.voiceSecondsUsed': newUsed,
        'usage.cycleStartMs': data.usage.cycleStartMs,
        updatedAtMs: now,
      });

      return { allowed: true, tier: 'free' as const, limit, remaining: remaining - issued, issuedSeconds: issued };
    });

    return {
      ...reservation,
      rollback: async () => {
        if (!reservation.allowed || reservation.tier === 'pro' || !reservation.issuedSeconds) return;
        await ref.update({
          'usage.voiceSecondsUsed': FieldValue.increment(-reservation.issuedSeconds),
          updatedAtMs: Date.now(),
        });
      },
    };
  }

  /**
   * Atomically reserve quota before starting recipe generation.
   * Prevents parallel requests from bypassing the quota check.
   */
  async reserveRecipeQuota(userId: string): Promise<QuotaReservationResult> {
    const db = this.getDb();
    const now = Date.now();

    if (!db) {
      const ent = await this.getEntitlement(userId);
      if (ent.tier === 'pro') {
        return { allowed: true, tier: 'pro', remaining: Infinity, rollback: async () => {} };
      }
      const limit = TIER_LIMITS.free.recipeGenerationsPerCycle;
      const used = ent.usage.recipesGeneratedCount;
      const remaining = Math.max(0, limit - used);
      if (remaining <= 0) {
        return { allowed: false, tier: 'free', limit, remaining: 0, reason: 'RECIPE_QUOTA_EXCEEDED', rollback: async () => {} };
      }
      ent.usage.recipesGeneratedCount += 1;
      this.inMemoryFallback.set(userId, ent);
      return {
        allowed: true,
        tier: 'free',
        limit,
        remaining: remaining - 1,
        rollback: async () => {
          ent.usage.recipesGeneratedCount = Math.max(0, ent.usage.recipesGeneratedCount - 1);
          this.inMemoryFallback.set(userId, ent);
        },
      };
    }

    const ref = db.collection(COLLECTION).doc(userId);

    const reservation = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      let data: UserEntitlement;

      if (!snap.exists) {
        data = {
          userId,
          tier: 'free',
          status: 'active',
          usage: { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now },
          updatedAtMs: now,
        };
        t.set(ref, data);
      } else {
        data = snap.data() as UserEntitlement;
      }

      if (now - (data.usage?.cycleStartMs || 0) > CYCLE_DURATION_MS) {
        data.usage = { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now };
      }

      if (data.tier === 'pro' && (!data.expiresAtMs || data.expiresAtMs > now)) {
        return { allowed: true, tier: 'pro' as const, remaining: Infinity };
      }

      const limit = TIER_LIMITS.free.recipeGenerationsPerCycle;
      const used = data.usage?.recipesGeneratedCount || 0;
      const remaining = Math.max(0, limit - used);

      if (remaining <= 0) {
        return { allowed: false, tier: 'free' as const, limit, remaining: 0, reason: 'RECIPE_QUOTA_EXCEEDED' as const };
      }

      t.update(ref, {
        'usage.recipesGeneratedCount': used + 1,
        'usage.cycleStartMs': data.usage.cycleStartMs,
        updatedAtMs: now,
      });

      return { allowed: true, tier: 'free' as const, limit, remaining: remaining - 1 };
    });

    return {
      ...reservation,
      rollback: async () => {
        if (!reservation.allowed || reservation.tier === 'pro') return;
        await ref.update({
          'usage.recipesGeneratedCount': FieldValue.increment(-1),
          updatedAtMs: Date.now(),
        });
      },
    };
  }

  /**
   * Atomically reserve quota before starting a fridge photo scan.
   * Prevents parallel requests from bypassing the quota check.
   */
  async reserveVisionQuota(userId: string): Promise<QuotaReservationResult> {
    const db = this.getDb();
    const now = Date.now();

    if (!db) {
      const ent = await this.getEntitlement(userId);
      if (ent.tier === 'pro') {
        return { allowed: true, tier: 'pro', remaining: Infinity, rollback: async () => {} };
      }
      const limit = TIER_LIMITS.free.visionScansPerCycle;
      const used = ent.usage.visionScansCount;
      const remaining = Math.max(0, limit - used);
      if (remaining <= 0) {
        return { allowed: false, tier: 'free', limit, remaining: 0, reason: 'VISION_QUOTA_EXCEEDED', rollback: async () => {} };
      }
      ent.usage.visionScansCount += 1;
      this.inMemoryFallback.set(userId, ent);
      return {
        allowed: true,
        tier: 'free',
        limit,
        remaining: remaining - 1,
        rollback: async () => {
          ent.usage.visionScansCount = Math.max(0, ent.usage.visionScansCount - 1);
          this.inMemoryFallback.set(userId, ent);
        },
      };
    }

    const ref = db.collection(COLLECTION).doc(userId);

    const reservation = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      let data: UserEntitlement;

      if (!snap.exists) {
        data = {
          userId,
          tier: 'free',
          status: 'active',
          usage: { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now },
          updatedAtMs: now,
        };
        t.set(ref, data);
      } else {
        data = snap.data() as UserEntitlement;
      }

      if (now - (data.usage?.cycleStartMs || 0) > CYCLE_DURATION_MS) {
        data.usage = { voiceSecondsUsed: 0, recipesGeneratedCount: 0, visionScansCount: 0, cycleStartMs: now };
      }

      if (data.tier === 'pro' && (!data.expiresAtMs || data.expiresAtMs > now)) {
        return { allowed: true, tier: 'pro' as const, remaining: Infinity };
      }

      const limit = TIER_LIMITS.free.visionScansPerCycle;
      const used = data.usage?.visionScansCount || 0;
      const remaining = Math.max(0, limit - used);

      if (remaining <= 0) {
        return { allowed: false, tier: 'free' as const, limit, remaining: 0, reason: 'VISION_QUOTA_EXCEEDED' as const };
      }

      t.update(ref, {
        'usage.visionScansCount': used + 1,
        'usage.cycleStartMs': data.usage.cycleStartMs,
        updatedAtMs: now,
      });

      return { allowed: true, tier: 'free' as const, limit, remaining: remaining - 1 };
    });

    return {
      ...reservation,
      rollback: async () => {
        if (!reservation.allowed || reservation.tier === 'pro') return;
        await ref.update({
          'usage.visionScansCount': FieldValue.increment(-1),
          updatedAtMs: Date.now(),
        });
      },
    };
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
   * Record voice seconds consumed by an active session using true nested field update.
   */
  async recordVoiceUsage(userId: string, seconds: number): Promise<void> {
    const db = this.getDb();
    if (!db || seconds <= 0) return;

    await this.getEntitlement(userId);
    const ref = db.collection(COLLECTION).doc(userId);
    await ref.update({
      'usage.voiceSecondsUsed': FieldValue.increment(seconds),
      updatedAtMs: Date.now(),
    });
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
   * Record an AI recipe generation using true nested field update.
   */
  async recordRecipeGeneration(userId: string): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    await this.getEntitlement(userId);
    const ref = db.collection(COLLECTION).doc(userId);
    await ref.update({
      'usage.recipesGeneratedCount': FieldValue.increment(1),
      updatedAtMs: Date.now(),
    });
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
   * Record a photo scan using true nested field update.
   */
  async recordVisionScan(userId: string): Promise<void> {
    const db = this.getDb();
    if (!db) return;

    await this.getEntitlement(userId);
    const ref = db.collection(COLLECTION).doc(userId);
    await ref.update({
      'usage.visionScansCount': FieldValue.increment(1),
      updatedAtMs: Date.now(),
    });
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
      await this.getEntitlement(userId);
      const ref = db.collection(COLLECTION).doc(userId);
      await ref.update(updatePayload);
    } else {
      const existing = await this.getEntitlement(userId);
      const updated: UserEntitlement = {
        ...existing,
        tier: 'pro',
        status: 'active',
        platform: details.platform,
        purchaseToken: details.purchaseToken,
        orderId: details.orderId,
        expiresAtMs: details.expiresAtMs,
        updatedAtMs: now,
      };
      this.inMemoryFallback.set(userId, updated);
    }

    return this.getEntitlement(userId);
  }
}

export const entitlementsService = new EntitlementsService();
