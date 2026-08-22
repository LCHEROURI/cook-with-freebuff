// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Behavioral double-submission lock tests.
// Prove:
//  1. Two synchronous form submits -> exactly one fetch('create_recipe').
//  2. Two rapid Pantry clicks -> exactly one fetch('create_recipe').
//  3. Lock releases after failure -> next submission gets fresh fetch.

const push = vi.fn();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={String(href)} {...rest}>{children}</a>
  ),
}));

vi.mock('@/lib/auth/useAuthSession', () => ({ useAuthSession: vi.fn() }));
vi.mock('@/lib/hooks/useCookingSession', () => ({ useCookingSession: vi.fn() }));

vi.mock('@/lib/hooks/useVoiceSession', () => ({
  useVoiceSession: () => ({ send: vi.fn(), status: 'OFFLINE', transcript: { text: '', length: 0 }, setStatus: vi.fn() }),
}));

vi.mock('@/lib/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn(), error: null, clearError: vi.fn() }),
}));

vi.mock('@/lib/hooks/useGeminiLive', () => ({
  useGeminiLive: () => ({ available: false, mode: 'off', status: 'IDLE' as const, hearing: false, micReplying: false, error: null, turns: [], awaiting: false, toggle: vi.fn(), stop: vi.fn(), sendText: vi.fn(), clearError: vi.fn(), getDiagnostics: vi.fn(() => ({})) }),
  shouldAutoFallbackToWebSpeech: () => false,
}));

vi.mock('@/lib/hooks/useLiveDictation', () => ({
  useLiveDictation: () => ({ available: false, listening: false, toggle: vi.fn(), error: null, clearError: vi.fn() }),
}));

vi.mock('@/lib/firebase/app-check', () => ({ appCheckHeaders: async () => ({}) }));

vi.mock('@/components/CookScreen', () => ({
  CookScreen: () => <div data-testid="cook-screen">CookScreen</div>,
}));

vi.mock('@/components/StarterTour', () => ({
  StarterTour: () => null, dismissStarterTour: vi.fn(),
}));

vi.mock('./ConstraintDetails', () => ({ default: () => null }));
vi.mock('./RecipeRowMeta', () => ({ default: () => null }));

vi.mock('./PantryStarter', () => ({
  PantryStarter: ({ onCreate, creating }: { snapshot: unknown; creating: boolean; onCreate: (selection: unknown) => void }) => (
    <button data-testid="pantry-create" disabled={creating} onClick={() => onCreate({ pantryItemIds: ['item1'], confirmedPantryItemIds: ['item1'] })}>
      Create from Pantry
    </button>
  ),
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import { useCookingSession } from '@/lib/hooks/useCookingSession';
import CookPage from './page';

const mockAuth = vi.mocked(useAuthSession);
const mockCook = vi.mocked(useCookingSession);

const authBase: UseAuthSessionResult = {
  user: { uid: 'user-1' } as UseAuthSessionResult['user'],
  state: 'ready', error: null, signInHint: null,
  getToken: async () => 'fake-token',
  signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
};

const RECIPE_OK = { ok: true, json: async () => ({ success: true, data: { recipeId: 'recipe-1', title: 'Chicken and Rice', servings: 2, preferences: { servings: 2, allergies: [], dietaryRestrictions: [] }, validation: { valid: true, errors: [], confirmations: [] } } }) };
const PANTRY_STARTER = { ok: true, json: async () => ({ success: true, data: { items: [{ id: 'chicken', name: 'chicken', confidence: 1, stale: false, expiresSoon: false, daysUntilExpiration: null, requiresConfirmation: false, selectedByDefault: true }], profile: { allergies: [], dietaryRestrictions: [], dislikedIngredients: [], preferredCuisines: [], defaultServings: 2, preferredEquipment: [] } } }) };
const RECIPES_EMPTY = { ok: true, json: async () => ({ success: true, data: { recipes: [] } }) };

function countCreateCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([, init]) => {
    try { return JSON.parse(String((init as RequestInit)?.body ?? '{}')).action === 'create_recipe'; } catch { return false; }
  }).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockReturnValue(authBase);
  mockCook.mockReturnValue({
    snapshot: { found: false, activeTimers: [] } as unknown as ReturnType<typeof useCookingSession>['snapshot'],
    loading: false, error: null, alert: null,
    dismissAlert: vi.fn(), launch: vi.fn(), done: vi.fn(), repeat: vi.fn(),
    back: vi.fn(), pause: vi.fn(), resume: vi.fn(), startOver: vi.fn(), refresh: vi.fn(),
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('submission lock (behavioral)', () => {
  // ── Manual ────────────────────────────────────────────────────────────────

  it('two synchronous form submits -> exactly one create_recipe fetch', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return { ok: true, json: async () => ({ success: true, data: { items: [], profile: null } }) };
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      return RECIPE_OK;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const input = await screen.findByLabelText('What do you have to cook with?');
    await act(() => { fireEvent.change(input, { target: { value: 'chicken thighs and rice' } }); });
    const form = screen.getByLabelText('Create a recipe from ingredients');

    // Fire TWO submits in the SAME act() tick — the lock must catch the second one
    // before the first handler's finally block releases it.
    await act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });
    expect(countCreateCalls(fetchMock)).toBe(1);
  });

  // ── Pantry ────────────────────────────────────────────────────────────────

  it('two rapid Pantry clicks -> exactly one create_recipe fetch', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      return RECIPE_OK;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const pantryBtn = await screen.findByTestId('pantry-create');

    // userEvent respects disabled, so the second click (after the handler sets
    // creating=true + the button disables) is a no-op.
    fireEvent.click(pantryBtn);
    fireEvent.click(pantryBtn);

    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });
    expect(countCreateCalls(fetchMock)).toBe(1);
  });

  // ── Lock release after failure ────────────────────────────────────────────

  it('lock releases after failure, so next submission gets a fresh fetch', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return { ok: true, json: async () => ({ success: true, data: { items: [], profile: null } }) };
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      calls++;
      if (calls === 1) return { ok: false, json: async () => ({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Network error', recoverable: true } }) };
      return RECIPE_OK;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const input = await screen.findByLabelText('What do you have to cook with?');
    await act(() => { fireEvent.change(input, { target: { value: 'chicken thighs and rice' } }); });
    const form = screen.getByLabelText('Create a recipe from ingredients');

    // First submit: fails.
    await act(() => { fireEvent.submit(form); });
    await waitFor(() => { expect(screen.getByText(/Network error/)).toBeInTheDocument(); });

    // Second submit: succeeds because finally released the lock.
    await act(() => { fireEvent.submit(form); });
    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });

    expect(countCreateCalls(fetchMock)).toBe(2);
  });
});
