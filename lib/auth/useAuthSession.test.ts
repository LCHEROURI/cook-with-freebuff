// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAuthSession } from './useAuthSession';

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
