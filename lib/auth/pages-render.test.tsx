import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('@/lib/auth/useAuthSession', () => ({
  useAuthSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import LoginPage from '@/app/login/page';
import HomePage from '@/app/page';

const base: UseAuthSessionResult = {
  user: null,
  state: 'ready',
  error: null,
  signInHint: null,
  getToken: async () => null,
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

const mockAuth = vi.mocked(useAuthSession);

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
});

describe('app/login/page.tsx · render', () => {
  it('renders the Google button and back link when signed out', () => {
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Back to start');
    expect(html).toContain('aria-label="Sign in with Google"');
  });

  it('renders a loading gate while auth is settling (never the button)', () => {
    mockAuth.mockReturnValue({ ...base, state: 'loading' });
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('Loading…');
    expect(html).not.toContain('Continue with Google');
  });

  it('surfaces the auth config error when Firebase client env is missing', () => {
    mockAuth.mockReturnValue({ ...base, state: 'error', error: 'Firebase client configuration is missing' });
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('Firebase client configuration is missing');
    expect(html).toContain('role="alert"');
  });

  it('renders the post-reload retry hint as a status line (not an error)', () => {
    mockAuth.mockReturnValue({ ...base, signInHint: 'Refreshed your sign-in session — tap Continue with Google to retry.' });
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('Refreshed your sign-in session');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});

describe('app/page.tsx · landing render', () => {
  it('shows the Sign-in CTA and features when signed out', () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('Sign in to start');
    expect(html).toContain('Voice-first');
    expect(html).toContain('Pantry intelligence');
    expect(html).not.toContain('Start cooking');
    expect(html).not.toContain('Sign out');
  });

  it('shows Start cooking, My recipes and Sign out when signed in', () => {
    mockAuth.mockReturnValue({ ...base, user: { uid: 'u1' } as UseAuthSessionResult['user'] });
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('Start cooking');
    expect(html).toContain('My recipes');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('Sign in to start');
  });
});
