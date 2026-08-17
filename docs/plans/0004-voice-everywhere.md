# Voice Everywhere Implementation Plan

> **For agentic workers:** Implement task-by-task with tests first. Voice remains an enhancement to typed input, never the only path.

**Goal:** Give every meaningful input a transcription mic (voice as a typewriter, no model round-trip) and add spoken confirmations, safety warnings, and recipe read-aloud via the browser Speech APIs without changing the `/api/agent` path.

**Architecture:** `VoiceInputButton` wraps the existing `useVoiceInput` hook and emits a final transcript. Parents decide whether that transcript replaces or appends using `appendTranscript`. `useSpeech` is the single SpeechSynthesis seam. `parseServings` converts spoken serving counts to the 1–24 stepper range. Voice provenance is tracked per form and is cleared by any typed edit so spoken confirmations occur only for actions whose latest edit came from voice.

**Tech Stack:** Next.js 15 App Router, React controlled inputs, TypeScript, Web Speech API, SpeechSynthesis, Vitest + Testing Library + jsdom, existing raw-CDP live drivers.

## Global Constraints

- Do not change `/api/agent`, the tool registry, the orchestrator, or server-side agent behavior.
- Transcription uses the existing browser `useVoiceInput` path only; no model round-trip and no Gemini.
- Speech output uses browser `speechSynthesis`; unsupported browsers silently fall back to visible text.
- Every mic is beside an existing typed input. No auto-submit from voice.
- Spoken confirmations are emitted only after a confirmed successful mutation and only when the latest edit to that form was voice-originated.
- Any typed edit clears that form's voice provenance.
- Safety text remains visible even when it is spoken.
- Component tests use `// @vitest-environment jsdom`.
- Codex findings are resolved only after the corresponding plan/code correction lands.
- Design source: `docs/specs/0004-voice-everywhere.md`.

---

## Task 1: `parseServings` — pure spoken-number parser

**Files**
- Create: `app/recipes/servings-parser.ts`
- Test: `app/recipes/servings-parser.test.ts`

### Step 1 — failing tests

```ts
import { describe, expect, it } from 'vitest';
import { parseServings } from './servings-parser';

describe('parseServings', () => {
  it('parses digits and number words', () => {
    expect(parseServings('8')).toBe(8);
    expect(parseServings('make it 6 servings please')).toBe(6);
    expect(parseServings('eight')).toBe(8);
    expect(parseServings('twenty-four')).toBe(24);
    expect(parseServings('twenty three')).toBe(23);
  });

  it('prefers an explicit digit', () => {
    expect(parseServings('four to 8 servings')).toBe(8);
  });

  it('clamps to the stepper range', () => {
    expect(parseServings('0')).toBe(1);
    expect(parseServings('99')).toBe(24);
  });

  it('does not treat number-word substrings as numbers', () => {
    expect(parseServings('none')).toBeNull();
    expect(parseServings('someone')).toBeNull();
    expect(parseServings('stone')).toBeNull();
  });

  it('returns null when no number exists', () => {
    expect(parseServings('a bit more')).toBeNull();
    expect(parseServings('')).toBeNull();
  });
});
```

### Step 2 — implementation

```ts
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseServings(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  const digitMatch = normalized.match(/\b(\d+)\b/);
  if (digitMatch) return clampServings(Number(digitMatch[1]));

  for (const [word, value] of NUMBER_WORDS) {
    const pattern = new RegExp(`(?:^|[^a-z])${escapeRegExp(word)}(?:$|[^a-z])`, 'i');
    if (pattern.test(normalized)) return value;
  }

  return null;
}
```

Run: `npx vitest run app/recipes/servings-parser.test.ts`

Commit:

```bash
git add app/recipes/servings-parser.ts app/recipes/servings-parser.test.ts
git commit -m "feat(recipes): add safe spoken servings parser"
```

---

## Task 2: `appendTranscript` — replace/append helper

**Files**
- Modify: `lib/domain/fieldUI.ts`
- Test: `lib/domain/fieldUI.test.ts`

```ts
export function appendTranscript(current: string, incoming: string, separator?: string): string {
  if (!incoming.trim()) return current;
  if (separator == null) return incoming;
  return current.trim() === '' ? incoming : current + separator + incoming;
}
```

Tests must cover replace, comma append, newline append, empty current value, and blank incoming text.

Run: `npx vitest run lib/domain/fieldUI.test.ts`

---

## Task 3: `useSpeech` — robust SpeechSynthesis seam

**Files**
- Create: `lib/hooks/useSpeech.ts`
- Test: `lib/hooks/useSpeech.test.ts`

