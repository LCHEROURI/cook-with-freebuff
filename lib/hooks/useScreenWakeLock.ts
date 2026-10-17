'use client';

import { useEffect, useRef, useState } from 'react';

export interface UseScreenWakeLockOptions {
  enabled?: boolean;
}

export interface UseScreenWakeLockReturn {
  supported: boolean;
  isLocked: boolean;
  request: () => Promise<boolean>;
  release: () => Promise<void>;
}

/**
 * Screen Wake Lock hook for mobile & kitchen use.
 * Keeps the display awake while a chef is actively cooking so they don't have
 * to touch the phone screen with wet or messy hands.
 *
 * Automatically re-acquires the lock if the user tabs away and returns, and
 * safely no-ops in unsupported browsers or during SSR.
 */
export function useScreenWakeLock(options: UseScreenWakeLockOptions = {}): UseScreenWakeLockReturn {
  const { enabled = false } = options;
  const [supported, setSupported] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'wakeLock' in navigator);
  }, []);

  const request = async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !('wakeLock' in navigator)) return false;
    try {
      if (sentinelRef.current && !sentinelRef.current.released) {
        return true;
      }
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setIsLocked(true);

      sentinel.addEventListener('release', () => {
        setIsLocked(false);
        sentinelRef.current = null;
      });
      return true;
    } catch {
      setIsLocked(false);
      sentinelRef.current = null;
      return false;
    }
  };

  const release = async (): Promise<void> => {
    if (sentinelRef.current && !sentinelRef.current.released) {
      try {
        await sentinelRef.current.release();
      } catch {
        // best effort release
      }
    }
    sentinelRef.current = null;
    setIsLocked(false);
  };

  // Re-acquire lock on visibility change (browser releases lock when minimized)
  useEffect(() => {
    if (!supported || !enabled) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && enabled) {
        await request();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [supported, enabled]);

  // Sync with enabled prop
  useEffect(() => {
    if (!supported) return;

    if (enabled) {
      void request();
    } else {
      void release();
    }

    return () => {
      void release();
    };
  }, [supported, enabled]);

  return { supported, isLocked, request, release };
}
