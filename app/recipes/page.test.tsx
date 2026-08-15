// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/recipes/page.test.tsx — rendered behavior lock for the "My Recipes"
// saved-recipe browser.
//
// The string-level wiring test locks the page's plumbing; this test renders
// the REAL page in jsdom and locks the user-visible behavior:
//  1. the loading gate and the signed-out gate (never a flash of recipes),
//  2. recipes load from /api/cook's list_recipes and render title + meta +
//     protein badges + the search/sort/chip controls,
//  3. the text search and the protein chip both narrow the list,
//  4. the empty state and the error+retry state both surface,
//  5. the one-tap Start button posts the launch action and hands off to /cook.
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

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import RecipesPage from './page';
import type { RecipeSummary } from './recipe-filter';

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

const RECIPES: RecipeSummary[] = [
  {
    recipeId: 'chicken-rice',
    title: 'Simple Chicken and Rice',
    servings: 4,
    totalMinutes: 30,
    ingredientCount: 6,
    proteinCategories: ['chicken'],
    preferences: { servings: 4, allergies: [], dietaryRestrictions: ['gluten-free'] },
    updatedAt: 3000,
  },
  {
    recipeId: 'beef-stew',
    title: 'Beef Stew',
    servings: 6,
    totalMinutes: 90,
    ingredientCount: 9,
    proteinCategories: ['beef'],
    preferences: { servings: 6, allergies: ['peanuts'], dietaryRestrictions: [] },
    updatedAt: 2000,
  },
];

function mockFetch() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; recipeId?: string };
    if (body.action === 'launch') {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (body.action === 'delete_recipe') {
      return new Response(JSON.stringify({ success: true, data: { deleted: body.recipeId } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // list_recipes (and any other read) returns the two recipes.
    return new Response(JSON.stringify({ success: true, data: { recipes: RECIPES } }), {
      status: 200,
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
  mockFetch();
});

describe('app/recipes/page.tsx · rendered behavior', () => {
  it('shows the loading gate while auth settles (never a flash of recipes)', () => {
    mockAuth.mockReturnValue({ ...base, state: 'loading' });
    render(<RecipesPage />);
    expect(screen.getByText('Loading your recipes…')).toBeInTheDocument();
    expect(screen.queryByText(/Beef Stew/)).not.toBeInTheDocument();
  });

  it('shows the signed-out gate and redirects to /login once auth settles', async () => {
    mockAuth.mockReturnValue({ ...base, user: null, state: 'ready' });
    render(<RecipesPage />);
    expect(screen.getByText('Signing you in…')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });

  it('loads recipes from /api/cook and renders titles, badges and controls', async () => {
    render(<RecipesPage />);
    expect(await screen.findByText('Simple Chicken and Rice')).toBeInTheDocument();
    expect(screen.getByText('Beef Stew')).toBeInTheDocument();
    // Protein badges render per recipe (newest first: chicken, then beef).
    const cards = screen.getAllByRole('listitem');
    expect(within(cards[0]).getByText('chicken')).toBeInTheDocument();
    expect(within(cards[1]).getByText('beef')).toBeInTheDocument();
    // Controls: search input, sort select, and the protein chips (All + each).
    expect(screen.getByLabelText('Search recipes')).toBeInTheDocument();
    expect(screen.getByLabelText('Sort recipes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chicken' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'beef' })).toBeInTheDocument();
    expect(screen.getByText('2 recipes')).toBeInTheDocument();
  });

  it('narrows the list by free-text search', async () => {
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');
    fireEvent.change(screen.getByLabelText('Search recipes'), { target: { value: 'beef' } });
    expect(screen.getByText('Beef Stew')).toBeInTheDocument();
    expect(screen.queryByText('Simple Chicken and Rice')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 recipes')).toBeInTheDocument();
  });

  it('narrows the list by protein chip and toggles back off', async () => {
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');
    fireEvent.click(screen.getByRole('button', { name: 'chicken' }));
    expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
    expect(screen.queryByText('Beef Stew')).not.toBeInTheDocument();
    // Toggling the same chip clears the filter again.
    fireEvent.click(screen.getByRole('button', { name: 'chicken' }));
    expect(screen.getByText('Beef Stew')).toBeInTheDocument();
  });

  it('shows the empty state with a create CTA when there are no saved recipes', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { recipes: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<RecipesPage />);
    expect(await screen.findByText('You have no saved recipes yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first recipe' })).toHaveAttribute('href', '/cook');
  });

  it('surfaces the error state and retries on demand', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecipesPage />);
    expect(await screen.findByText('Could not load your recipes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('shows the no-match state with a Clear filters action', async () => {
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');
    fireEvent.change(screen.getByLabelText('Search recipes'), { target: { value: 'does-not-exist' } });
    expect(screen.getByText('No recipes match your search.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
  });

  it('starts a saved recipe: posts launch and hands off to /cook', async () => {
    const fetchMock = mockFetch();
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');
    fireEvent.click(screen.getByRole('button', { name: 'Start cooking Simple Chicken and Rice' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/cook'));
    const launchCall = fetchMock.mock.calls.find(([, init]) =>
      JSON.parse(String(init?.body ?? '{}')).action === 'launch',
    );
    expect(launchCall).toBeDefined();
    expect(JSON.parse(String(launchCall?.[1]?.body ?? '{}'))).toEqual({
      action: 'launch',
      recipeId: 'chicken-rice',
    });
  });

  it('renders a Delete button on each saved-recipe row', async () => {
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');
    expect(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Beef Stew' })).toBeInTheDocument();
  });

  it('arms a confirm on Delete and Cancel reverts without deleting', async () => {
    const fetchMock = mockFetch();
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' }));
    // The single Delete button is replaced by Cancel + Confirm.
    expect(screen.getByRole('button', { name: 'Cancel delete Simple Chicken and Rice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm delete Simple Chicken and Rice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Simple Chicken and Rice' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel delete Simple Chicken and Rice' }));
    expect(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' })).toBeInTheDocument();
    // No delete request ever fired.
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        JSON.parse(String(init?.body ?? '{}')).action === 'delete_recipe',
      ),
    ).toBe(false);
  });

  it('confirms a delete: posts delete_recipe and removes the row', async () => {
    const fetchMock = mockFetch();
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Simple Chicken and Rice' }));

    await waitFor(() => expect(screen.queryByText('Simple Chicken and Rice')).not.toBeInTheDocument());
    expect(screen.getByText('Beef Stew')).toBeInTheDocument();

    const delCall = fetchMock.mock.calls.find(([, init]) =>
      JSON.parse(String(init?.body ?? '{}')).action === 'delete_recipe',
    );
    expect(delCall).toBeDefined();
    expect(JSON.parse(String(delCall?.[1]?.body ?? '{}'))).toEqual({
      action: 'delete_recipe',
      recipeId: 'chicken-rice',
    });
  });

  it('surfaces a delete failure and keeps the row', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'delete_recipe') {
        return new Response(
          JSON.stringify({ success: false, error: { message: 'Could not delete recipe (500)' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: { recipes: RECIPES } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecipesPage />);
    await screen.findByText('Simple Chicken and Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Simple Chicken and Rice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete recipe (500)');
    expect(screen.getByText('Simple Chicken and Rice')).toBeInTheDocument();
    // The confirm UI resets so the user can retry.
    expect(screen.getByRole('button', { name: 'Delete Simple Chicken and Rice' })).toBeInTheDocument();
  });
});
