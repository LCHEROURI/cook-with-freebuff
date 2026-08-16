// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/page.test.tsx — rendered behavior lock for the landing page resume card.
//
// The card shows the active session at a glance (phase + step, live timer
// countdowns, the voice engine badge, a Resume link) so a signed-in user can
// jump back in without opening /cook. Load-bearing behavior: the status read
// is gated on auth settle (a signed-out visitor never fires a tokenless
// request), a found session renders the card, a missing session hides it, the
// voice badge reflects the browser capability probe, the pause/resume quick
// action works from the card without opening /cook, and a finished timer
// surfaces a dismissible alert from the same 'timers' action /cook polls.
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

vi.mock('@/lib/audio/timer-chime', () => ({
  unlockAudioOnGesture: vi.fn(),
  playTimerChime: vi.fn(),
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import { unlockAudioOnGesture, playTimerChime } from '@/lib/audio/timer-chime';
import HomePage from './page';

const mockUnlockChime = vi.mocked(unlockAudioOnGesture);
const mockPlayChime = vi.mocked(playTimerChime);

const base: UseAuthSessionResult = {
  user: { uid: 'owner-uid' } as UseAuthSessionResult['user'],
  state: 'ready',
  error: null,
  signInHint: null,
  getToken: async () => 'id-token',
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};

const mockAuth = vi.mocked(useAuthSession);

const ACTIVE_SESSION = {
  success: true,
  data: {
    alerts: [],
    snapshot: {
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
  },
};

const PAUSED_SESSION = {
  success: true,
  data: {
    alerts: [],
    snapshot: {
      ...ACTIVE_SESSION.data.snapshot,
      phase: 'PAUSED',
      paused: true,
      pausedAt: Date.now() - 120_000,
    },
  },
};

const NO_SESSION = {
  success: true,
  data: {
    alerts: [],
    snapshot: { found: false, phase: 'IDLE', activeTimers: [] },
  },
};

// A fetch that answers the 'timers' poll with `running` and the pause/resume
// calls with the matching flipped snapshot. The real /api/cook route returns
// the snapshot DIRECTLY for pause/resume (only 'timers' wraps it in
// { alerts, snapshot }), so the mock mirrors that split — and lets the click
// tests observe the exact action posted.
function mockToggleFetch(running: unknown, paused: unknown) {
  const runningSnap = (running as { data: { snapshot: unknown } }).data.snapshot;
  const pausedSnap = (paused as { data: { snapshot: unknown } }).data.snapshot;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action: string };
    if (body.action === 'pause') return { ok: true, json: async () => ({ success: true, data: pausedSnap }) };
    if (body.action === 'resume') return { ok: true, json: async () => ({ success: true, data: runningSnap }) };
    return { ok: true, json: async () => running };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postedActions(fetchMock: ReturnType<typeof vi.fn>): string[] {
  // The card's background poll posts 'timers' on an interval — filter it out
  // so the assertions see only user-initiated actions.
  return fetchMock.mock.calls
    .map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as { action: string };
      return body.action;
    })
    .filter((a) => a !== 'timers');
}

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
  mockUnlockChime.mockClear();
  mockPlayChime.mockClear();
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
    const fetchMock = mockStatusFetch(NO_SESSION);
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
    mockStatusFetch(NO_SESSION);
    render(<HomePage />);
    expect(screen.getByText('Kitchen status')).toBeInTheDocument();
    expect(screen.getByText('Kitchen status')).toHaveAttribute('href', '/status');
  });

  it('pauses the session from the card without opening /cook', async () => {
    const fetchMock = mockToggleFetch(ACTIVE_SESSION, PAUSED_SESSION);
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('⏸ Pause')).toBeInTheDocument();
    });
    screen.getByText('⏸ Pause').click();

    await waitFor(() => {
      expect(screen.getByText('▶ Resume')).toBeInTheDocument();
    });
    // The card now reads as paused, not in progress.
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('In progress')).not.toBeInTheDocument();
    expect(postedActions(fetchMock)).toEqual(['pause']);
  });

  it('resumes a paused session from the card', async () => {
    const fetchMock = mockToggleFetch(ACTIVE_SESSION, PAUSED_SESSION);
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('⏸ Pause')).toBeInTheDocument();
    });
    // Swap to a paused server state via the poll's next tick isn't needed —
    // simulate the pause first, then resume.
    fetchMock.mockClear();
    screen.getByText('⏸ Pause').click();
    await waitFor(() => {
      expect(screen.getByText('▶ Resume')).toBeInTheDocument();
    });

    fetchMock.mockClear();
    screen.getByText('▶ Resume').click();
    await waitFor(() => {
      expect(screen.getByText('⏸ Pause')).toBeInTheDocument();
    });
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(postedActions(fetchMock)).toEqual(['resume']);
  });

  it('does NOT offer Pause in phases the state machine cannot pause (Codex P2)', async () => {
    // The server only accepts a pause from PREP_GUIDANCE / COOKING_GUIDANCE /
    // WAITING_FOR_TIMER — in PLATING (or RECIPE_READY, collection phases) a
    // Pause click would be rejected and the error silently swallowed. The card
    // must not render the button at all there; the resume link stays.
    mockStatusFetch({
      success: true,
      data: {
        alerts: [],
        snapshot: { ...ACTIVE_SESSION.data.snapshot, phase: 'PLATING', instruction: 'Plate and serve.' },
      },
    });
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('Resume cooking →')).toBeInTheDocument();
    });
    expect(screen.queryByText('⏸ Pause')).not.toBeInTheDocument();
    expect(screen.queryByText('▶ Resume')).not.toBeInTheDocument();
  });

  it('freezes the timer readout while the session is paused', async () => {
    mockStatusFetch(PAUSED_SESSION);
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('▶ Resume')).toBeInTheDocument();
    });
    // The paused chip shows a pause icon and a frozen label — never a live ⏱
    // countdown. The exact seconds are not asserted: the fixture's endsAt is
    // captured at module load, so the chip's value depends on when this test
    // runs (its 1s tick decays past the initial 5:00 before the freeze
    // captures the at-pause value).
    expect(screen.getByText(/⏸ Rice simmer/)).toBeInTheDocument();
    expect(screen.queryByText(/⏱/)).not.toBeInTheDocument();
    // How long the pause has lasted so far, from the server's pausedAt.
    expect(screen.getByText('paused 2m ago')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('timer')).toHaveAttribute('aria-label', expect.stringMatching(/Rice simmer, paused at [0-9]+:[0-9]{2}, paused 2m ago/));
    });
  });

  it('shows an alert when a timer finishes while the page is open', async () => {
    mockStatusFetch({
      success: true,
      data: { alerts: [{ message: 'Your Rice simmer is finished.', timerId: 't1' }], snapshot: ACTIVE_SESSION.data.snapshot },
    });
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('Your Rice simmer is finished.')).toBeInTheDocument();
    });
    // The card still renders its session alongside the alert.
    expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
  });

  it('dismisses the timer alert without losing the card', async () => {
    mockStatusFetch({
      success: true,
      data: { alerts: [{ message: 'Your Rice simmer is finished.', timerId: 't1' }], snapshot: ACTIVE_SESSION.data.snapshot },
    });
    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText('Your Rice simmer is finished.')).toBeInTheDocument();
    });
    screen.getByLabelText('Dismiss alert').click();
    await waitFor(() => {
      expect(screen.queryByText('Your Rice simmer is finished.')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
  });

  it('wires the gesture unlock and chimes when a timer alert appears', async () => {
    mockStatusFetch({
      success: true,
      data: { alerts: [{ message: 'Your Rice simmer is finished.', timerId: 't1' }], snapshot: ACTIVE_SESSION.data.snapshot },
    });
    render(<HomePage />);

    // The unlock is wired on mount (before any alert) so a later gesture can
    // resume the suspended AudioContext.
    expect(mockUnlockChime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('Your Rice simmer is finished.')).toBeInTheDocument();
    });
    // Exactly one chime for the one alert — never a repeat for the same alert.
    // The chime effect is keyed on alertTimerIds and can flush a tick after
    // the alert text renders, so poll instead of asserting synchronously.
    await waitFor(() => expect(mockPlayChime).toHaveBeenCalledTimes(1));
  });

  it('chimes for each distinct timerId even when labels repeat (Codex P2)', async () => {
    vi.useFakeTimers();
    try {
      // Poll 1 (mount): timer t1 finishes — one chime.
      mockStatusFetch({
        success: true,
        data: { alerts: [{ message: 'Your Simmer is finished.', timerId: 't1' }], snapshot: ACTIVE_SESSION.data.snapshot },
      });
      render(<HomePage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Your Simmer is finished.')).toBeInTheDocument();
      expect(mockPlayChime).toHaveBeenCalledTimes(1);

      // Poll 2 (10s later): SAME label, NEW timerId — the old message-keyed
      // dedupe would have swallowed it. It must chime.
      mockStatusFetch({
        success: true,
        data: { alerts: [{ message: 'Your Simmer is finished.', timerId: 't2' }], snapshot: ACTIVE_SESSION.data.snapshot },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockPlayChime).toHaveBeenCalledTimes(2);

      // Poll 3: the same timerId re-reported never chimes again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mockPlayChime).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