The support check must validate the API values, not merely property presence. This matters in jsdom because `vi.stubGlobal('speechSynthesis', undefined)` leaves a property whose value is `undefined`.

### Test

```ts
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeech } from './useSpeech';

const speak = vi.fn();
const cancel = vi.fn();

class FakeUtterance {
  text: string;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

beforeEach(() => {
  speak.mockReset();
  cancel.mockReset();
  vi.stubGlobal('speechSynthesis', { speak, cancel, speaking: false });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

describe('useSpeech', () => {
  it('speaks trimmed text', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('  Added 2 eggs  '));
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe('Added 2 eggs');
  });

  it('ignores blanks', () => {
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.speak('   '));
    expect(speak).not.toHaveBeenCalled();
  });

  it('reports unsupported when the API value is missing', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
    expect(() => result.current.speak('hi')).not.toThrow();
  });

  it('reports unsupported when the utterance constructor is missing', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
  });
});
```

### Implementation

```ts
'use client';

import { useCallback, useEffect, useState } from 'react';

function hasSpeechSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis?.speak === 'function' &&
    typeof window.speechSynthesis?.cancel === 'function' &&
    typeof globalThis.SpeechSynthesisUtterance === 'function'
  );
}

export function useSpeech() {
  const [supported] = useState(hasSpeechSupport);
  const [speaking, setSpeaking] = useState(false);

  const stop = useCallback(() => {
    if (!hasSpeechSupport()) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (!hasSpeechSupport()) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  useEffect(() => () => stop(), [stop]);
  return { speak, stop, speaking, supported };
}
```

Run: `npx vitest run lib/hooks/useSpeech.test.ts`

---

## Task 4: `VoiceInputButton` — reusable state-aware mic

**Files**
- Create: `components/VoiceInputButton.tsx`
- Create: `components/VoiceInputButton.module.css`
- Test: `components/VoiceInputButton.test.tsx`

The accessible name must always describe the current action. A supplied label such as `Speak servings` must become `Stop listening for servings` while recognition is active.

### Deterministic recognition fake

The fake must emit a result before `onend`; otherwise the real hook correctly has no final transcript to flush.

```tsx
class FakeRecognition {
  lang = '';
  interimResults = false;
  maxAlternatives = 1;
  continuous = false;
  onresult: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  start = vi.fn();
  abort = vi.fn();
  stop = vi.fn(() => {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: 'eggs' }, isFinal: true, length: 1 }],
    });
    this.onend?.();
  });
}
```

### Implementation contract

```tsx
'use client';

import { useVoiceInput } from '@/lib/hooks/useVoiceInput';
import styles from './VoiceInputButton.module.css';

interface Props {
  onTranscript: (text: string) => void;
  'aria-label'?: string;
}

function listeningLabel(label?: string): string {
  if (!label) return 'Stop listening';
  const subject = label.replace(/^speak\s*/i, '').trim();
  return subject ? `Stop listening for ${subject}` : 'Stop listening';
}

export function VoiceInputButton({ onTranscript, 'aria-label': ariaLabel }: Props) {
  const { supported, listening, interim, error, toggle } = useVoiceInput({ onFinal: onTranscript });
  const label = listening ? listeningLabel(ariaLabel) : (ariaLabel ?? 'Speak');

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        disabled={!supported}
        aria-label={label}
        aria-pressed={listening}
        title={!supported ? 'Voice input is not supported in this browser' : undefined}
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

Tests must click `Speak item name`, then query `Stop listening for item name`, click it, and assert `onTranscript('eggs')`.

Run: `npx vitest run components/VoiceInputButton.test.tsx`

---

## Task 5: `FormInput` and `FormTextarea` gain `voice`

**Files**
- Modify: `components/FormField.tsx`
- Test: `components/FormField.test.tsx`

Add `voice?: boolean` and `onVoice?: (text: string) => void`. Render `VoiceInputButton` beside the input. Voice transcripts must not ride the typed `onChange` callback: Task 7 needs typed `onChange` to clear voice provenance, so routing the transcript through it would erase the "spoken" flag before submit. When `onVoice` is supplied, call it and let the parent own the append plus provenance; otherwise fall back to appending through `onChange` for fields that do not track provenance.

The recognition fake in these tests must emit a final result exactly as in Task 4. Do not use a non-emitting fake and then expect `onChange` to fire.

Example:

```tsx
const voiceButton = voice ? (
  <VoiceInputButton
    aria-label={ariaLabel ? `Speak ${ariaLabel}` : undefined}
    onTranscript={(text) => {
      if (onVoice) {
        onVoice(text);
        return;
      }
      onChange({
        target: { value: appendTranscript(value, text, sep) },
      } as ChangeEvent<HTMLInputElement>);
    }}
  />
) : null;
```

For textarea use `ChangeEvent<HTMLTextAreaElement>`. Tests cover both paths: with `onVoice` the transcript goes to that callback and never touches `onChange`; without it, the value is appended through `onChange`.

Run: `npx vitest run components/FormField.test.tsx`

---

## Task 6: Recipe detail — spoken servings + read-aloud next to each step

**Files**
- Create: `app/recipes/[id]/RecipeReadAloudButton.tsx`
- Modify: `app/recipes/[id]/page.tsx`
- Modify: `app/recipes/[id]/page.module.css`
- Test: `app/recipes/[id]/page.test.tsx`

### Servings mic

```tsx
<VoiceInputButton
  aria-label="Speak servings"
  onTranscript={(text) => {
    const n = parseServings(text);
    if (n !== null) setTargetServings(n);
  }}
