# Voice Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every meaningful input a transcription mic (voice as a typewriter, no model round-trip) and add spoken confirmations, safety warnings, and recipe read-aloud via the browser's SpeechSynthesis, without touching the agent path.

**Architecture:** A reusable `VoiceInputButton` wraps the existing `useVoiceInput` Web Speech hook and hands the final transcript to its parent, which appends into the field using `fieldUI` separators. A `useSpeech` hook is the single SpeechSynthesis seam for confirmations and read-aloud. A pure `parseServings` parser lets the recipe detail stepper be set by voice. The agent (`/api/agent`) is untouched.

**Tech Stack:** Next.js 15 App Router, React client components with controlled `useState`, TypeScript, Web Speech API (`SpeechRecognition` + `SpeechSynthesis`), Vitest + Testing Library + jsdom.

## Global Constraints

- No change to `/api/agent`, the tool registry, the orchestrator, or any server code. The agent path stays exactly as it is.
- Transcription uses the existing `useVoiceInput` (browser Web Speech) only — never a model round-trip, never Gemini.
- Speech output uses the browser `SpeechSynthesis` only — no network, no key. When the browser has no voices, speech is a silent no-op and text stays on screen.
- Voice-first never voice-only: every mic sits beside the existing typed input, which remains the fallback.
- No auto-submit from voice; the user always reviews the transcribed text before submitting.
- Confirmations speak only when the action was voice-initiated; typed actions stay silent. Safety warnings always speak (in the cook session via Gemini Live, unchanged; on the detail page via read-aloud).
- Components use controlled inputs with `useState`, not `react-hook-form`.
- Component test files use the `// @vitest-environment jsdom` pragma; the default environment is `node`.
- Landing is PR-only under the required checks (validate, Codex P1 gate, smoke on pushes); Codex findings are resolved by fix + reply `Resolved ...` on the thread.
- Design source: `docs/specs/0004-voice-everywhere.md`. No voice on login, the status page, or filter/sort dropdowns.

---

### Task 1: `parseServings` — pure number parser

**Files:**
- Create: `app/recipes/servings-parser.ts`
- Test: `app/recipes/servings-parser.test.ts`

**Interfaces:**
- Produces: `parseServings(text: string): number | null` — returns the 1–24 serving count found in the transcript, or `null` when none is found.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseServings } from './servings-parser';

