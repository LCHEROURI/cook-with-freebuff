// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

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

const RECIPE_OK = { ok: true, json: async () => ({
  success: true, data: {
    recipeId: 'recipe-1', title: 'Chicken and Rice', servings: 2,
    preferences: { servings: 2, allergies: [], dietaryRestrictions: [] },
    validation: { valid: true, errors: [], confirmations: [] },
  },
}) };
const PANTRY_STARTER = { ok: true, json: async () => ({ success: true, data: { items: [{ id: 'chicken', name: 'chicken', confidence: 1, stale: false, expiresSoon: false, daysUntilExpiration: null, requiresConfirmation: false, selectedByDefault: true }], profile: { allergies: [], dietaryRestrictions: [], dislikedIngredients: [], preferredCuisines: [], defaultServings: 2, preferredEquipment: [] } } }) };
const RECIPES_EMPTY = { ok: true, json: async () => ({ success: true, data: { recipes: [] } }) };
const MATCHES_EMPTY = { ok: true, json: async () => ({ success: true, data: { matches: [] } }) };

function buildFetch(...actions: string[]) {
  const fns: Record<string, () => unknown> = {
    pantry_starter: () => PANTRY_STARTER,
    list_recipes: () => RECIPES_EMPTY,
    match_pantry_recipes: () => MATCHES_EMPTY,
    create_recipe: () => RECIPE_OK,
  };
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
    const fn = fns[body.action ?? ''];
    return fn ? fn() : { ok: true, json: async () => ({ success: true }) };
  });
}

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
  it('two synchronous form submits -> exactly one create_recipe fetch', async () => {
    const fetchMock = buildFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const input = await screen.findByLabelText('What do you have to cook with?');
    await act(() => { fireEvent.change(input, { target: { value: 'chicken thighs and rice' } }); });
    const form = screen.getByLabelText('Create a recipe from ingredients');

    await act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });
    expect(countCreateCalls(fetchMock)).toBe(1);
  });

  it('two rapid Pantry clicks -> exactly one create_recipe fetch', async () => {
    const fetchMock = buildFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const pantryBtn = await screen.findByTestId('pantry-create');

    fireEvent.click(pantryBtn);
    fireEvent.click(pantryBtn);

    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });
    expect(countCreateCalls(fetchMock)).toBe(1);
  });

  it('lock releases after failure, so next submission gets a fresh fetch', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') return MATCHES_EMPTY;
      calls++;
      if (calls === 1) return { ok: false, json: async () => ({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Network error', recoverable: true } }) };
      return RECIPE_OK;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);
    const input = await screen.findByLabelText('What do you have to cook with?');
    await act(() => { fireEvent.change(input, { target: { value: 'chicken thighs and rice' } }); });
    const form = screen.getByLabelText('Create a recipe from ingredients');

    await act(() => { fireEvent.submit(form); });
    await waitFor(() => { expect(screen.getByText(/Network error/)).toBeInTheDocument(); });

    await act(() => { fireEvent.submit(form); });
    await waitFor(() => { expect(screen.getByText('Chicken and Rice')).toBeInTheDocument(); });

    expect(countCreateCalls(fetchMock)).toBe(2);
  });
});

// ── Use these soon — behavioral ───────────────────────────────────────────

