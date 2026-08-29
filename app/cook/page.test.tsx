// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/cook/page.test.tsx — rendered behavior lock for the /cook starter screen.
//
// This file exists first and foremost to lock the list_recipes REQUEST
// DISCIPLINE regression: useAuthSession() returns a FRESH object literal on
// every render, so any useCallback/useEffect keyed on the whole `auth` object
// re-fires on every render — and because the fetch itself setRecipes()s, the
// page looped list_recipes requests forever without user action (~40 parallel
// /api/cook bursts observed server-side in Cloud Run logs). The fetch callback
// must be keyed on the STABLE auth identity choke point (getToken — stable
// across renders and encoding sign-in state) instead, and must STILL refetch
// when a genuine input (the protein filter) changes.
//
// The auth mock deliberately mirrors the real hook's contract: a NEW result
// object identity per render, with a referentially-stable getToken.
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

vi.mock('@/lib/firebase/app-check', () => ({
  appCheckHeaders: vi.fn(async () => ({})),
}));

vi.mock('@/components/CookScreen', () => ({ CookScreen: () => null }));
vi.mock('@/components/StarterTour', () => ({
  StarterTour: () => null,
  dismissStarterTour: vi.fn(),
}));

// Voice/live hooks are out of scope here — stub them inert and stable.
// The snapshot holder is MUTABLE so a test can simulate a session change
// (the stale "KITCHEN AGENT" reply regression) without a real backend.
// vi.hoisted survives vitest's hoisting of vi.mock above module scope.
const { cookSnapshot, clearTranscript, clearTurns } = vi.hoisted(() => ({
  cookSnapshot: { current: null as unknown },
  clearTranscript: vi.fn(),
  clearTurns: vi.fn(),
}));
vi.mock('@/lib/hooks/useCookingSession', () => ({
  useCookingSession: () => ({
    snapshot: cookSnapshot.current,
    loading: false,
    error: null,
    alert: null,
    launch: async () => {},
    refresh: async () => {},
  }),
}));

vi.mock('@/lib/hooks/useVoiceSession', () => ({
  useVoiceSession: () => ({
    status: 'OFFLINE',
    transcript: [],
    send: async () => {},
    setStatus: () => {},
    clearTranscript,
  }),
}));

vi.mock('@/lib/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    supported: true,
    listening: false,
    interim: '',
    error: null,
    toggle: async () => {},
  }),
}));

vi.mock('@/lib/hooks/useLiveDictation', () => ({
  useLiveDictation: () => ({
    available: true,
    listening: false,
    hearing: false,
    micReplying: false,
    error: null,
    clearError: () => {},
    toggle: async () => {},
  }),
}));

vi.mock('@/lib/hooks/useGeminiLive', () => ({
  useGeminiLive: () => ({
    available: false,
    status: 'IDLE',
    mode: 'off',
    error: null,
    turns: [],
    awaiting: false,
    getDiagnostics: () => ({}),
    toggle: async () => {},
    clearTurns,
  }),
  shouldAutoFallbackToWebSpeech: () => false,
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import CookPage from './page';

const mockAuth = vi.mocked(useAuthSession);

const RECIPES = [
  {
    recipeId: 'chicken-rice',
    title: 'Simple Chicken and Rice',
    servings: 4,
    totalMinutes: 30,
    ingredientCount: 6,
    proteinCategories: ['chicken'],
    preferences: { servings: 4, allergies: [], dietaryRestrictions: [] },
    updatedAt: 3000,
  },
];

interface ListBody {
  action?: string;
  protein?: string;
}

function stubFetch() {
  let listCalls = 0;
  const bodies: ListBody[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ListBody;
    bodies.push(body);
    if (body.action === 'list_recipes') listCalls += 1;
    return new Response(JSON.stringify({ success: true, data: { recipes: RECIPES } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    count: () => listCalls,
    bodies: () => bodies,
  };
}

beforeEach(() => {
  cookSnapshot.current = null;
  clearTranscript.mockClear();
  clearTurns.mockClear();
  push.mockReset();
  replace.mockReset();
  mockAuth.mockReset();
  // Mirror the REAL hook: a fresh result-object identity every render, while
  // getToken stays referentially stable across renders (it is a useCallback
  // with an empty dep list in useAuthSession).
  const stableGetToken = async () => 'id-token';
  mockAuth.mockImplementation(() => ({
    user: { uid: 'owner-uid' } as UseAuthSessionResult['user'],
    state: 'ready',
    error: null,
    signInHint: null,
    getToken: stableGetToken,
    signIn: async () => {},
    signOut: async () => {},
  }));
});

describe('app/cook/page.tsx · list_recipes request discipline', () => {
  it('fetches the recipe list ONCE on a stable starter screen — no self-sustaining re-render loop', async () => {
    const f = stubFetch();
    render(<CookPage />);
    await screen.findByText(RECIPES[0].title);
    const afterLoad = f.count();
    expect(afterLoad).toBeGreaterThanOrEqual(1);
    // Give any loop iterations generous macrotask room to surface. On the
    // buggy code the count climbs immediately; on the fixed code it never
    // moves. expect.poll keeps this bounded whichever way it goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect
      .poll(() => f.count(), { interval: 10, timeout: 500 })
      .toBe(afterLoad);
  });

  it('still refetches exactly when the protein filter genuinely changes', async () => {
    const user = userEvent.setup();
    const f = stubFetch();
    render(<CookPage />);
    await screen.findByText('Your recipes');
    const before = f.count();
    await user.click(screen.getByRole('button', { name: 'chicken' }));
    await waitFor(() => {
      expect(f.bodies().some((b) => b.action === 'list_recipes' && b.protein === 'chicken')).toBe(true);
    });
    expect(f.count()).toBe(before + 1);
  });
});

describe('app/cook/page.tsx · stale agent reply on a new session', () => {
  it('clears the turn stores when the snapshot sessionId changes (new session)', async () => {
    // Session A is active with a stale "Done" reply still in the stores.
    cookSnapshot.current = {
      found: true,
      sessionId: 'session-a',
      phase: 'COOKING_GUIDANCE',
      activeTimers: [],
    };
    const { rerender } = render(<CookPage />);
    // The initial snapshot must NOT clear — nothing to clear on first load.
    expect(clearTranscript).not.toHaveBeenCalled();
    expect(clearTurns).not.toHaveBeenCalled();

    // The session boundary moves to session B (start over / fresh launch).
    cookSnapshot.current = {
      found: true,
      sessionId: 'session-b',
      phase: 'COOKING_GUIDANCE',
      activeTimers: [],
    };
    rerender(<CookPage />);
    await waitFor(() => {
      expect(clearTranscript).toHaveBeenCalledTimes(1);
      expect(clearTurns).toHaveBeenCalledTimes(1);
    });
  });

  it('does not clear when the session is unchanged across renders', async () => {
    cookSnapshot.current = {
      found: true,
      sessionId: 'session-a',
      phase: 'COOKING_GUIDANCE',
      activeTimers: [],
    };
    const { rerender } = render(<CookPage />);
    // Same sessionId on the next snapshot — no boundary crossed.
    cookSnapshot.current = {
      found: true,
      sessionId: 'session-a',
      phase: 'PLATING',
      activeTimers: [],
    };
    rerender(<CookPage />);
    expect(clearTranscript).not.toHaveBeenCalled();
    expect(clearTurns).not.toHaveBeenCalled();
  });
});
