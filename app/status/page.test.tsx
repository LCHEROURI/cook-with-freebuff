// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/status/page.test.tsx — rendered negative path for the recurring-flake
// card: a flake_streak doc with active=false (a healed / clean week) must show
// the "No recurring infra flake right now." empty state, never the stale
// signature, count, or streak weeks that may still linger in the doc.
// ============================================================================

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth/useAuthSession', () => ({
  useAuthSession: vi.fn(),
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import StatusPage from './page';

const base: UseAuthSessionResult = {
  user: { uid: 'user-1' } as UseAuthSessionResult['user'],
  state: 'ready',
  error: null,
  signInHint: null,
  getToken: async () => 'id-token',
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

const mockAuth = vi.mocked(useAuthSession);

function stubStatus(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
  vi.unstubAllGlobals();
});

describe('app/status/page.tsx · recurring-flake card empty state', () => {
  it('shows the empty state when the flake_streak doc is inactive, hiding the stale streak fields', async () => {
    stubStatus({
      commitSha: 'abc1234',
      builtAt: '2026-08-18T00:00:00Z',
      emulator: false,
      verifyLive: null,
      lastExternal: null,
      flakeStreak: {
        active: false,
        recurringCount: 1,
        signature: 'launch → 503',
        weeks: ['2026-08-03', '2026-08-10', '2026-08-17'],
        ranAt: '2026-08-18T00:00:00Z',
        runUrl: 'https://github.com/LCHEROURI/cook-with-freebuff/actions/runs/1',
      },
    });

    render(<StatusPage />);

    // The card renders its empty state, not the inactive streak's leftovers.
    await screen.findByText('No recurring infra flake right now.');
    expect(screen.queryByText('launch → 503')).toBeNull();
    expect(screen.queryByText(/recurring flake/)).toBeNull();
    expect(screen.queryByText(/week streak/)).toBeNull();
  });
});

describe('app/status/page.tsx · recurring-flake card active state', () => {
  const runUrl = 'https://github.com/LCHEROURI/cook-with-freebuff/actions/runs/1';

  const activeStatus = (flakeStreak: Record<string, unknown>) => ({
    commitSha: 'abc1234',
    builtAt: '2026-08-18T00:00:00Z',
    emulator: false,
    verifyLive: null,
    lastExternal: null,
    flakeStreak,
  });

  it('renders the count, signature, week-streak line, and CI link for an active streak', async () => {
    stubStatus(
      activeStatus({
        active: true,
        recurringCount: 1,
        signature: 'launch → 503',
        weeks: ['2026-08-03', '2026-08-10', '2026-08-17'],
        ranAt: '2026-08-18T00:00:00Z',
        runUrl,
      }),
    );

    render(<StatusPage />);

    await screen.findByText('1 recurring flake');
    expect(screen.getByText('launch → 503')).toBeInTheDocument();
    expect(screen.getByText('3-week streak · 2026-08-03 → 2026-08-17')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the CI run ↗' }).getAttribute('href')).toBe(runUrl);
  });

  it('pluralizes the count and shows the unknown-signature fallback', async () => {
    stubStatus(
      activeStatus({
        active: true,
        recurringCount: 2,
        signature: null,
        weeks: ['2026-08-03', '2026-08-10', '2026-08-17'],
        ranAt: '2026-08-18T00:00:00Z',
        runUrl,
      }),
    );

    render(<StatusPage />);

    await screen.findByText('2 recurring flakes');
    expect(screen.getByText('unknown signature')).toBeInTheDocument();
  });
});
