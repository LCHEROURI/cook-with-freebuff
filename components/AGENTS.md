# components/

## Overview

Reusable and page-specific React components for the voice first cooking screens. The centerpiece is `CookScreen`, the full "Cook With Me" screen; the rest are small focused pieces it or the pages render. Components stay pure and presentational so they render deterministically in tests: remote data arrives through props, never through fetch. Local effect-driven UI state is fine (StarterTour's localStorage gate, CookScreen's timer advance) — the render path itself stays free of side effects.

## Key files

| File | Owns |
|---|---|
| `CookScreen.tsx` | The cooking screen: one action at a time, phase chip, timers, safety gate, transcript, voice input. Pure presentational — every value comes in via `CookScreenProps` |
| `VoiceIndicator.tsx` | Tiny status dot + label for the voice engine state (`LISTENING`/`THINKING`/`SPEAKING`/`OFFLINE`/`ERROR`) |
| `StarterTour.tsx` | First-visit tour for the /cook starter; dismissal remembered in `localStorage` |
| `FormField.tsx` | `FormInput` / `FormTextarea` wrappers with field-UI voice-separator annotations |
| `*.test.tsx` | jsdom component tests (see `TESTING.md`) |

## Conventions

- All components are client components (`'use client'` at the top) using controlled inputs with `useState`, never `react-hook-form`.
- Pure presentational: no fetch, no server calls, no side effects in the render path. All data and callbacks arrive via props (`onDone`, `onSend`, `onStartOver`, ...). This is what makes the tests deterministic.
- Styling comes from page CSS modules imported from `@/app/*/page.module.css`, not local stylesheets in this folder. `VoiceIndicator` uses the global classes `voice-indicator` / `voice-dot` / `voice-label`.
- Accessibility is load bearing: icon-only and otherwise unnamed controls carry an `aria-label` (text buttons rely on their visible name), timers use `role="timer"` with a spoken label, alerts use `role="alert"` / `aria-live`, and the safety gate is a `role="alertdialog"` with an explicit confirm button.
- Browser-dependent test files use the `// @vitest-environment jsdom` pragma and render the component with mocked props; `CookScreen.test.tsx` intentionally skips the pragma and uses `renderToStaticMarkup` under the default Node environment; voice flows are covered in the `*.voice.test.tsx` files.

## Gotchas

- **Paused timers must not tick locally.** `TimerDisplay` freezes the countdown at the server's at-pause remainder while paused (only the "paused 2m ago" caption ticks). The /cook screen must agree with the server card — never tick a paused timer toward zero locally.
- **Start over is two-step.** The first click arms the confirm state, the second fires — archiving the session is irreversible from the screen. The button also disarms on blur.
- **StarterTour shows once.** It reads `localStorage` after mount so SSR and client agree (no flash on repeat visits), and the page dismisses it when the user actually engages with the flow.
- `CookScreen` imports styles from `@/app/cook/page.module.css` — changing a class there changes the screen. There is no local module for it.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
