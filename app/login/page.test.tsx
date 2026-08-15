// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { User } from 'firebase/auth';
import LoginPage from './page';
import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';

vi.mock('@/lib/auth/useAuthSession', () => ({
  useAuthSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

const mockAuth = vi.mocked(useAuthSession);
const signIn = vi.fn<() => Promise<void>>(async () => {});

const base: UseAuthSessionResult = {
  user: null,
  state: 'ready',
  error: null,
  signInHint: null,
  getToken: async () => null,
  signIn,
  signOut: vi.fn(async () => {}),
};

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
  signIn.mockClear();
  window.history.replaceState(null, '', '/login');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('app/login/page.tsx · ?retry=1 auto-retry', () => {
  it('auto-reopens the Google popup once when the page loads with ?retry=1', async () => {
    window.history.replaceState(null, '', '/login?retry=1');
    render(createElement(LoginPage));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    // The flag is cleared so a manual reload never re-triggers the popup.
    expect(window.location.search).not.toContain('retry');
  });

  it('does not auto-retry without the ?retry=1 flag', async () => {
    render(createElement(LoginPage));

    // The effect runs synchronously on mount; give async work a beat to be sure
    // nothing fired late, then assert the popup was never opened.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('does not auto-retry while auth is still settling (waits for ready)', async () => {
    mockAuth.mockReturnValue({ ...base, state: 'loading' });
    window.history.replaceState(null, '', '/login?retry=1');
    render(createElement(LoginPage));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('does not auto-retry when already signed in (the redirect handles it)', async () => {
    // On a ?retry=1 reload after a fast session restore, the user is already
    // signed in — the redirect effect sends them to /cook, and the auto-retry
    // effect must NOT open a second popup behind it.
    mockAuth.mockReturnValue({ ...base, user: { uid: 'u1' } as unknown as User });
    window.history.replaceState(null, '', '/login?retry=1');
    render(createElement(LoginPage));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('keeps the tap-to-retry hint (no scary error) when the auto-retry popup is blocked', async () => {
    // No transient user gesture survives the ?retry=1 navigation, so the
    // browser can block the popup. The page must keep the hint and NOT show a
    // "Sign-in was cancelled" alert — the user taps once instead.
    const blocked = Object.assign(new Error('Sign-in was cancelled.'), { code: 'auth/popup-blocked' });
    signIn.mockRejectedValueOnce(blocked);
    mockAuth.mockReturnValue({
      ...base,
      signInHint: 'Refreshed your sign-in session — tap Continue with Google to retry.',
    });
    window.history.replaceState(null, '', '/login?retry=1');
    render(createElement(LoginPage));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('tap Continue with Google to retry');
  });
});