/>
```

The recipe-detail speech fake emits `eight servings` before ending. The test clicks `Speak servings`, then `Stop listening for servings`, and verifies the stepper becomes 8.

### Read-aloud button

Do not render a detached block of identical `Read this step` buttons. Place one read control inside each corresponding prep/cooking step row so the visual association is direct, and include the phase plus step number in its accessible name. The recipe model numbers `prepSteps` and `cookingSteps` independently, so a name of only `Read step 1` collides between the two lists; use `Read prep step 1` vs `Read cooking step 1`.

```tsx
'use client';

import { useSpeech } from '@/lib/hooks/useSpeech';

export function RecipeReadAloudButton({
  phase,
  stepNumber,
  text,
}: {
  phase: 'prep' | 'cooking';
  stepNumber: number;
  text: string;
}) {
  const { speak } = useSpeech();
  return (
    <button
      type="button"
      aria-label={`Read ${phase} step ${stepNumber}`}
      onClick={() => speak(text)}
    >
      Read this step
    </button>
  );
}
```

When mapping steps in `page.tsx`, render the button inside the same `<li>`/step container as the instruction and pass `phase="prep"` or `phase="cooking"` accordingly. Build `text` from instruction + timing/temperature + safety note. If a `Read all` control is also desired, render one separate control after the step list and use the same ordered texts.

Run: `npx vitest run app/recipes/[id]/page.test.tsx`

---

## Task 7: Kitchen + recipes search, with correct mutation success semantics

**Files**
- Modify: `app/kitchen/page.tsx`
- Modify: `app/kitchen/page.test.tsx`
- Modify: `app/recipes/page.tsx`
- Modify: `app/recipes/page.test.tsx`

### 7A — make `mutate` report success

The existing kitchen `mutate` catches failures and returns normally. Therefore callers must not infer success from `.then(...)` completion.

Change it to return `Promise<boolean>` (or throw on failure). Preferred minimal contract:

```tsx
async function mutate(/* existing args */): Promise<boolean> {
  try {
    const response = await fetch(/* existing request */);
    if (!response.ok) {
      // preserve the existing visible error handling
      return false;
    }

    // preserve existing refresh/state handling
    return true;
  } catch (error) {
    // preserve the existing visible error handling
    return false;
  }
}
```

Every submit handler must speak only when `ok === true`.

### 7B — per-form latest-edit provenance

For pantry, grocery, leftover, and profile forms, use a boolean such as `pantryVoiceInitiated` that means **the latest relevant edit was from voice**.

Voice callback:

```tsx
onTranscript={(text) => {
  setPantryName((current) => appendTranscript(current, text));
  setPantryVoiceInitiated(true);
}}
```

Typed callback must clear provenance:

```tsx
onChange={(event) => {
  setPantryName(event.target.value);
  setPantryVoiceInitiated(false);
}}
```

For fields rendered through `FormInput`/`FormTextarea`, the voice path is the `onVoice` prop added in Task 5, not a direct `onTranscript`: pass `onVoice={(text) => { setPantryName((c) => appendTranscript(c, text)); setPantryVoiceInitiated(true); }}` and let the typed `onChange` clear it. Raw `<input>` fields render `VoiceInputButton` directly and use `onTranscript` for the same effect. Both paths set provenance true only on the voice callback, never on the typed path.

Apply the same rule to every typed field in that form. If the user speaks, then corrects the value by keyboard, the final submit is treated as typed and remains silent.

### 7C — speak only after confirmed success

```tsx
const wasVoice = pantryVoiceInitiated;
const submittedName = pantryName.trim();
const ok = await mutate(/* pantry request */);

