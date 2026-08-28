// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthSession } from './useAuthSession';
import { SignInError, SIGN_IN_RETRY_HINT, SIGN_IN_STILL_BLOCKED, signInWithGoogle } from './session';

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
    SIGN_IN_STILL_BLOCKED: 'Still blocked after a refresh.',
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

afterEach(() => {
  vi.useRealTimers();
});

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
  mockOnAuthStateChanged.mockClear();
  mockGetIdToken.mockClear();
  mockSignInWithGoogle.mockReset();
  window.sessionStorage.clear();
});

describe('useAuthSession · initialization timeout', () => {
  it('surfaces an actionable error when Firebase never settles', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAuthSession());

    expect(result.current.state).toBe('loading');
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toContain('taking too long');
    unmount();
  });

  it('accepts a successful Firebase callback that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAuthSession());

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(result.current.state).toBe('error');

    authHolder!.setUser({ uid: 'late-user' });
    await act(async () => {
      listener?.({ uid: 'late-user' });
    });

    expect(result.current.state).toBe('ready');
    expect(result.current.user).toEqual({ uid: 'late-user' });
    expect(result.current.error).toBeNull();
    unmount();
  });
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
  let replace: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    replace = vi.fn();
    // jsdom's location methods are non-configurable, so spyOn can't redefine
    // them. Swap the whole location object for a spy-able one, then restore it.
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, replace },
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

  it('navigates to ?retry=1 once instead of dead-ending on the first auth/unauthorized-domain', async () => {
    const { result } = renderHook(() => useAuthSession());
    mockSignInWithGoogle.mockRejectedValueOnce(new SignInError('blocked', 'auth/unauthorized-domain'));

    await act(async () => {
      await result.current.signIn();
    });

    expect(replace).toHaveBeenCalledTimes(1);
    // The retry always routes to /login (the page that consumes the flag),
    // never the current path — /status also signs in through this hook.
    expect(String(replace.mock.calls[0][0])).toContain('/login?retry=1');
    expect(window.sessionStorage.getItem('cook-freebuff:auth:unauthorized-domain-reloaded')).toBe('1');
  });

  it('surfaces the distinct still-blocked message (never re-reloads) on a second unauthorized-domain in the same tab session', async () => {
    window.sessionStorage.setItem('cook-freebuff:auth:unauthorized-domain-reloaded', '1');
    const { result } = renderHook(() => useAuthSession());
    // Mounting with the marker already set shows the "tap to retry" hint.
    expect(result.current.signInHint).toBe(SIGN_IN_RETRY_HINT);
    mockSignInWithGoogle.mockRejectedValueOnce(new SignInError('blocked', 'auth/unauthorized-domain'));

    await act(async () => {
      await expect(result.current.signIn()).rejects.toThrow(SIGN_IN_STILL_BLOCKED);
    });

    expect(replace).not.toHaveBeenCalled();
    // The retry hint is now stale (the retry already happened and failed) —
    // the still-blocked message takes over so the page never shows both.
    expect(result.current.signInHint).toBeNull();
  });

  it('surfaces the retry hint when the page mounts with the reload marker set', () => {
    window.sessionStorage.setItem('cook-freebuff:auth:unauthorized-domain-reloaded', '1');
    const { result } = renderHook(() => useAuthSession());

    expect(result.current.signInHint).toBe(SIGN_IN_RETRY_HINT);
  });

  it('does not navigate when the marker cannot be persisted (surfaces the error instead of looping)', async () => {
    // Storage can be full or blocked (private mode / privacy policy). If the
    // one-shot marker can't be written, a reload would come back with the
    // marker still unset and reload again forever — so the hook must surface
    // the blocked-domain error instead of reloading.
    const realStorage = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
        clear: () => {},
      },
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useAuthSession());
    mockSignInWithGoogle.mockRejectedValueOnce(new SignInError('blocked', 'auth/unauthorized-domain'));

    try {
      await act(async () => {
        await expect(result.current.signIn()).rejects.toThrow('blocked');
      });

      expect(replace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        value: realStorage,
        configurable: true,
        writable: true,
      });
    }
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
