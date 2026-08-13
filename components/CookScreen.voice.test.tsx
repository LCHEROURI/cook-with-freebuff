// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { CookScreen } from './CookScreen';
import type { GuideSnapshot } from '@/lib/domain/guide';

function snapshot(overrides: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    found: true,
    sessionId: 's1',
    phase: 'PREP_GUIDANCE',
    status: 'ACTIVE',
    recipeId: 'recipe-1',
    recipeTitle: 'Chicken Rice',
    stepNumber: 1,
    totalSteps: 2,
    instruction: 'Dice the onion',
    activeTimers: [],
    availableIngredients: [],
    recipe: {
      id: 'recipe-1',
      title: 'Chicken Rice',
      servings: 2,
      ingredients: [],
      equipment: [],
      prepSteps: [{ stepNumber: 1, instruction: 'Dice the onion' }],
      cookingSteps: [],
      safetyNotes: [],
    },
    ...overrides,
  };
}

function baseProps() {
  return {
    snapshot: snapshot(),
    error: null,
    alert: null,
    voiceStatus: 'LISTENING' as const,
    onMicToggle: vi.fn(),
    onDone: vi.fn(),
    onRepeat: vi.fn(),
    onBack: vi.fn(),
    onResume: vi.fn(),
    onStartOver: vi.fn(),
    onDismissAlert: vi.fn(),
    onSend: vi.fn(),
  };
}

describe('CookScreen — copy voice details', () => {
  it('copies the diagnostics blob on click while listening and shows the copied state', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      render(
        createElement(CookScreen, {
          ...baseProps(),
          micSupported: true,
          micListening: true,
          onCopyDiagnostics: () => '{"engine":"gemini-live"}',
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Copy voice session details' }));
      expect(writeText).toHaveBeenCalledWith('{"engine":"gemini-live"}');

      // Let the clipboard promise resolve and the "copied" state render.
      await act(async () => {});
      expect(screen.getByText('✓ copied voice details')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is hidden while idle and when no handler is provided', () => {
    render(
      createElement(CookScreen, {
        ...baseProps(),
        micListening: false,
        onCopyDiagnostics: () => '{}',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Copy voice session details' })).not.toBeInTheDocument();
  });

  it('switches the status dot to a recording bar and the caption while hearing', () => {
    // The header VoiceIndicator is a second role=status element, so scope the
    // assertions to the mic status line (the one carrying data-hearing).
    const { container, rerender } = render(
      createElement(CookScreen, {
        ...baseProps(),
        micSupported: true,
        micListening: true,
        micHearing: false,
      }),
    );
    const status = container.querySelector('[data-hearing]');
    expect(status?.getAttribute('data-hearing')).toBe('false');
    expect(status?.textContent).toContain('Listening… speak now');

    rerender(
      createElement(CookScreen, {
        ...baseProps(),
        micSupported: true,
        micListening: true,
        micHearing: true,
      }),
    );
    expect(container.querySelector('[data-hearing]')?.getAttribute('data-hearing')).toBe('true');
    expect(container.querySelector('[data-hearing]')?.textContent).toContain('Hearing you…');
  });

  it('says the mic is paused while the reply plays instead of inviting speech', () => {
    const { container, rerender } = render(
      createElement(CookScreen, {
        ...baseProps(),
        micSupported: true,
        micListening: true,
        micReplying: false,
      }),
    );
    const status = container.querySelector('[data-hearing]');
    expect(status?.getAttribute('data-replying')).toBe('false');
    expect(status?.textContent).toContain('Listening… speak now');

    rerender(
      createElement(CookScreen, {
        ...baseProps(),
        micSupported: true,
        micListening: true,
        micReplying: true,
      }),
    );
    expect(container.querySelector('[data-hearing]')?.getAttribute('data-replying')).toBe('true');
    expect(container.querySelector('[data-hearing]')?.textContent).toContain('Reply playing — mic paused');
  });

  it('surfaces the active voice engine as a badge', () => {
    const { rerender } = render(createElement(CookScreen, { ...baseProps(), voiceEngine: 'gemini-live' }));
    const liveBadge = screen.getByText(/Gemini Live/);
    expect(liveBadge.getAttribute('data-engine')).toBe('gemini-live');

    rerender(createElement(CookScreen, { ...baseProps(), voiceEngine: 'web-speech' }));
    const fallbackBadge = screen.getByText(/Web Speech/);
    expect(fallbackBadge.getAttribute('data-engine')).toBe('web-speech');

    rerender(createElement(CookScreen, { ...baseProps(), voiceEngine: 'none' }));
    expect(screen.queryByText(/Gemini Live/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Web Speech/)).not.toBeInTheDocument();
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    vi.useFakeTimers();
    try {
      Object.assign(navigator, { clipboard: undefined });
      const execCommand = vi.fn().mockReturnValue(true);
      Object.assign(document, { execCommand });
      render(
        createElement(CookScreen, {
          ...baseProps(),
          micListening: true,
          onCopyDiagnostics: () => 'blob-text',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Copy voice session details' }));
      expect(execCommand).toHaveBeenCalledWith('copy');
      await act(async () => {});
      expect(screen.getByText('✓ copied voice details')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
