import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class GoogleAuthProvider {},
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));

import { signInWithPopup, signOut } from 'firebase/auth';
import {
  AUTH_CONFIG_MISSING,
  PROVIDER_DISABLED,
  SIGN_IN_BLOCKED,
  SIGN_IN_CANCELLED,
  SIGN_IN_FAILED,
  authErrorMessage,
  signInWithGoogle,
  signOutFirebase,
} from './session';

const mockPopup = vi.mocked(signInWithPopup);
const mockSignOut = vi.mocked(signOut);

describe('authErrorMessage · Firebase auth error → honest copy', () => {
  it('maps a user-closed popup to the cancelled message', () => {
    expect(authErrorMessage('auth/popup-closed-by-user')).toBe(SIGN_IN_CANCELLED);
    expect(authErrorMessage('auth/cancelled-popup-request')).toBe(SIGN_IN_CANCELLED);
    expect(authErrorMessage('auth/popup-blocked')).toBe(SIGN_IN_CANCELLED);
  });

  it('maps an unauthorized domain to the authorized-domains guidance', () => {
    // The classic failure for a fresh Vercel URL: the domain is not in the
    // project's Authorized domains — the message must point at the fix.
    expect(authErrorMessage('auth/unauthorized-domain')).toBe(SIGN_IN_BLOCKED);
    expect(SIGN_IN_BLOCKED).toContain('Authorized domains');
  });

  it('maps a disabled provider to the enable-Google guidance', () => {
    expect(authErrorMessage('auth/operation-not-allowed')).toBe(PROVIDER_DISABLED);
    expect(authErrorMessage('auth/admin-restricted-operation')).toBe(PROVIDER_DISABLED);
    expect(PROVIDER_DISABLED).toContain('Google');
  });

  it('maps the synthetic config-missing code to the env guidance', () => {
    expect(authErrorMessage('config-missing')).toBe(AUTH_CONFIG_MISSING);
  });

  it('falls back to the generic message for unknown codes', () => {
    expect(authErrorMessage(undefined)).toBe(SIGN_IN_FAILED);
    expect(authErrorMessage('auth/network-request-failed')).toBe(SIGN_IN_FAILED);
  });
});

describe('signInWithGoogle · Google popup wrapper', () => {
  it('resolves when the popup succeeds', async () => {
    mockPopup.mockResolvedValue({} as never);
    await expect(signInWithGoogle({} as never)).resolves.toBeUndefined();
    expect(mockPopup).toHaveBeenCalledTimes(1);
  });

  it('throws the mapped message when the popup is closed by the user', async () => {
    mockPopup.mockRejectedValue({ code: 'auth/popup-closed-by-user' });
    await expect(signInWithGoogle({} as never)).rejects.toThrow(SIGN_IN_CANCELLED);
  });

  it('throws the blocked-domain guidance on auth/unauthorized-domain', async () => {
    mockPopup.mockRejectedValue({ code: 'auth/unauthorized-domain' });
    await expect(signInWithGoogle({} as never)).rejects.toThrow(SIGN_IN_BLOCKED);
  });

  it('throws the generic message for unknown rejections', async () => {
    mockPopup.mockRejectedValue(new Error('boom'));
    await expect(signInWithGoogle({} as never)).rejects.toThrow(SIGN_IN_FAILED);
  });
});

describe('signOutFirebase · best-effort sign-out', () => {
  it('resolves on success', async () => {
    mockSignOut.mockResolvedValue(undefined);
    await expect(signOutFirebase({} as never)).resolves.toBeUndefined();
  });

  it('never rejects (sign-out failure is not actionable)', async () => {
    mockSignOut.mockRejectedValue(new Error('offline'));
    await expect(signOutFirebase({} as never)).resolves.toBeUndefined();
  });
});
