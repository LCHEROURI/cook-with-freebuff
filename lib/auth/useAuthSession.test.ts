// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthSession } from './useAuthSession';
import { SignInError, SIGN_IN_RETRY_HINT, signInWithGoogle } from './session';

// ============================================================================
// lib/auth/useAuthSession.test.ts — lock the pre-auth 401 race fix.
//
// The API routes reject with 401 unless the request carries a Bearer ID token,
// and the Firebase SDK restores the session from IndexedDB asynchronously
// (auth.currentUser is null until onAuthStateChanged fires). If getToken()
// reads currentUser before that settle, the first /api/cook + /api/agent
// calls fire tokenless and 401 on every signed-in page load — the benign
// pre-auth race the Playwright recon caught. getToken() must await the
// settle, so every data hook that funnels through it carries a real token on
// the first call.
// ============================================================================

const mockOnAuthStateChanged = vi.fn<(auth: unknown, onUser: (u: unknown) => void) => () => void>();
const mockGetIdToken = vi.fn<(user: unknown) => Promise<string>>(async () => 'id-token');
const mockGetClientAuth = vi.fn<() => unknown>();

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (auth: unknown, onUser: (u: unknown) => void) => mockOnAuthStateChanged(auth, onUser),
  getIdToken: (user: unknown) => mockGetIdToken(user),
}));

vi.mock('@/lib/firebase/client', () => ({
  getClientAuth: () => mockGetClientAuth(),
}));

vi.mock('./session', () => {
  class MockSignInError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
      this.name = 'SignInError';
    }
  }
  return {
    authErrorMessage: (code?: string) => (code ? `mapped: ${code}` : 'Could not sign in.'),
    SignInError: MockSignInError,
    SIGN_IN_RETRY_HINT: 'Refreshed your sign-in session — tap Continue with Google to retry.',
    signInWithGoogle: vi.fn(),
    signOutFirebase: vi.fn(async () => {}),
  };
});

const mockSignInWithGoogle = vi.mocked(signInWithGoogle);

// A fake Auth object whose currentUser the test flips after the settle fires,
// exactly like the real SDK does when it finishes restoring from IndexedDB.
function makeAuth() {
  let currentUser: unknown = null;
  const auth = {
    get currentUser() {
      return currentUser;
    },
  };
  return {
    auth,
    setUser: (u: unknown) => {
      currentUser = u;
    },
  };
}

let listener: ((user: unknown) => void) | null = null;
let authHolder: ReturnType<typeof makeAuth> | null = null;

beforeEach(() => {
  listener = null;
  authHolder = makeAuth();
  mockGetClientAuth.mockReturnValue(authHolder.auth);
  mockOnAuthStateChanged.mockImplementation((_auth: unknown, onUser: (u: unknown) => void) => {
    listener = onUser;
    return () => {
      listener = null;
    };
  });
  mockGetIdToken.mockClear();
  mockSignInWithGoogle.mockReset();
  window.sessionStorage.clear();
});

describe('useAuthSession · getToken awaits the auth settle', () => {
  it('does not resolve a token before onAuthStateChanged fires (the 401 race)', async () => {
    const { result } = renderHook(() => useAuthSession());
    expect(mockOnAuthStateChanged).toHaveBeenCalledTimes(1);

    let resolved = false;
    const pending = result.current.getToken().then((t) => {
      resolved = true;
      return t;
    });

    // The SDK has NOT settled yet — a tokenless fetch would be about to 401.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now the SDK finishes restoring the session.
    authHolder!.setUser({ uid: 'u1' });
    await act(async () => {
      listener?.({ uid: 'u1' });
      await pending;
    });
    expect(resolved).toBe(true);
    expect(mockGetIdToken).toHaveBeenCalledTimes(1);
  });

  it('returns null once auth settles with no user (signed out)', async () => {
    const { result } = renderHook(() => useAuthSession());
    let token: string | null = 'unresolved';
    const pending = result.current.getToken().then((t) => {
      token = t;
      return t;
    });

    await act(async () => {
      listener?.(null);
      await pending;
    });
    expect(token).toBeNull();
    expect(mockGetIdToken).not.toHaveBeenCalled();
  });

  it('resolves quickly for later calls after the settle already happened', async () => {
    const { result } = renderHook(() => useAuthSession());
    authHolder!.setUser({ uid: 'u1' });
    await act(async () => {
      listener?.({ uid: 'u1' });
    });

    const token = await result.current.getToken();
    expect(token).toBe('id-token');
    expect(mockGetIdToken).toHaveBeenCalledTimes(1);
  });
});

describe('useAuthSession · unauthorized-domain reload retry', () => {
  let reload: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    reload = vi.fn();
    // jsdom's location.reload is non-configurable, so spyOn can't redefine
    // it. Swap the whole location object for a spy-able one, then restore it.
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('reloads once instead of dead-ending on the first auth/unauthorized-domain', async () => {
    const { result } = renderHook(() => useAuthSession());
    mockSignInWithGoogle.mockRejectedValueOnce(new SignInError('blocked', 'auth/unauthorized-domain'));

    await act(async () => {
      await result.current.signIn();
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('cook-freebuff:auth:unauthorized-domain-reloaded')).toBe('1');
  });

  it('surfaces the error (never re-reloads) on a second unauthorized-domain in the same tab session', async () => {
    window.sessionStorage.setItem('cook-freebuff:auth:unauthorized-domain-reloaded', '1');
    const { result } = renderHook(() => useAuthSession());
    mockSignInWithGoogle.mockRejectedValueOnce(new SignInError('blocked', 'auth/unauthorized-domain'));

    await act(async () => {
      await expect(result.current.signIn()).rejects.toThrow('blocked');
    });

    expect(reload).not.toHaveBeenCalled();
  });

  it('surfaces the retry hint when the page mounts with the reload marker set', () => {
    window.sessionStorage.setItem('cook-freebuff:auth:unauthorized-domain-reloaded', '1');
    const { result } = renderHook(() => useAuthSession());

    expect(result.current.signInHint).toBe(SIGN_IN_RETRY_HINT);
  });

  it('clears the marker + hint once a user signs in (no stale hint on a later visit)', async () => {
    window.sessionStorage.setItem('cook-freebuff:auth:unauthorized-domain-reloaded', '1');
    const { result } = renderHook(() => useAuthSession());
    expect(result.current.signInHint).toBe(SIGN_IN_RETRY_HINT);

    await act(async () => {
      listener?.({ uid: 'u1' });
    });

    expect(window.sessionStorage.getItem('cook-freebuff:auth:unauthorized-domain-reloaded')).toBeNull();
    expect(result.current.signInHint).toBeNull();
  });
});