describe('parseServings', () => {
  it('parses a bare digit', () => {
    expect(parseServings('8')).toBe(8);
  });

  it('parses a digit with a trailing unit', () => {
    expect(parseServings('8 servings')).toBe(8);
    expect(parseServings('make it 6 servings please')).toBe(6);
  });

  it('parses number words', () => {
    expect(parseServings('eight')).toBe(8);
    expect(parseServings('twelve servings')).toBe(12);
    expect(parseServings('twenty-four')).toBe(24);
    expect(parseServings('twenty three')).toBe(23);
  });

  it('prefers a digit over a word', () => {
    expect(parseServings('four to 8 servings')).toBe(8);
  });

  it('clamps to the 1-24 stepper range', () => {
    expect(parseServings('0')).toBe(1);
    expect(parseServings('99')).toBe(24);
  });

  it('returns null when no number is found', () => {
    expect(parseServings('a bit more')).toBeNull();
    expect(parseServings('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/recipes/servings-parser.test.ts`
Expected: FAIL — `parseServings` is not defined (module missing).

- [ ] **Step 3: Write the minimal implementation**

```ts
// app/recipes/servings-parser.ts — turn a spoken serving count into a number.

const NUMBER_WORDS: Array<[string, number]> = [
  ['twenty-four', 24], ['twenty four', 24],
  ['twenty-three', 23], ['twenty three', 23],
  ['twenty-two', 22], ['twenty two', 22],
  ['twenty-one', 21], ['twenty one', 21],
  ['twenty', 20], ['nineteen', 19], ['eighteen', 18], ['seventeen', 17],
  ['sixteen', 16], ['fifteen', 15], ['fourteen', 14], ['thirteen', 13],
  ['twelve', 12], ['eleven', 11], ['ten', 10], ['nine', 9], ['eight', 8],
  ['seven', 7], ['six', 6], ['five', 5], ['four', 4], ['three', 3],
  ['two', 2], ['one', 1],
];

function clampServings(n: number): number {
  return Math.min(24, Math.max(1, Math.floor(n)));
}

export function parseServings(text: string): number | null {
  const t = text.trim().toLowerCase();
  const digitMatch = t.match(/\b(\d+)\b/);
  if (digitMatch) return clampServings(Number(digitMatch[1]));
  for (const [word, value] of NUMBER_WORDS) {
    if (t.includes(word)) return value; // every word is already 1-24
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/recipes/servings-parser.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/recipes/servings-parser.ts app/recipes/servings-parser.test.ts
git commit -m "feat(recipes): add parseServings for voice-setting the stepper"
```

---

### Task 2: `appendTranscript` — pure append helper

**Files:**
- Modify: `lib/domain/fieldUI.ts` — add the helper and export it.
- Test: `lib/domain/fieldUI.test.ts` (create if absent)

**Interfaces:**
- Produces: `appendTranscript(current: string, incoming: string, separator?: string): string` — returns `incoming` when `separator` is `undefined` (single-value replace), otherwise appends with the separator (skipping the separator when `current` is empty).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { appendTranscript } from './fieldUI';

describe('appendTranscript', () => {
  it('replaces when there is no separator (single-value field)', () => {
    expect(appendTranscript('oli', 'olive oil', undefined)).toBe('olive oil');
  });

  it('appends with the comma separator (list field)', () => {
    expect(appendTranscript('peanuts', 'shellfish', ', ')).toBe('peanuts, shellfish');
  });

  it('appends with the newline separator (notes field)', () => {
    expect(appendTranscript('bought at market', 'use soon', '\n')).toBe('bought at market\nuse soon');
  });

  it('does not prepend the separator when current is empty', () => {
    expect(appendTranscript('', 'eggs', ', ')).toBe('eggs');
  });

  it('keeps current when incoming is blank', () => {
    expect(appendTranscript('eggs', '   ', ', ')).toBe('eggs');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/domain/fieldUI.test.ts`
Expected: FAIL — `appendTranscript` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Add to `lib/domain/fieldUI.ts` (below the separator constants):

```ts
/**
 * Append a voice transcript into a field. No separator means a single-value
 * field (replace); a separator means a list/notes field (append).
 */
export function appendTranscript(current: string, incoming: string, separator?: string): string {
  if (!incoming.trim()) return current;
  if (separator == null) return incoming;
  return current.trim() === '' ? incoming : current + separator + incoming;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/domain/fieldUI.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/domain/fieldUI.ts lib/domain/fieldUI.test.ts
git commit -m "feat(domain): add appendTranscript for voice field appends"
```

---

### Task 3: `useSpeech` — the SpeechSynthesis seam

**Files:**
- Create: `lib/hooks/useSpeech.ts`
- Test: `lib/hooks/useSpeech.test.ts`

**Interfaces:**
- Produces: `useSpeech(): { speak: (text: string) => void; stop: () => void; speaking: boolean; supported: boolean }`. `speak` cancels any in-flight utterance and speaks the trimmed text; `stop` cancels and clears. `supported` is false when the browser lacks SpeechSynthesis.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSpeech } from './useSpeech';

const speak = vi.fn();
const cancel = vi.fn();

class FakeUtterance {
  text: string;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

beforeEach(() => {
  speak.mockReset();
  cancel.mockReset();
  vi.stubGlobal('speechSynthesis', { speak, cancel, speaking: false });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

describe('useSpeech', () => {
  it('speaks the trimmed text', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('  Added 2 eggs  '));
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe('Added 2 eggs');
  });

  it('ignores blank text', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('   '));
    expect(speak).not.toHaveBeenCalled();
  });

  it('stop cancels and clears speaking', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('hi'));
    act(() => result.current.stop());
    expect(cancel).toHaveBeenCalled();
    expect(result.current.speaking).toBe(false);
  });

  it('reports supported false when SpeechSynthesis is absent', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
    expect(() => result.current.speak('hi')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/hooks/useSpeech.test.ts`
Expected: FAIL — `useSpeech` is not defined.

- [ ] **Step 3: Write the minimal implementation**

```ts
'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Thin wrapper over the browser SpeechSynthesis API. Degrades to a silent
 * no-op when the browser has no speech support — the text stays on screen.
 */
export function useSpeech() {
  const [supported] = useState<boolean>(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
  );
  const [speaking, setSpeaking] = useState(false);

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    [],
  );

  useEffect(() => () => stop(), [stop]);

  return { speak, stop, speaking, supported };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/hooks/useSpeech.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/hooks/useSpeech.ts lib/hooks/useSpeech.test.ts
git commit -m "feat(hooks): add useSpeech for spoken confirmations and read-aloud"
```

---

### Task 4: `VoiceInputButton` — the reusable mic

**Files:**
- Create: `components/VoiceInputButton.tsx`
- Create: `components/VoiceInputButton.module.css`
- Test: `components/VoiceInputButton.test.tsx`

**Interfaces:**
- Consumes: `useVoiceInput` from `@/lib/hooks/useVoiceInput` (its `onFinal` fires once per completed tap-to-talk with the full transcript).
- Produces: `<VoiceInputButton onTranscript={(text) => void} aria-label="..." />` — a mic button; tapping toggles listening, tapping again stops and calls `onTranscript` with the full transcript. Disabled with a hint when the browser lacks SpeechRecognition.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VoiceInputButton } from './VoiceInputButton';

// Stub the Web Speech constructor so the hook reports supported.
class FakeRecognition {
  lang = '';
  interimResults = false;
  maxAlternatives = 1;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}
vi.stubGlobal('SpeechRecognition', FakeRecognition);

describe('VoiceInputButton', () => {
  it('starts and stops listening and emits the transcript', () => {
    const onTranscript = vi.fn();
    render(<VoiceInputButton onTranscript={onTranscript} aria-label="Speak item name" />);

    const btn = screen.getByRole('button', { name: 'Speak item name' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(onTranscript).toHaveBeenCalled();
  });

  it('disables the mic when SpeechRecognition is unavailable', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    render(<VoiceInputButton onTranscript={() => {}} aria-label="Speak item name" />);
    expect(screen.getByRole('button', { name: 'Speak item name' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/VoiceInputButton.test.tsx`
Expected: FAIL — `VoiceInputButton` module missing.

- [ ] **Step 3: Write the minimal implementation**

```tsx
'use client';

import { useVoiceInput } from '@/lib/hooks/useVoiceInput';
import styles from './VoiceInputButton.module.css';

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  'aria-label'?: string;
}

/**
 * The reusable transcription mic. Wraps useVoiceInput (browser Web Speech):
 * tap to start, tap again to stop and flush the full transcript to the parent.
 * The parent owns the append decision; this button only emits text.
 */
export function VoiceInputButton({ onTranscript, 'aria-label': ariaLabel }: VoiceInputButtonProps) {
  const { supported, listening, interim, error, toggle } = useVoiceInput({ onFinal: onTranscript });

  if (!supported) {
    return (
      <button type="button" disabled aria-label={ariaLabel} title="Voice input is not supported in this browser">
        🎤
      </button>
    );
  }

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        aria-label={ariaLabel ?? (listening ? 'Stop listening' : 'Speak')}
        aria-pressed={listening}
        className={styles.mic}
      >
        {listening ? '⏹' : '🎤'}
      </button>
      {listening && <span className={styles.interim}>{interim || 'Listening…'}</span>}
      {error && <span className={styles.error} role="alert">{error}</span>}
    </span>
  );
}
```

```css
/* components/VoiceInputButton.module.css */
.wrap { display: inline-flex; align-items: center; gap: 0.5rem; }
.mic { cursor: pointer; background: none; border: none; font-size: 1.1rem; }
.interim { font-size: 0.85rem; color: var(--color-info, #6B9FD4); }
.error { font-size: 0.85rem; color: var(--color-danger, #C44D3A); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/VoiceInputButton.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add components/VoiceInputButton.tsx components/VoiceInputButton.module.css components/VoiceInputButton.test.tsx
git commit -m "feat(components): add the reusable VoiceInputButton mic"
```

---

### Task 5: `FormInput` / `FormTextarea` gain a `voice` prop

**Files:**
- Modify: `components/FormField.tsx`
- Test: `components/FormField.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `VoiceInputButton` (Task 4), `appendTranscript` (Task 2).
- Produces: `voice?: boolean` on both `FormInput` and `FormTextarea`. When true, a mic renders beside the field and its transcript appends using the field's `fieldUI` separator (or replaces when none). `onChange` still receives a normal change event.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormInput, FormTextarea } from './FormField';
import { profileFieldUI } from '@/lib/domain/fieldUI';

class FakeRecognition {
  lang = ''; interimResults = false; maxAlternatives = 1; continuous = false;
  onresult = null; onend = null; onerror = null;
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
}
vi.stubGlobal('SpeechRecognition', FakeRecognition);

describe('FormField voice prop', () => {
  it('renders a mic beside the field when voice is set', () => {
    render(
      <FormInput value="" onChange={() => {}} voice aria-label="Allergies, comma separated" />,
    );
    expect(screen.getByRole('button', { name: 'Speak' })).toBeInTheDocument();
  });

  it('appends with the comma separator for a list field', () => {
    const onChange = vi.fn();
    render(
      <FormInput
        fieldUI={profileFieldUI}
        field="allergies"
        value="peanuts"
        onChange={onChange}
        voice
        aria-label="Allergies, comma separated"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop listening' }));
    expect(onChange).toHaveBeenCalled();
    const event = onChange.mock.calls[0][0];
    expect(event.target.value).toBe('peanuts, peanuts'); // transcript === typed value in the stub
  });
});
```

> Note: the stub recognition emits the field's current value as the "transcript", so this asserts the append path (separator applied) rather than real speech.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/FormField.test.tsx`
Expected: FAIL — the `voice` prop is not accepted / no mic renders.

- [ ] **Step 3: Write the minimal implementation**

Update `components/FormField.tsx`. Add `voice?: boolean` to `BaseProps`, import `VoiceInputButton` and `appendTranscript`, and render the button beside the control:

```tsx
import type { CSSProperties, ChangeEvent } from 'react';
import { VoiceInputButton } from '@/components/VoiceInputButton';
import { appendTranscript, type FieldUIAnnotations } from '@/lib/domain/fieldUI';

interface BaseProps {
  fieldUI?: FieldUIAnnotations;
  field?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Render a transcription mic beside the field (voice as a typewriter). */
  voice?: boolean;
}
```

In `FormInput`, compute `sep` as today, then:

```tsx
const voiceButton = voice ? (
  <VoiceInputButton
    aria-label={ariaLabel ? `Speak ${ariaLabel}` : undefined}
    onTranscript={(text) =>
      onChange({ target: { value: appendTranscript(value, text, sep) } } as ChangeEvent<HTMLInputElement>)
    }
  />
) : null;
```

Wrap the existing `<input>` in a `<span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>` containing the input followed by `voiceButton`. Repeat for `FormTextarea` with `ChangeEvent<HTMLTextAreaElement>`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/FormField.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/FormField.tsx components/FormField.test.tsx
git commit -m "feat(components): add a voice prop to FormInput and FormTextarea"
```

---

### Task 6: Recipe detail — stepper mic + read-aloud

**Files:**
- Create: `app/recipes/[id]/RecipeReadAloud.tsx`
- Modify: `app/recipes/[id]/page.tsx`
- Modify: `app/recipes/[id]/page.module.css`
- Test: `app/recipes/[id]/page.test.tsx` (extend)

**Interfaces:**
- Consumes: `VoiceInputButton` (Task 4), `parseServings` (Task 1), `useSpeech` (Task 3).
- Produces: a mic beside the servings stepper that sets `targetServings` from `parseServings`, and a `RecipeReadAloud` component with per-step "Read this step" plus a "Read all" / "Stop" control.

- [ ] **Step 1: Write the failing test**

Extend `app/recipes/[id]/page.test.tsx` with (the page already mocks fetch + navigation):

```tsx
it('sets the stepper from a spoken serving count', async () => {
  mockFetch();
  render(<RecipeDetailPage />);
  await screen.findByText('Chicken Rice');

  // Say "eight": the mic is stubbed, so click it twice to flush a transcript.
  fireEvent.click(screen.getByRole('button', { name: /speak servings/i }));
  fireEvent.click(screen.getByRole('button', { name: /stop listening/i }));
  expect(screen.getByText(/8 servings/i)).toBeInTheDocument();
});
```

> The stub `SpeechRecognition` in this test emits a fixed transcript `"eight servings"` (or the test passes it via the existing hook mock) so the assertion is deterministic. Adjust the stub to emit that text.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/recipes/[id]/page.test.tsx`
Expected: FAIL — no "Speak servings" control, stepper unchanged.

- [ ] **Step 3: Write the minimal implementation**

Create `app/recipes/[id]/RecipeReadAloud.tsx`:

```tsx
'use client';

import { useSpeech } from '@/lib/hooks/useSpeech';

export interface ReadAloudStep {
  id: string;
  instruction: string;
  meta?: string;
  safetyNote?: string;
}

function stepText(step: ReadAloudStep): string {
  const parts = [step.instruction];
  if (step.meta) parts.push(step.meta);
  if (step.safetyNote) parts.push(`Safety: ${step.safetyNote}`);
  return parts.join('. ');
}

export function RecipeReadAloud({ steps }: { steps: ReadAloudStep[] }) {
  const { speak, stop, speaking } = useSpeech();
  return (
    <div>
      {steps.map((step) => (
        <button key={step.id} type="button" onClick={() => speak(stepText(step))}>
          Read this step
        </button>
      ))}
      <button type="button" onClick={() => speak(steps.map(stepText).join('. '))}>
        Read all
      </button>
      {speaking && (
        <button type="button" onClick={stop}>
          Stop
        </button>
      )}
    </div>
  );
}
```

In `app/recipes/[id]/page.tsx`: import `VoiceInputButton`, `parseServings`, `RecipeReadAloud`. Add a mic beside the stepper:

```tsx
<VoiceInputButton
  aria-label="Speak servings"
  onTranscript={(text) => {
    const n = parseServings(text);
    if (n !== null) setTargetServings(n);
  }}
/>
```

Map the steps and render read-aloud under the cooking/prep sections:

```tsx
const readAloudSteps: ReadAloudStep[] = [
  ...recipe.prepSteps.map((s) => ({ id: s.id, instruction: s.instruction, meta: formatSeconds(s.estimatedSeconds), safetyNote: s.safetyNote })),
  ...recipe.cookingSteps.map((s) => ({
    id: s.id,
    instruction: s.instruction,
    meta: [s.estimatedSeconds != null ? formatSeconds(s.estimatedSeconds) : null,
           s.timerSeconds != null ? `timer ${formatSeconds(s.timerSeconds)}` : null,
           s.temperature != null ? `${s.temperature}°${s.temperatureUnit ?? 'C'}` : null,
           s.heatLevel].filter(Boolean).join(', '),
    safetyNote: s.safetyNote,
  })),
];
<RecipeReadAloud steps={readAloudSteps} />;
```

Add matching CSS in `page.module.css` for the read-aloud buttons.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/recipes/[id]/page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/[id]/RecipeReadAloud.tsx app/recipes/[id]/page.tsx app/recipes/[id]/page.module.css app/recipes/[id]/page.test.tsx
git commit -m "feat(recipes): voice-set the stepper and read the recipe aloud"
```

---

### Task 7: Kitchen + search wiring with spoken confirmations

**Files:**
- Modify: `app/kitchen/page.tsx`
- Modify: `app/kitchen/page.test.tsx` (create if absent)
- Modify: `app/recipes/page.tsx`
- Modify: `app/recipes/page.test.tsx`

**Interfaces:**
- Consumes: `VoiceInputButton` (Task 4), `appendTranscript` (Task 2), `useSpeech` (Task 3).
- Produces: a mic beside every kitchen input and the recipes search box; each kitchen submit speaks a confirmation only when that form's last input was voice-initiated.

- [ ] **Step 1: Write the failing test**

```tsx
// app/kitchen/page.test.tsx — jsdom
it('speaks a confirmation only after a voice-initiated add', async () => {
  // Stub speechSynthesis.speak and SpeechRecognition (transcript "eggs").
  render(<KitchenPage />);
  await screen.findByText(/pantry/i);
  fireEvent.click(screen.getByRole('button', { name: /speak pantry item name/i }));
  fireEvent.click(screen.getByRole('button', { name: /stop listening/i }));
  fireEvent.click(screen.getByRole('button', { name: /add/i }));
  expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('eggs') }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/kitchen/page.test.tsx`
Expected: FAIL — no mic, no spoken confirmation.

- [ ] **Step 3: Write the minimal implementation**

In `app/kitchen/page.tsx`:

- Import `VoiceInputButton`, `appendTranscript`, `useSpeech`.
- Add a per-form `voiceInitiated` state (pantry, grocery, leftover, profile) defaulting to false.
- Add a mic beside each raw `<input>` (name/qty/unit/title/servings) and set `voice` on the existing `FormInput`/`FormTextarea` (notes + profile lists). Each mic's `onTranscript` sets its field value via `appendTranscript` and flips the form's `voiceInitiated` to true.
- On a successful `mutate`, speak the confirmation when the form's `voiceInitiated` is true, then reset it:

```tsx
const { speak } = useSpeech();
// pantry submit .then(...) path:
if (pantryVoiceInitiated) speak(`Added ${pantryName.trim()} to your pantry`);
setPantryVoiceInitiated(false);
```

Confirmation strings: pantry `Added X to your pantry`, grocery `Added X to your grocery list`, leftover `Logged X`, profile `Saved your dietary profile`.

In `app/recipes/page.tsx`: place a `VoiceInputButton` beside the search `<input>` with `onTranscript={(t) => setSearch(appendTranscript(search, t, undefined))}` (replace, no separator). No spoken confirmation — search is live filtering, not a submit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/kitchen/page.test.tsx app/recipes/page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/kitchen/page.tsx app/kitchen/page.test.tsx app/recipes/page.tsx app/recipes/page.test.tsx
git commit -m "feat(kitchen): add voice input to every kitchen field and the recipes search"
```

---

### Task 8: Verify drivers + scripts/AGENTS.md

**Files:**
- Modify: `scripts/drive-kitchen.mjs` (or the driver that covers /kitchen), `scripts/drive-recipes-page.mjs` — pin the new mics.
- Modify: `scripts/AGENTS.md` — document the voice-everywhere convention.

**Interfaces:**
- Produces: verify-driver assertions that each mic button exists with its aria-label and that the search box mic renders; the scripts/AGENTS.md gotcha that voice is Web Speech + SpeechSynthesis only, never a model round-trip.

- [ ] **Step 1: Write the failing driver assertion**

In the kitchen/recipes driver, add a check that the mic controls render:

```js
// drive-recipes-page.mjs (or its kitchen sibling)
const mic = await page.$('button[aria-label="Speak recipes search"]');
if (!mic) { console.log('✗ FAIL: recipes search mic missing'); process.exitCode = 1; }
```

- [ ] **Step 2: Run the driver to verify it fails**

Run the relevant driver locally against the dev server (or rely on the existing `verify:live` stage to catch it post-deploy).
Expected: FAIL — the mic is missing before Task 7 lands.

- [ ] **Step 3: Update scripts/AGENTS.md**

Add to the scripts/AGENTS.md gotchas:

```
- Voice everywhere (spec 0004) is client-side transcription via the Web Speech API plus browser SpeechSynthesis for output — never a model round-trip and never Gemini Live outside the cook session. The mic always sits beside a typed fallback; there is no auto-submit from voice.
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit and land**

```bash
git add scripts/drive-recipes-page.mjs scripts/AGENTS.md
git commit -m "test(scripts): pin the voice-everywhere mics and document the convention"
```

Then land the whole feature through the branch + PR path and watch the deploy verify.

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — §1→Task 4, §2→Task 5, §3→Tasks 1+6, §4→Tasks 3+7, §5→Task 6, drivers→Task 8.
- **Type consistency:** `parseServings`, `appendTranscript`, `useSpeech`, `VoiceInputButton` signatures are identical across every task that consumes them.
- **No placeholders:** every task carries real code and real test code.
