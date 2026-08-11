import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { CookScreen } from './CookScreen';
import type { GuideSnapshot } from '@/lib/server/guide-service';

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
      ingredients: [{ id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false }],
      equipment: ['pan'],
      prepSteps: [
        { stepNumber: 1, instruction: 'Dice the onion' },
        { stepNumber: 2, instruction: 'Rinse the rice' },
      ],
      cookingSteps: [{ stepNumber: 1, instruction: 'Sear the chicken four minutes', timerSeconds: 240 }],
      safetyNotes: ['Hot oil'],
    },
    ...overrides,
  };
}

function render(snap: GuideSnapshot, props: Partial<Parameters<typeof CookScreen>[0]> = {}) {
  const base = {
    snapshot: snap,
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
    ...props,
  };
  return renderToStaticMarkup(createElement(CookScreen, base));
}

describe('CookScreen', () => {
  it('renders ONE instruction with phase and step count', () => {
    const html = render(snapshot());
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain('Prep');
    expect(html).toContain('Chicken Rice');
    // The active instruction is exactly ONE action — the second prep step is
    // only present inside the collapsed (secondary) full-recipe expansion.
    expect(html).toContain('>Dice the onion</p>');
    expect(html).not.toContain('>Rinse the rice</p>');
  });

  it('renders Previous / Repeat / Done controls', () => {
    const html = render(snapshot());
    expect(html).toContain('Previous step');
    expect(html).toContain('Repeat this step');
    expect(html).toContain('Done with this step');
  });

  it('disables Done while waiting on a timer and renders the countdown', () => {
    const html = render(
      snapshot({
        phase: 'WAITING_FOR_TIMER',
        activeTimers: [{ timerId: 't1', label: 'four-minute timer', durationSeconds: 240, endsAt: Date.now() + 240_000, remainingSeconds: 240 }],
      }),
    );
    expect(html).toContain('four-minute timer');
    expect(html).toContain('4:00');
    // Done is disabled: aria-disabled is not rendered by static markup, but the
    // disabled attribute is.
    expect(html).toContain('disabled=""');
  });

  it('shows a completed state with an enjoy message', () => {
    const html = render(snapshot({ phase: 'COMPLETED', instruction: 'Enjoy your meal!' }));
    expect(html).toContain('Enjoy your meal!');
  });

  it('renders the finished-timer alert banner', () => {
    const html = render(snapshot(), { alert: 'Your four-minute timer is finished.' });
    expect(html).toContain('Your four-minute timer is finished.');
  });

  it('renders paused state with Resume instead of the step controls', () => {
    const html = render(snapshot({ phase: 'PAUSED', paused: true }));
    expect(html).toContain('Resume cooking');
    expect(html).not.toContain('Done with this step');
  });

  it('renders a safety gate that must be acknowledged before continuing', () => {
    const onDone = vi.fn();
    const html = render(
      snapshot({
        phase: 'SAFETY_WARNING',
        instruction: 'Sear the chicken four minutes',
        safetyNote: 'Hot oil',
        safetyGate: { note: 'Hot oil' },
      }),
      { onDone },
    );
    expect(html).toContain('Safety first');
    expect(html).toContain('Hot oil');
    expect(html).toContain('I understand — continue');
    expect(html).toContain('Safety'); // phase chip
    // Normal step controls are hidden during the gate — the only action is the
    // explicit confirmation.
    expect(html).not.toContain('Done with this step');
    expect(html).not.toContain('Repeat this step');
    expect(html).not.toContain('Previous step');
  });

  it('renders the passive safety note outside the gate phase', () => {
    const html = render(snapshot({ safetyNote: 'Hot oil' }));
    expect(html).toContain('Hot oil');
    expect(html).not.toContain('Safety first');
    expect(html).toContain('Done with this step');
  });

  it('includes the expandable ingredients and full recipe sections', () => {
    const html = render(snapshot());
    expect(html).toContain('Ingredients');
    expect(html).toContain('chicken thighs');
    expect(html).toContain('Full recipe');
    expect(html).toContain('Sear the chicken four minutes');
  });

  it('surfaces the agent\'s last spoken response on screen (not just spoken)', () => {
    // The user must SEE what the app understood and said — a silent reply
    // leaves the screen looking stuck at "One moment…".
    const html = render(snapshot(), {
      turns: [{ utterance: 'chicken', response: 'I heard: chicken. Is that right?', toolCalls: [], status: 'LISTENING' }],
    });
    expect(html).toContain('Kitchen Agent');
    expect(html).toContain('I heard: chicken. Is that right?');
    // The response region is announced politely, never interruptively.
    expect(html).toContain('role="status"');
  });

  it('renders no response region when there is no agent reply yet', () => {
    const html = render(snapshot(), { turns: [] });
    expect(html).not.toContain('Kitchen Agent');
  });

  it('renders a scrollable transcript of the last five turns, oldest trimmed', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      utterance: `ingredient ${i + 1}`,
      response: `got it — ${i + 1}`,
      toolCalls: [],
      status: 'LISTENING' as const,
    }));
    const html = render(snapshot(), { turns });
    // The scrollable log region is present and the OLDEST turn is trimmed.
    expect(html).toContain('role="log"');
    expect(html).toContain('Conversation transcript');
    expect(html).not.toContain('ingredient 1');
    // The last five survive, each with the You / Kitchen Agent pairing.
    for (let i = 2; i <= 6; i++) {
      expect(html).toContain(`ingredient ${i}`);
      expect(html).toContain(`got it — ${i}`);
    }
    expect(html).toContain('You');
    expect(html).toContain('Kitchen Agent');
  });

  it('does not show the transcript for a single turn — the reply box already shows it', () => {
    // One turn has nothing to re-read beyond the large reply box; the
    // scrollable history appears only once there is history to scroll.
    const html = render(snapshot(), {
      turns: [{ utterance: 'chicken', response: 'I heard: chicken. Is that right?', toolCalls: [], status: 'LISTENING' }],
    });
    expect(html).toContain('I heard: chicken. Is that right?');
    expect(html).not.toContain('role="log"');
  });

  it('renders the Start over reset button (un-armed, two-step confirm)', () => {
    const html = render(snapshot());
    // The reset control is present with its label and the UN-armed copy — the
    // first click arms it ("Confirm — restart from step 1?") and only the
    // second click fires onStartOver. Static markup renders the initial state.
    expect(html).toContain('↺ Start over');
    expect(html).toContain('aria-label="Start over"');
    expect(html).not.toContain('Confirm — restart from step 1');
  });

  it('tells the user what to do in the collecting phase instead of a dead "One moment…"', () => {
    // The collecting phase has no step instruction yet — a bare "One
    // moment…" reads as a stuck screen. The screen must say what to do next.
    const html = render(snapshot({ phase: 'COLLECTING_INGREDIENTS', instruction: undefined }));
    expect(html).toContain('Tell me what ingredients you have');
    expect(html).not.toContain('One moment');
  });

  it('keeps the "One moment…" fallback for other instruction-less phases', () => {
    const html = render(snapshot({ phase: 'SAFETY_WARNING', instruction: undefined }));
    expect(html).toContain('One moment');
  });

  it('renders the real mic button (listening state via aria-pressed) WITH the typed fallback', () => {
    // Voice-first never means voice-only: the mic toggles and the text input
    // + Send stay present on the same form.
    const html = render(snapshot(), { micSupported: true, micListening: true, onMicToggle: vi.fn() });
    expect(html).toContain('aria-label="Stop listening"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Speak or type a command');
    expect(html).toContain('>Send</button>');
  });

  it('renders the mic idle when not listening and the text input remains the fallback', () => {
    const html = render(snapshot(), { micSupported: true, micListening: false, onMicToggle: vi.fn() });
    expect(html).toContain('aria-label="Speak a command"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('Speak or type a command');
  });

  it('renders the mic disabled with a clear explanation when unsupported', () => {
    const html = render(snapshot(), { micSupported: false });
    expect(html).toContain('aria-label="Speak a command"');
    expect(html).toContain('Microphone not supported in this browser — type instead');
    // The typed path is fully intact.
    expect(html).toContain('Speak or type a command');
    expect(html).toContain('>Send</button>');
  });

  it('shows the live interim transcript while listening', () => {
    const html = render(snapshot(), { micSupported: true, micListening: true, micInterim: 'repeat the', onMicToggle: vi.fn() });
    expect(html).toContain('repeat the');
    expect(html).toContain('role="status"');
  });

  it('shows the listening prompt when no words have been caught yet', () => {
    const html = render(snapshot(), { micSupported: true, micListening: true, micInterim: '', onMicToggle: vi.fn() });
    expect(html).toContain('Listening… speak now');
  });

  it('surfaces mic errors with a dismiss control', () => {
    const html = render(snapshot(), {
      micError: 'Microphone permission denied — enable it in your browser to speak.',
      onMicErrorClear: vi.fn(),
    });
    expect(html).toContain('Microphone permission denied');
    expect(html).toContain('Dismiss microphone error');
    expect(html).toContain('role="alert"');
  });
});
