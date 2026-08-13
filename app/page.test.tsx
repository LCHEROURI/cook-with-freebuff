// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/page.test.tsx — rendered behavior lock for the landing page resume card.
//
// The card shows the active session at a glance (phase + step, live timer
// countdowns, the voice engine badge, a Resume link) so a signed-in user can
// jump back in without opening /cook. Load-bearing behavior: the status read
// is gated on auth settle (a signed-out visitor never fires a tokenless
// request), a found session renders the card, a missing session hides it, and
// the voice badge reflects the browser capability probe.
// ============================================================================

const push = vi.fn();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
}));

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

vi.mock('@/lib/voice/self-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/self-check')>();
  return {
    ...actual,
    detectVoiceEngine: vi.fn(() => 'gemini-live' as const),
  };
});

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import HomePage from './page';

const base: UseAuthSessionResult = {
  user: { uid: 'owner-uid' } as UseAuthSessionResult['user'],
  state: 'ready',
  error: null,
  getToken: async () => 'id-token',
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

const mockAuth = vi.mocked(useAuthSession);

const ACTIVE_SESSION = {
  success: true,
  data: {
    found: true,
    sessionId: 's1',
    phase: 'COOKING_GUIDANCE',
    recipeTitle: 'Simple Chicken and Rice',
    stepNumber: 2,
    totalSteps: 5,
    instruction: 'Add the rice and stir.',
    activeTimers: [
      { timerId: 't1', label: 'Rice simmer', durationSeconds: 600, endsAt: Date.now() + 300000, remainingSeconds: 300 },
    ],
  },
};

function mockStatusFetch(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
  vi.unstubAllGlobals();
});

describe('app/page.tsx · resume card', () => {
  it('renders the active session at a glance when signed in and a session is found', async () => {
    mockStatusFetch(ACTIVE_SESSION);
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
    });
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText(/Cooking · step 2 of 5/)).toBeInTheDocument();
    expect(screen.getByText('Add the rice and stir.')).toBeInTheDocument();
    expect(screen.getByText(/Rice simmer/)).toBeInTheDocument();
    expect(screen.getByText('⚡ Gemini Live')).toBeInTheDocument();
    expect(screen.getByText('Resume cooking →')).toBeInTheDocument();
    expect(screen.getByText('Resume cooking →')).toHaveAttribute('href', '/cook');
  });

  it('renders no resume card when signed in but no session is found', async () => {
    const fetchMock = mockStatusFetch({ success: true, data: { found: false, phase: 'IDLE', activeTimers: [] } });
    render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByText('Resume cooking →')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  it('never fires a status request when signed out', async () => {
    mockAuth.mockReturnValue({ ...base, user: null });
    const fetchMock = mockStatusFetch(ACTIVE_SESSION);
    render(<HomePage />);

    // Give the effect a beat — no tokenless request should ever be sent.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Resume cooking →')).not.toBeInTheDocument();
  });

  it('hides the card when the status read fails (degraded, not crashed)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByText('Resume cooking →')).not.toBeInTheDocument();
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
  });

  it('links to the status page from the footer', () => {
    mockStatusFetch({ success: true, data: { found: false, phase: 'IDLE', activeTimers: [] } });
    render(<HomePage />);
    expect(screen.getByText('Kitchen status')).toBeInTheDocument();
    expect(screen.getByText('Kitchen status')).toHaveAttribute('href', '/status');
  });
});
