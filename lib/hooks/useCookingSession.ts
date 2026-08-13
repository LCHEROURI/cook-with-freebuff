'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuideSnapshot } from '@/lib/domain/guide';

export interface CookApiResponse {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export interface UseCookingSessionOptions {
  endpoint?: string;
  getToken?: () => Promise<string | null> | string | null;
  /** Poll cadence for timer checks (ms). Default 3000. */
  pollMs?: number;
}

/**
 * Drives the "Cook With Me" screen. Polls the backend for finished timers
 * (which also recovers WAITING_FOR_TIMER sessions) and exposes the single
 * current action plus the Previous / Repeat / Done controls.
 */
export function useCookingSession(opts: UseCookingSessionOptions = {}) {
  const endpoint = opts.endpoint ?? '/api/cook';
  const pollMs = opts.pollMs ?? 3000;

  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const tokenRef = useRef(opts.getToken);

  useEffect(() => {
    tokenRef.current = opts.getToken;
  }, [opts.getToken]);

  const call = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const token = tokenRef.current ? await tokenRef.current() : null;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = (await res.json()) as CookApiResponse;
      if (!body.success || !body.data) {
        throw new Error(body.error?.message ?? `Cook request failed: ${res.status}`);
      }
      return body.data as GuideSnapshot;
    },
    [endpoint],
  );

  const refresh = useCallback(async () => {
    try {
      const snap = await call('status');
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the cooking session');
    } finally {
      setLoading(false);
    }
  }, [call]);

  const checkTimers = useCallback(async () => {
    try {
      const data = (await call('timers')) as unknown as { alerts: { message: string }[]; snapshot: GuideSnapshot };
      if (data.alerts.length > 0) {
        setAlert(data.alerts.map((a) => a.message).join(' '));
      }
      setSnapshot(data.snapshot);
      setError(null);
    } catch {
      // Poll failures are silent — the next poll retries.
    }
  }, [call]);

  const launch = useCallback(
    async (recipeId: string) => {
      setLoading(true);
      try {
        const snap = await call('launch', { recipeId });
        setSnapshot(snap);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start cooking');
      } finally {
        setLoading(false);
      }
    },
    [call],
  );

  const act = useCallback(
    async (action: 'done' | 'repeat' | 'back' | 'pause' | 'resume') => {
      try {
        const snap = await call(action);
        setSnapshot(snap);
        setError(null);
        if (action === 'done' && snap.timerStarted) {
          setAlert(`I've started a ${snap.timerStarted.label}.`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed');
      }
    },
    [call],
  );

  /**
   * Start over: archives the current session (ABANDONED) and launches a fresh
   * one pinned to the same recipe, from prep step 1. The screen swaps to the
   * new session's snapshot immediately — no reload needed.
   */
  const startOver = useCallback(async () => {
    try {
      const snap = await call('start_over');
      setSnapshot(snap);
      setError(null);
      setAlert(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restart cooking');
    }
  }, [call]);

  // Initial load + timer polling.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void checkTimers();
    }, pollMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  const dismissAlert = useCallback(() => setAlert(null), []);

  return {
    snapshot,
    loading,
    error,
    alert,
    dismissAlert,
    launch,
    done: () => act('done'),
    repeat: () => act('repeat'),
    back: () => act('back'),
    pause: () => act('pause'),
    resume: () => act('resume'),
    startOver,
    refresh,
  };
}
