// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/recipes/[id]/page.test.tsx — rendered behavior lock for the read-only
// recipe detail page.
//
// Renders the REAL page in jsdom and locks the user-visible behavior (spec
// 0003 section 2):
//  1. the loading gate and the signed-out gate (never a flash of the recipe),
//  2. every section renders from the full Recipe returned by get_recipe
//     (ingredients with prep + optional, equipment, prep steps with their
//     ingredient/equipment context, cooking steps with timer/temperature/heat/
//     safety badges, dietary tags + allergens, top-level safety notes),
//  3. Start cooking posts launch and hands off to /cook,
//  4. the not-found state (missing or non-owned recipe) shows a back link,
//  5. the error + retry state surfaces and recovers,
//  6. the signed-out redirect and the auth-error branch (never a spinner).
// ============================================================================

const push = vi.fn();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useParams: () => ({ id: 'recipe-1' }),
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

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import RecipeDetailPage from './page';
import type { Recipe } from '@/lib/domain/types';

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

const RECIPE: Recipe = {
  id: 'recipe-1',
  userId: 'user-1',
  title: 'Chicken Rice',
  description: 'Simple one-pan dinner',
  servings: 2,
  estimatedPrepMinutes: 10,
  estimatedCookMinutes: 25,
  totalMinutes: 35,
  ingredients: [
    { id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', preparation: 'diced', optional: false },
    { id: 'i2', name: 'salt', quantity: null, unit: null, optional: true },
  ],
  equipment: ['pan', 'knife'],
  prepSteps: [
    { id: 'p1', stepNumber: 1, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
  ],
  cookingSteps: [
    { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, temperature: 180, temperatureUnit: 'C', heatLevel: 'medium-high', ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'], safetyNote: 'Hot oil' },
  ],
  dietaryTags: ['gluten-free'],
  allergens: ['peanuts'],
  safetyNotes: ['Hot oil \u2014 keep children away'],
  generatedAt: 1000,
  updatedAt: 1000,
};

function mockFetch({ notFound = false, fail = false } = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
    if (body.action === 'launch') {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (body.action === 'get_recipe') {
      if (notFound) {
        return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Recipe not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (fail) {
        return new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
});

describe('app/recipes/[id]/page.tsx · rendered behavior', () => {
  it('shows the loading gate while auth settles (never a flash of the recipe)', () => {
    mockAuth.mockReturnValue({ ...base, state: 'loading' });
    render(<RecipeDetailPage />);
    expect(screen.getByText(/loading recipe/i)).toBeInTheDocument();
    expect(screen.queryByText('Chicken Rice')).not.toBeInTheDocument();
  });

  it('renders every section of the full recipe', async () => {
    const fetchMock = mockFetch();
    render(<RecipeDetailPage />);

    expect(await screen.findByText('Chicken Rice')).toBeInTheDocument();
    expect(screen.getByText(/2 servings/)).toBeInTheDocument();
    // ingredients: quantity + unit, name + prep + optional marker
    expect(screen.getByText('4 pieces')).toBeInTheDocument();
    expect(screen.getByText(/chicken thighs, diced/)).toBeInTheDocument();
    expect(screen.getByText(/salt \(optional\)/)).toBeInTheDocument();
    // equipment
    expect(screen.getByText('pan')).toBeInTheDocument();
    expect(screen.getByText('knife')).toBeInTheDocument();
    // prep step + its ingredient/equipment context
    expect(screen.getByText('Dice the onion')).toBeInTheDocument();
    expect(screen.getByText('uses: onion, knife')).toBeInTheDocument();
    // dietary tags and allergen chips
    expect(screen.getByText('gluten-free')).toBeInTheDocument();
    expect(screen.getByText('no peanuts')).toBeInTheDocument();
    // cooking step: instruction, estimated time, timer, temperature, heat
    expect(screen.getByText(/sear the chicken 4 minutes/i)).toBeInTheDocument();
    expect(screen.getByText('4m 0s')).toBeInTheDocument();
    expect(screen.getByText('⏱ 4m 0s')).toBeInTheDocument();
    expect(screen.getByText('180°C')).toBeInTheDocument();
    expect(screen.getByText('medium-high')).toBeInTheDocument();
    // step safety note and top-level safety note (distinct text)
    expect(screen.getByText('⚠ Hot oil')).toBeInTheDocument();
    expect(screen.getByText('⚠ Hot oil — keep children away')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cook',
      expect.objectContaining({ body: JSON.stringify({ action: 'get_recipe', recipeId: 'recipe-1' }) }),
    );
  });

  it('starts cooking: posts launch and hands off to /cook', async () => {
    const fetchMock = mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    fireEvent.click(screen.getByRole('button', { name: /start cooking/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/cook'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cook',
      expect.objectContaining({ body: JSON.stringify({ action: 'launch', recipeId: 'recipe-1' }) }),
    );
  });

  it('shows Recipe not found with a back link when the server 404s', async () => {
    mockFetch({ notFound: true });
    render(<RecipeDetailPage />);
    expect(await screen.findByText('Recipe not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to my recipes/i })).toHaveAttribute('href', '/recipes');
  });

  it('shows an error with working retry when the fetch fails', async () => {
    mockFetch({ fail: true });
    render(<RecipeDetailPage />);
    // The error branch renders both a heading and the detail line, so target
    // the heading (unique) rather than the phrase that matches both elements.
    expect(await screen.findByRole('heading', { name: /could not load this recipe/i })).toBeInTheDocument();

    mockFetch();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Chicken Rice')).toBeInTheDocument();
  });

  it('redirects to /login when signed out', () => {
    mockAuth.mockReturnValue({ ...base, user: null, state: 'ready' });
    render(<RecipeDetailPage />);
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('shows the auth error instead of an infinite loading state', () => {
    mockAuth.mockReturnValue({ ...base, state: 'error', error: 'Sign-in is unavailable' });
    render(<RecipeDetailPage />);
    expect(screen.getByText(/sign-in is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to start/i })).toHaveAttribute('href', '/');
  });
});
