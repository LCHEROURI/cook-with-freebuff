'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PRO_SUBSCRIPTION_SKU,
  type SubscriptionTier,
  type UserEntitlement,
} from '@/lib/domain/entitlements';
import { appCheckLimitedUseHeaders, appCheckHeaders } from '@/lib/firebase/app-check';

declare global {
  interface Window {
    getDigitalGoodsService?: (paymentMethod: string) => Promise<DigitalGoodsService | null>;
  }
}

export interface ItemDetails {
  itemId: string;
  title: string;
  description: string;
  price: { currency: string; value: string };
  subscriptionPeriod?: string;
  freeTrialPeriod?: string;
}

export interface DigitalGoodsService {
  getDetails(itemSkus: string[]): Promise<ItemDetails[]>;
  listPurchases(): Promise<{ itemId: string; purchaseToken: string }[]>;
}

export interface UsePlayBillingOptions {
  getToken?: () => Promise<string | null> | string | null;
  autoFetch?: boolean;
}

export interface UsePlayBillingReturn {
  isPlayBillingAvailable: boolean;
  isLoading: boolean;
  isPro: boolean;
  tier: SubscriptionTier;
  entitlement: UserEntitlement | null;
  error: string | null;
  refreshEntitlements: () => Promise<UserEntitlement | null>;
  purchaseSubscription: (sku?: string) => Promise<{ success: boolean; error?: string }>;
}

export function usePlayBilling(options: UsePlayBillingOptions = {}): UsePlayBillingReturn {
  const { getToken, autoFetch = true } = options;

  const [isPlayBillingAvailable, setIsPlayBillingAvailable] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [entitlement, setEntitlement] = useState<UserEntitlement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check whether Digital Goods API is available in this client (Android TWA / Play Store)
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.getDigitalGoodsService === 'function') {
      window
        .getDigitalGoodsService('https://play.google.com/billing')
        .then((service) => {
          setIsPlayBillingAvailable(!!service);
        })
        .catch(() => {
          setIsPlayBillingAvailable(false);
        });
    } else {
      setIsPlayBillingAvailable(false);
    }
  }, []);

  const refreshEntitlements = useCallback(async (): Promise<UserEntitlement | null> => {
    if (!getToken) return null;
    setIsLoading(true);
    setError(null);

    try {
      const idToken = await getToken();
      if (!idToken) {
        setIsLoading(false);
        return null;
      }

      const headers = {
        authorization: `Bearer ${idToken}`,
        ...(await appCheckHeaders()),
      };

      const res = await fetch('/api/billing', { method: 'GET', headers });
      const body = await res.json();

      if (res.ok && body.success) {
        setEntitlement(body.data);
        return body.data as UserEntitlement;
      } else {
        setError(body.error?.message ?? 'Failed to fetch entitlements');
        return null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (autoFetch && getToken) {
      void refreshEntitlements();
    }
  }, [autoFetch, getToken, refreshEntitlements]);

  const purchaseSubscription = useCallback(
    async (sku: string = PRO_SUBSCRIPTION_SKU): Promise<{ success: boolean; error?: string }> => {
      if (!getToken) {
        return { success: false, error: 'User is not authenticated' };
      }

      setIsLoading(true);
      setError(null);

      try {
        const idToken = await getToken();
        if (!idToken) {
          setIsLoading(false);
          return { success: false, error: 'User is not authenticated' };
        }

        // Check if browser has Digital Goods / Google Play payment method
        if (typeof window !== 'undefined' && typeof window.PaymentRequest === 'function' && isPlayBillingAvailable) {
          const paymentMethodData = [
            {
              supportedMethods: 'https://play.google.com/billing',
              data: { sku },
            },
          ];

          const details = {
            total: {
              label: 'Chef Pro Subscription',
              amount: { currency: 'USD', value: '4.99' },
            },
          };

          const request = new PaymentRequest(paymentMethodData, details);
          const paymentResponse = await request.show();
          const purchaseDetails = paymentResponse.details as { purchaseToken?: string; orderId?: string };

          if (!purchaseDetails?.purchaseToken) {
            await paymentResponse.complete('fail');
            setIsLoading(false);
            return { success: false, error: 'No purchase token received from Google Play' };
          }

          // Verify purchase token on backend
          const headers = {
            'content-type': 'application/json',
            authorization: `Bearer ${idToken}`,
            ...(await appCheckLimitedUseHeaders()),
          };

          const verifyRes = await fetch('/api/billing', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              action: 'verify_play_purchase',
              purchaseToken: purchaseDetails.purchaseToken,
              orderId: purchaseDetails.orderId,
            }),
          });

          const verifyData = await verifyRes.json();
          if (verifyRes.ok && verifyData.success) {
            await paymentResponse.complete('success');
            setEntitlement(verifyData.data);
            setIsLoading(false);
            return { success: true };
          } else {
            await paymentResponse.complete('fail');
            const errMsg = verifyData.error?.message ?? 'Purchase verification failed';
            setError(errMsg);
            setIsLoading(false);
            return { success: false, error: errMsg };
          }
        } else {
          // Play Billing not directly available in standard web view
          setIsLoading(false);
          const msg = 'Google Play Billing is available when running in the Cook With Me Android App.';
          setError(msg);
          return { success: false, error: msg };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Purchase failed';
        setError(msg);
        setIsLoading(false);
        return { success: false, error: msg };
      }
    },
    [getToken, isPlayBillingAvailable],
  );

  const isPro = entitlement?.tier === 'pro';
  const tier: SubscriptionTier = entitlement?.tier ?? 'free';

  return {
    isPlayBillingAvailable,
    isLoading,
    isPro,
    tier,
    entitlement,
    error,
    refreshEntitlements,
    purchaseSubscription,
  };
}