describe('Use these soon section', () => {
  function matchResp(matches: unknown[]) {
    return { ok: true, json: async () => ({ success: true, data: { matches } }) };
  }

  const EXPIRING_MATCH = {
    recipeId: 'r1', title: 'Spinach Soup', servings: 2, totalMinutes: 25,
    ingredientCount: 5, matchPercent: 60, matchedCount: 3, missingCount: 2,
    expiredCount: 0, staleCount: 0, uncertainCount: 0,
    expiringSoonCount: 1, expiringSoonIngredients: ['spinach'],
    allIngredientsFound: false,
  };

  const NON_EXPIRING_MATCH = {
    recipeId: 'r2', title: 'Plain Rice', servings: 2, totalMinutes: 20,
    ingredientCount: 1, matchPercent: 100, matchedCount: 1, missingCount: 0,
    expiredCount: 0, staleCount: 0, uncertainCount: 0,
    expiringSoonCount: 0, expiringSoonIngredients: [],
    allIngredientsFound: true,
  };

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

  it('renders when expiring-soon matches exist', async () => {
    let matchCalls = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') { matchCalls++; return matchResp([EXPIRING_MATCH]); }
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    await waitFor(() => { expect(screen.getByText('Use these soon')).toBeInTheDocument(); });
    // Spinach Soup appears in both "Use these soon" and "What can I make?" — both should exist.
    const soupNodes = screen.getAllByText('Spinach Soup');
    expect(soupNodes.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Uses soon: spinach')).toBeInTheDocument();
    expect(matchCalls).toBe(1);
  });

  it('does not render when no expiring-soon matches exist', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') return matchResp([NON_EXPIRING_MATCH]);
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    // "What can I make?" should appear because there are matches.
    await waitFor(() => { expect(screen.getByText('What can I make?')).toBeInTheDocument(); });
    // But "Use these soon" must NOT appear.
    expect(screen.queryByText('Use these soon')).toBeNull();
  });

  it('ranks more expiring-soon ingredients higher', async () => {
    const MORE_EXPIRING = {
      recipeId: 'rA', title: 'Z Three Expiring', servings: 2, totalMinutes: 30,
      ingredientCount: 5, matchPercent: 60, matchedCount: 3, missingCount: 2,
      expiredCount: 0, staleCount: 0, uncertainCount: 0,
      expiringSoonCount: 3, expiringSoonIngredients: ['milk', 'eggs', 'cheese'],
      allIngredientsFound: false,
    };
    const LESS_EXPIRING = {
      recipeId: 'rB', title: 'A One Expiring', servings: 2, totalMinutes: 30,
      ingredientCount: 5, matchPercent: 60, matchedCount: 3, missingCount: 2,
      expiredCount: 0, staleCount: 0, uncertainCount: 0,
      expiringSoonCount: 1, expiringSoonIngredients: ['spinach'],
      allIngredientsFound: false,
    };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      // Deliberately unsorted — Z before A.
      if (body.action === 'match_pantry_recipes') return matchResp([LESS_EXPIRING, MORE_EXPIRING]);
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    await waitFor(() => { expect(screen.getByText('Use these soon')).toBeInTheDocument(); });
    // Get titles from the "Use these soon" section specifically.
    const section = screen.getByLabelText('Use these soon');
    const items = section.querySelectorAll('li');
    const titles = Array.from(items).map((li) => li.textContent ?? '');
    // "Z Three Expiring" (3 expiring-soon) must appear before "A One Expiring" (1).
    const zIdx = titles.findIndex((t) => t.includes('Z Three'));
    const aIdx = titles.findIndex((t) => t.includes('A One'));
    expect(zIdx).toBeLessThan(aIdx);
  });

  it('Cook this button is present for expiring-soon recipes', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') return matchResp([EXPIRING_MATCH]);
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    await waitFor(() => { expect(screen.getByText('Use these soon')).toBeInTheDocument(); });
    // Both sections may have a "Cook Spinach Soup" button.
    expect(screen.getAllByRole('button', { name: 'Cook Spinach Soup' }).length).toBeGreaterThanOrEqual(1);
  });

  it('does not claim readiness or quantity sufficiency', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') return matchResp([EXPIRING_MATCH]);
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    await waitFor(() => { expect(screen.getByText('Use these soon')).toBeInTheDocument(); });
    // The "All ingredients found" badge only applies to recipes with allIngredientsFound=true.
    // EXPIRING_MATCH has allIngredientsFound:false. Check the section doesn't use misleading labels.
    const section = screen.getByLabelText('Use these soon');
    expect(section.textContent).not.toMatch(/ready to cook|enough|sufficient|fully stocked/i);
  });

  it('does not issue a second match_pantry_recipes request', async () => {
    let matchCalls = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
      if (body.action === 'pantry_starter') return PANTRY_STARTER;
      if (body.action === 'list_recipes') return RECIPES_EMPTY;
      if (body.action === 'match_pantry_recipes') { matchCalls++; return matchResp([EXPIRING_MATCH]); }
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CookPage />);

    await waitFor(() => { expect(screen.getByText('Use these soon')).toBeInTheDocument(); });
    expect(screen.getByText('What can I make?')).toBeInTheDocument();
    // Both Candidate A and Candidate C share the same data — exactly one fetch.
    expect(matchCalls).toBe(1);
  });
});