if (ok && wasVoice) {
  speak(`Added ${submittedName} to your pantry`);
}
if (ok) {
  setPantryVoiceInitiated(false);
}
```

Equivalent confirmations:
- Pantry: `Added X to your pantry`
- Grocery: `Added X to your grocery list`
- Leftover: `Logged X`
- Profile: `Saved your dietary profile`

Tests must cover both:
1. voice edit + successful mutation => speech occurs;
2. voice edit + typed correction => speech does **not** occur;
3. voice edit + failed mutation => speech does **not** occur.

### 7D — recipes search mic

```tsx
<VoiceInputButton
  aria-label="Speak recipes search"
  onTranscript={(text) => setSearch(appendTranscript(search, text, undefined))}
/>
```

No spoken confirmation for live search.

Run:

```bash
npx vitest run app/kitchen/page.test.tsx app/recipes/page.test.tsx
```

---

## Task 8: Real raw-CDP verification drivers + `verify:live`

**Files**
- Create: `scripts/drive-kitchen.mjs`
- Modify: `scripts/drive-recipes-page.mjs`
- Modify: `scripts/AGENTS.md`
- Modify: `package.json` or the existing verify-runner script that defines `verify:live`

The repository's recipe driver uses a raw Chrome DevTools Protocol harness with an `evaluate` helper and `fail()` accounting. Do not introduce Puppeteer `page.$`, and do not set `process.exitCode` in code whose final `process.exit(0)` would override the failure.

### 8A — recipes driver

Add the check through the existing `evaluate` helper:

```js
const recipesSearchMicExists = await evaluate(`
  Boolean(document.querySelector('button[aria-label="Speak recipes search"]'))
`);

if (!recipesSearchMicExists) {
  fail('recipes search mic missing');
} else {
  ok('recipes search mic renders');
}
```

Use the existing driver's `ok`/`fail` helpers (there is no `pass` helper) and existing final failure-count exit behavior.

### 8B — create a real kitchen driver

Create `scripts/drive-kitchen.mjs` using the same raw-CDP connection, navigation, `evaluate`, `ok`, `fail`, and cleanup conventions as `drive-recipes-page.mjs`. It must navigate to `/kitchen` and assert the key controls actually render, including at minimum:

```js
const pantryMic = await evaluate(`
  Boolean(document.querySelector('button[aria-label="Speak pantry item name"]'))
`);
if (!pantryMic) fail('pantry item mic missing');

const profileMic = await evaluate(`
  Boolean(document.querySelector('button[aria-label^="Speak"][aria-label*="diet"]'))
`);
if (!profileMic) fail('dietary profile mic missing');
```

Use labels that match the final UI exactly; prefer deterministic exact selectors where practical.

### 8C — wire both drivers into live verification

Update the actual `verify:live` command/runner so both drivers execute. Example only—adapt to the current package structure:

```json
{
  "scripts": {
    "verify:live": "node scripts/drive-recipes-page.mjs && node scripts/drive-kitchen.mjs"
  }
}
```

If `verify:live` already delegates to another runner, add both driver invocations there instead of replacing unrelated checks.

### 8D — scripts documentation

Add to `scripts/AGENTS.md`:

```md
- Voice Everywhere (spec 0004) uses browser Web Speech for transcription and browser SpeechSynthesis for output. It never round-trips through a model outside the existing cook-session path. Every voice control has a typed fallback and voice never auto-submits.
- Live voice UI proofs use the repository's raw-CDP driver helpers (`evaluate`, `ok`, `fail`); do not use Puppeteer `page.*` APIs unless the harness itself is migrated first.
```

Run the drivers through the same local/dev-server procedure already used by the repository, then run:

```bash
npm test
npm run typecheck
npm run verify:live
```

Commit:

```bash
git add scripts/drive-recipes-page.mjs scripts/drive-kitchen.mjs scripts/AGENTS.md package.json
git commit -m "test(scripts): verify voice-everywhere controls with raw CDP"
```

---

## Final verification checklist

- [ ] `parseServings` rejects `none`, `someone`, and `stone`.
- [ ] `useSpeech.supported` is false when `speechSynthesis` or `SpeechSynthesisUtterance` is missing/undefined.
- [ ] Recognition fakes emit a final result before ending.
- [ ] Listening buttons expose `Stop listening for …` names even when a custom `Speak …` label was supplied.
- [ ] Every recipe step's read button is inside that step's row and has a unique accessible name such as `Read prep step 3` and `Read cooking step 2`.
- [ ] Kitchen mutations return explicit success/failure and never speak success after a rejected/failed request.
- [ ] Typed edits clear voice provenance before submit.
- [ ] Recipes live-driver checks use `evaluate` + `fail`, not Puppeteer `page` or `process.exitCode`.
- [ ] `scripts/drive-kitchen.mjs` exists and is invoked by `verify:live`.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run verify:live` passes against the expected environment.
