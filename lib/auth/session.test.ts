import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/auth', () => ({
  signInAnonymously: vi.fn(),
}));

import { signInAnonymously } from 'firebase/auth';
import {
  ANON_DISABLED,
  AUTH_CONFIG_MISSING,
  SIGN_IN_FAILED,
  authErrorMessage,
  ensureAnonSession,
} from './session';

const mockSignIn = vi.mocked(signInAnonymously);

describe('authErrorMessage · Firebase auth error → honest copy', () => {
  it('maps a disabled anonymous provider to the enable guidance', () => {
    // auth/operation-not-allowed is the code signInAnonymously rejects with
    // when the Anonymous provider is turned off in the console — the exact
    // state the live app is in. The message must tell the operator WHAT to
    // click, not just "could not sign in".
    expect(authErrorMessage('auth/operation-not-allowed')).toBe(ANON_DISABLED);
    expect(authErrorMessage('auth/admin-restricted-operation')).toBe(ANON_DISABLED);
    expect(ANON_DISABLED).toContain('Anonymous');
    expect(ANON_DISABLED).toContain('Sign-in method');
  });

  it('maps the synthetic config-missing code to the env guidance', () => {
    expect(authErrorMessage('config-missing')).toBe(AUTH_CONFIG_MISSING);
    expect(AUTH_CONFIG_MISSING).toContain('NEXT_PUBLIC_FIREBASE_');
  });

  it('falls back to the generic message for unknown codes', () => {
    expect(authErrorMessage(undefined)).toBe(SIGN_IN_FAILED);
    expect(authErrorMessage('auth/network-request-failed')).toBe(SIGN_IN_FAILED);
    expect(authErrorMessage('auth/invalid-api-key')).toBe(SIGN_IN_FAILED);
  });
});

describe('ensureAnonSession · never throws, returns a verdict', () => {
  it('returns { ok: true, user } on a successful anonymous sign-in', async () => {
    const user = { uid: 'anon-abc' } as never;
    mockSignIn.mockResolvedValue({ user } as never);
    const res = await ensureAnonSession({} as never);
    expect(res).toEqual({ ok: true, user });
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });

  it('maps a disabled-provider rejection to the enable guidance (ok: false)', async () => {
    mockSignIn.mockRejectedValue({ code: 'auth/operation-not-allowed' });
    const res = await ensureAnonSession({} as never);
    expect(res).toEqual({ ok: false, error: ANON_DISABLED });
  });

  it('maps unknown rejections to the generic message (ok: false)', async () => {
    mockSignIn.mockRejectedValue(new Error('boom'));
    const res = await ensureAnonSession({} as never);
    expect(res).toEqual({ ok: false, error: SIGN_IN_FAILED });
  });
});
