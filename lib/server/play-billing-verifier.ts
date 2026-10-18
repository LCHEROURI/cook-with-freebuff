import 'server-only';

import { GoogleAuth } from 'google-auth-library';
import { PRO_SUBSCRIPTION_SKU } from '@/lib/domain/entitlements';
import { logError } from '@/lib/server/logger';

const DEFAULT_PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.freebuff.cookwithme';

export interface PlayPurchaseVerificationResult {
  valid: boolean;
  orderId?: string;
  expiresAtMs?: number;
  productId?: string;
  error?: string;
}

export type PlayPurchaseVerifierFn = (params: {
  purchaseToken: string;
  subscriptionId?: string;
  packageName?: string;
}) => Promise<PlayPurchaseVerificationResult>;

/**
 * Verifies an Android Google Play subscription purchase token using
 * the Google Play Developer API (purchases.subscriptionsv2.get).
 *
 * Rejects forged, fabricated, expired, or non-matching tokens.
 */
export async function defaultPlayPurchaseVerifier(params: {
  purchaseToken: string;
  subscriptionId?: string;
  packageName?: string;
}): Promise<PlayPurchaseVerificationResult> {
  const { purchaseToken } = params;
  const packageName = params.packageName || DEFAULT_PACKAGE_NAME;
  const expectedSku = params.subscriptionId || PRO_SUBSCRIPTION_SKU;

  // Strict format check — Play purchase tokens are long base64/alphanumeric strings
  if (!purchaseToken || typeof purchaseToken !== 'string' || purchaseToken.length < 20 || purchaseToken.length > 5000) {
    return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
  }

  // Reject fabricated dev/test tokens in production
  if (purchaseToken.startsWith('dev_token_') || purchaseToken.includes('fake') || purchaseToken.includes('test_token')) {
    if (process.env.NODE_ENV === 'test' && process.env.ALLOW_MOCK_PLAY_BILLING === '1') {
      return {
        valid: true,
        orderId: `MOCK_GPA.${Date.now()}`,
        expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
        productId: expectedSku,
      };
    }
    return { valid: false, error: 'FORBIDDEN_TEST_TOKEN' };
  }

  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken = accessTokenResponse.token;

    if (!accessToken) {
      logError('play.billing.auth_failed', { message: 'Could not obtain Google Play access token' });
      return { valid: false, error: 'PLAY_SERVICE_UNAVAILABLE' };
    }

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName,
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      logError('play.billing.verify_failed', { status: res.status, error: errText.slice(0, 300) });
      return { valid: false, error: 'PURCHASE_VERIFICATION_REJECTED' };
    }

    const data = (await res.json()) as {
      subscriptionState?: string;
      lineItems?: Array<{
        productId?: string;
        expiryTime?: string;
      }>;
      latestOrderId?: string;
    };

    // Valid states: ACTIVE or IN_GRACE_PERIOD
    const activeStates = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];
    if (!data.subscriptionState || !activeStates.includes(data.subscriptionState)) {
      return { valid: false, error: `SUBSCRIPTION_INACTIVE:${data.subscriptionState ?? 'UNKNOWN'}` };
    }

    // Ensure product matches expected SKU
    const item = data.lineItems?.find((i) => i.productId === expectedSku);
    if (!item) {
      return { valid: false, error: 'PRODUCT_ID_MISMATCH' };
    }

    const expiresAtMs = item.expiryTime ? new Date(item.expiryTime).getTime() : undefined;
    if (expiresAtMs && expiresAtMs <= Date.now()) {
      return { valid: false, error: 'SUBSCRIPTION_EXPIRED' };
    }

    return {
      valid: true,
      orderId: data.latestOrderId,
      expiresAtMs,
      productId: item.productId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during Play verification';
    logError('play.billing.verify_exception', { error: message });
    return { valid: false, error: 'PLAY_VERIFICATION_ERROR' };
  }
}

let activeVerifier: PlayPurchaseVerifierFn = defaultPlayPurchaseVerifier;

export function setPlayPurchaseVerifier(verifier: PlayPurchaseVerifierFn): void {
  activeVerifier = verifier;
}

export function resetPlayPurchaseVerifier(): void {
  activeVerifier = defaultPlayPurchaseVerifier;
}

export async function verifyPlayPurchase(params: {
  purchaseToken: string;
  subscriptionId?: string;
  packageName?: string;
}): Promise<PlayPurchaseVerificationResult> {
  return activeVerifier(params);
}
