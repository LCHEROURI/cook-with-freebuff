// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ============================================================================
// app/kitchen/page.test.tsx — rendered behavior lock for the kitchen page's
// voice-initiated confirmations (spec 0004 §Confirmations).
//
// Renders the REAL page in jsdom and locks the three rules:
//  1. a voice edit + successful mutation speaks the confirmation,
//  2. a voice edit + typed correction stays silent,
//  3. a voice edit + failed mutation stays silent.
// ============================================================================

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, back: vi.fn() }),
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

// Every mic in this test only needs to prove the transcript lands and sets
// provenance; emit a fixed name on click rather than driving real recognition.
vi.mock('@/components/VoiceInputButton', () => ({
  VoiceInputButton: ({
    onTranscript,
    'aria-label': ariaLabel,
  }: {
    onTranscript: (text: string) => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onTranscript('eggs')}>
      mic
    </button>
  ),
}));

import { useAuthSession, type UseAuthSessionResult } from '@/lib/auth/useAuthSession';
import KitchenPage from './page';

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

function mockFetch({
  pantryAddFails = false,
  profile = null,
}: {
  pantryAddFails?: boolean;
  profile?: Record<string, unknown> | null;
} = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
    if (body.action === 'snapshot') {
      return new Response(
        JSON.stringify({ success: true, data: { pantry: [], grocery: [], leftovers: [], profile } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.action === 'pantry_add') {
      if (pantryAddFails) {
        return new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderKitchen() {
  render(<KitchenPage />);
  await screen.findByRole('heading', { name: 'My Kitchen' });
  const pantry = screen.getByRole('region', { name: 'Pantry' });
  return pantry;
}

beforeEach(() => {
  replace.mockReset();
  mockAuth.mockReset();
  mockAuth.mockReturnValue(base);
  speech.speak.mockReset();
  speech.stop.mockReset();
  speech.speaking = false;
});

describe('app/kitchen/page.tsx · voice-initiated confirmations', () => {
  it('speaks the confirmation after a voice edit and successful mutation', async () => {
    mockFetch();
    const pantry = await renderKitchen();

    fireEvent.click(screen.getByRole('button', { name: 'Speak pantry item name' }));
    fireEvent.click(within(pantry).getByRole('button', { name: '+ Add' }));

    await waitFor(() => expect(speech.speak).toHaveBeenCalledWith('Added eggs to your pantry'));
    // Success clears the form and the provenance flag.
    expect(screen.getByLabelText('Pantry item name')).toHaveValue('');
  });

  it('stays silent when a voice edit is corrected by typing before submit', async () => {
    mockFetch();
    const pantry = await renderKitchen();

    fireEvent.click(screen.getByRole('button', { name: 'Speak pantry item name' }));
    // Typed correction clears the voice provenance.
    fireEvent.change(screen.getByLabelText('Pantry item name'), { target: { value: 'olive oil' } });
    fireEvent.click(within(pantry).getByRole('button', { name: '+ Add' }));

    // The mutation succeeds (form clears), but no confirmation speaks.
    await waitFor(() => expect(screen.getByLabelText('Pantry item name')).toHaveValue(''));
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('stays silent when the mutation fails even though the edit was voice', async () => {
    mockFetch({ pantryAddFails: true });
    const pantry = await renderKitchen();

    fireEvent.click(screen.getByRole('button', { name: 'Speak pantry item name' }));
    fireEvent.click(within(pantry).getByRole('button', { name: '+ Add' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(speech.speak).not.toHaveBeenCalled();
  });
});

describe('app/kitchen/page.tsx · preferred equipment', () => {
  it('loads preferred equipment and includes edits in the profile update', async () => {
    const fetchMock = mockFetch({
      profile: {
        userId: 'user-1',
        allergies: [],
        dietaryRestrictions: [],
        dislikedIngredients: [],
        preferredCuisines: [],
        preferredEquipment: ['air fryer'],
        defaultServings: 2,
        updatedAt: 1,
      },
    });
    await renderKitchen();

    const equipment = await screen.findByLabelText('Preferred equipment, comma separated');
    expect(equipment).toHaveValue('air fryer');
    fireEvent.change(equipment, { target: { value: 'air fryer, Dutch oven' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => {
      const update = fetchMock.mock.calls
        .map(([, init]) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        .find((body) => body.action === 'profile_update');
      expect(update?.preferredEquipment).toBe('air fryer, Dutch oven');
    });
  });

  it('treats a legacy profile without preferred equipment as an empty list', async () => {
    mockFetch({
      profile: {
        userId: 'user-1',
        allergies: [],
        dietaryRestrictions: [],
        dislikedIngredients: [],
        preferredCuisines: [],
        defaultServings: 2,
        updatedAt: 1,
      },
    });
    await renderKitchen();

    expect(await screen.findByLabelText('Preferred equipment, comma separated')).toHaveValue('');
  });
});
