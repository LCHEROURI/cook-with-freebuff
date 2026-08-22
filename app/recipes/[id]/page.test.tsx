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

// Controllable speech seam for read-aloud assertions. `speaking` is mutable so
// the read-all test can flip the control between speak and stop.
const speech = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(),
  speaking: false,
}));

vi.mock('@/lib/hooks/useSpeech', () => ({
  useSpeech: () => ({
    speak: speech.speak,
    stop: speech.stop,
    speaking: speech.speaking,
    supported: true,
  }),
}));

// The page only cares that the mic transcript lands on the stepper, not the
// real recognition lifecycle; emit a fixed spoken count on click.
vi.mock('@/components/VoiceInputButton', () => ({
  VoiceInputButton: ({
    onTranscript,
    'aria-label': ariaLabel,
  }: {
    onTranscript: (text: string) => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onTranscript('eight servings')}>
      mic
    </button>
  ),
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
    { id: 'i2', name: 'olive oil', quantity: 1, unit: 'cup', optional: false },
    { id: 'i3', name: 'salt', quantity: null, unit: null, optional: true },
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
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; recipeId?: string; name?: string };
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
    if (body.action === 'check_recipe_pantry') {
      return new Response(JSON.stringify({
        success: true,
        data: {
          details: [
            { name: 'chicken thighs', status: 'matched', pantryItemId: 'p1' },
            { name: 'olive oil', status: 'missing' },
            { name: 'salt', status: 'expired', pantryItemId: 'p3' },
          ],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (body.action === 'grocery_add') {
      return new Response(JSON.stringify({ success: true }), {
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
  speech.speak.mockReset();
  speech.stop.mockReset();
  speech.speaking = false;
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
    // The meta line (servings · time · ingredients) — scoped with the time so
    // it does not collide with the stepper's own "2 servings" label.
    expect(screen.getByText(/2 servings · 35 min/)).toBeInTheDocument();
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
    expect(screen.getByText('contains peanuts')).toBeInTheDocument();
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

  it('scales ingredient quantities with the servings stepper and shows the caption', async () => {
    mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    // Base: stored quantities, no scaling note.
    expect(screen.getByText('4 pieces')).toBeInTheDocument();
    expect(screen.getByText('1 cup')).toBeInTheDocument();
    expect(screen.queryByText(/scaled from/i)).not.toBeInTheDocument();

    // One increment: 2 → 3 servings (factor 1.5). 4 → 6; 1 → 1½.
    fireEvent.click(screen.getByRole('button', { name: 'Increase servings' }));
    expect(screen.getByText('6 pieces')).toBeInTheDocument();
    expect(screen.getByText('1½ cup')).toBeInTheDocument();
    expect(screen.getByText('Scaled from 2 to 3 servings')).toBeInTheDocument();

    // Start still launches the stored base recipe, never the scaled copy.
    fireEvent.click(screen.getByRole('button', { name: /start cooking/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/cook'));
  });

  it('bounds the servings stepper to 1-24', async () => {
    mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    // 2 → 1 (factor 0.5): 4 pieces → 2 pieces; 1 cup → ½ cup.
    fireEvent.click(screen.getByRole('button', { name: 'Decrease servings' }));
    expect(screen.getByText('1 serving')).toBeInTheDocument();
    expect(screen.getByText('2 pieces')).toBeInTheDocument();
    expect(screen.getByText('½ cup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrease servings' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Increase servings' })).toBeEnabled();
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

  it('sets servings from a spoken count via the stepper mic', async () => {
    mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Speak servings' }));

    // "eight servings" → 8, factor 4 (base 2): stepper and caption update.
    expect(screen.getByText('8 servings')).toBeInTheDocument();
    expect(screen.getByText('Scaled from 2 to 8 servings')).toBeInTheDocument();
    expect(screen.getByText('16 pieces')).toBeInTheDocument();
  });

  it('reads a single step aloud with the instruction text', async () => {
    mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Read prep step 1' }));
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak).toHaveBeenCalledWith(expect.stringContaining('Dice the onion'));
  });

  it('reads all steps in order and stops', async () => {
    mockFetch();
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');

    fireEvent.click(screen.getByRole('button', { name: 'Read all steps' }));
    expect(speech.speak).toHaveBeenCalledTimes(1);

    // Flip to speaking so the control becomes Stop and exercise it.
    speech.speaking = true;
    render(<RecipeDetailPage />);
    await screen.findByText('Chicken Rice');
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    expect(speech.stop).toHaveBeenCalledTimes(1);
  });

  // ── Pantry gap check ──────────────────────────────────────────────────

  describe('pantry gap check', () => {
    beforeEach(() => {
      // Reset fetch per-test.
      vi.unstubAllGlobals();
    });

    it('shows Check my pantry button and requests check_recipe_pantry on click', async () => {
      const fm = mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      const btn = screen.getByRole('button', { name: '🧺 Check my pantry' });
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);

      await waitFor(() => {
        expect(fm).toHaveBeenCalledWith(
          expect.stringContaining('/api/cook'),
          expect.objectContaining({
            body: expect.stringContaining('"check_recipe_pantry"'),
          }),
        );
      });
    });

    it('renders status labels: Found, Needed, Needs replacement', async () => {
      mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));

      await waitFor(() => {
        expect(screen.getByText('Found')).toBeInTheDocument();
        expect(screen.getByText('Needed')).toBeInTheDocument();
        expect(screen.getByText('Needs replacement')).toBeInTheDocument();
      });

      // chicken thighs → Found, olive oil → Needed, salt → Needs replacement
      const panel = screen.getByLabelText('Pantry match');
      expect(panel.textContent).toContain('chicken thighs');
      expect(panel.textContent).toContain('olive oil');
      expect(panel.textContent).toContain('salt');
    });

    it('does not claim quantity sufficiency', async () => {
      mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));

      await waitFor(() => {
        expect(screen.getByText('chicken thighs')).toBeInTheDocument();
      });

      // The page must never say "enough", "sufficient", "ready to cook",
      // or "fully stocked".
      const panel = screen.getByLabelText('Pantry match');
      const text = panel.textContent ?? '';
      expect(text).not.toMatch(/enough/i);
      expect(text).not.toMatch(/sufficient/i);
      expect(text).not.toMatch(/ready to cook/i);
      expect(text).not.toMatch(/fully stocked/i);
    });

    it('shows loading state while checking', async () => {
      // Delay the response so we can observe the loading state.
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'get_recipe') {
          return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'check_recipe_pantry') {
          // Slight delay so loading state renders.
          await new Promise((r) => setTimeout(r, 50));
          return new Response(JSON.stringify({ success: true, data: { details: [{ name: 'chicken thighs', status: 'matched' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: false }), { status: 500, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      expect(screen.getByText('Checking your pantry…')).toBeInTheDocument();
    });

    it('shows error state with retry via re-clicking Check my pantry', async () => {
      let calls = 0;
      const fm = vi.fn(async () => {
        calls++;
        if (calls <= 2) {
          // First call is get_recipe, second is check_recipe_pantry.
          if (calls === 2) {
            return new Response(JSON.stringify({ success: false, error: { message: 'Boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
          }
        }
        if (calls === 3) {
          return new Response(JSON.stringify({ success: true, data: { details: [{ name: 'chicken', status: 'matched' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('Boom')).toBeInTheDocument(); });

      // Close error → idle → re-click (close button shows ×)
      fireEvent.click(screen.getByText('×'));
      // The close button resets to idle, Check my pantry should reappear.
      await waitFor(() => { expect(screen.getByRole('button', { name: '🧺 Check my pantry' })).toBeInTheDocument(); });
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('chicken')).toBeInTheDocument(); });
    });

    it('closes the panel and returns to recipe view', async () => {
      mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('Found')).toBeInTheDocument(); });

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => {
        expect(screen.queryByLabelText('Pantry match')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: '🧺 Check my pantry' })).toBeInTheDocument();
      });
    });

    it('individual add sends grocery_add with the ingredient name', async () => {
      const fm = mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('Needed')).toBeInTheDocument(); });

      // olive oil is missing → should have an Add button.
      const addBtn = screen.getByRole('button', { name: 'Add olive oil to grocery list' });
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(fm).toHaveBeenCalledWith(
          expect.stringContaining('/api/kitchen'),
          expect.objectContaining({
            body: expect.stringContaining('"grocery_add"'),
          }),
        );
      });
    });

    it('matched ingredient does not show an add button', async () => {
      mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('Found')).toBeInTheDocument(); });

      // chicken thighs is matched → no Add button.
      expect(screen.queryByRole('button', { name: 'Add chicken thighs to grocery list' })).not.toBeInTheDocument();
    });

    it('Add needed items sends grocery_add only for missing and expired', async () => {
      const fm = mockFetch();
      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');

      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByText('Needed')).toBeInTheDocument(); });

      fireEvent.click(screen.getByRole('button', { name: '🛒 Add needed items' }));

      await waitFor(() => {
        // Should include olive oil (missing) and salt (expired), but NOT chicken thighs (matched).
        const kitchenCalls = fm.mock.calls.filter(([url]) => String(url).includes('/api/kitchen'));
        const bodies = kitchenCalls.map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? '{}')));
        const names = bodies.map((b: { name?: string }) => b.name);
        expect(names).toContain('olive oil');
        expect(names).toContain('salt');
        expect(names).not.toContain('chicken thighs');
      });
    });

    it('rapid double-click on Add needed items sends only one round of requests', async () => {
      let kitchenCalls = 0;
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({ success: true, data: { details: [{ name: 'a', status: 'missing' }, { name: 'b', status: 'expired' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'grocery_add') {
          kitchenCalls++;
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByRole('button', { name: '🛒 Add needed items' })).toBeInTheDocument(); });

      // Two rapid clicks.
      const bulkBtn = screen.getByRole('button', { name: '🛒 Add needed items' });
      fireEvent.click(bulkBtn);
      fireEvent.click(bulkBtn);

      await waitFor(() => { expect(kitchenCalls).toBe(2); }); // 1 each for a + b = 2
      // No extra calls beyond the two expected.
      expect(kitchenCalls).toBe(2);
    });

    // ── Needs confirmation label ────────────────────────────────────────

    it('renders Needs confirmation for stale and uncertain ingredients', async () => {
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({
            success: true,
            data: { details: [
              { name: 'old spice', status: 'stale', pantryItemId: 's1' },
              { name: 'maybe milk', status: 'uncertain', pantryItemId: 'u1' },
            ] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));

      await waitFor(() => {
        expect(screen.getByText('old spice')).toBeInTheDocument();
        expect(screen.getByText('maybe milk')).toBeInTheDocument();
      });

      // Both stale and uncertain should show "Needs confirmation".
      expect(screen.getAllByText('Needs confirmation').length).toBe(2);
    });

    // ── Stale/uncertain → no grocery add ───────────────────────────────

    it('stale and uncertain ingredients have no grocery add button', async () => {
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({
            success: true,
            data: { details: [
              { name: 'old spice', status: 'stale', pantryItemId: 's1' },
              { name: 'maybe milk', status: 'uncertain', pantryItemId: 'u1' },
            ] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));

      await waitFor(() => { expect(screen.getAllByText('Needs confirmation').length).toBeGreaterThanOrEqual(1); });

      // Neither stale nor uncertain should have an Add to grocery button.
      expect(screen.queryByRole('button', { name: 'Add old spice to grocery list' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add maybe milk to grocery list' })).not.toBeInTheDocument();
    });

    // ── Individual double-click → one request ──────────────────────────

    it('rapid double-click on individual add sends exactly one grocery_add', async () => {
      let kitchenCalls = 0;
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({
            success: true,
            data: { details: [{ name: 'needed item', status: 'missing' }] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'grocery_add') {
          kitchenCalls++;
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Add needed item to grocery list' })).toBeInTheDocument(); });

      const addBtn = screen.getByRole('button', { name: 'Add needed item to grocery list' });
      fireEvent.click(addBtn);
      fireEvent.click(addBtn);

      await waitFor(() => { expect(kitchenCalls).toBe(1); });
    });

    // ── Grocery failure — lock release → retry ────────────────────────

    it('grocery failure releases lock so intentional retry works', async () => {
      let kitchenCalls = 0;
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'get_recipe') {
          return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({
            success: true,
            data: { details: [{ name: 'fail item', status: 'missing' }] },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (body.action === 'grocery_add') {
          kitchenCalls++;
          if (kitchenCalls === 1) {
            return new Response(JSON.stringify({ success: false, error: { message: 'Network error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Add fail item to grocery list' })).toBeInTheDocument(); });

      // First click: fails (but lock releases in finally).
      fireEvent.click(screen.getByRole('button', { name: 'Add fail item to grocery list' }));
      await waitFor(() => { expect(kitchenCalls).toBe(1); });

      // Second click: should succeed — lock was released.
      fireEvent.click(screen.getByRole('button', { name: 'Add fail item to grocery list' }));
      await waitFor(() => { expect(kitchenCalls).toBe(2); });
    });

    // ── Empty pantry ───────────────────────────────────────────────────

    it('handles empty pantry response without crashing', async () => {
      const fm = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
        if (body.action === 'check_recipe_pantry') {
          return new Response(JSON.stringify({ success: true, data: { details: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, data: { recipe: RECIPE } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fm);

      render(<RecipeDetailPage />);
      await screen.findByText('Chicken Rice');
      fireEvent.click(screen.getByRole('button', { name: '🧺 Check my pantry' }));

      // Should not crash. Panel should still render (though empty).
      await waitFor(() => {
        expect(screen.getByText('Pantry check')).toBeInTheDocument();
      });

      // Must not claim readiness or quantity sufficiency.
      const panel = screen.getByLabelText('Pantry match');
      const text = panel.textContent ?? '';
      expect(text).not.toMatch(/enough/i);
      expect(text).not.toMatch(/sufficient/i);
      expect(text).not.toMatch(/ready to cook/i);
    });
  });
});
