# Product Guidelines

## Voice and tone

- Calm, concise, encouraging, and specific.
- Speak one actionable cooking instruction at a time.
- Name uncertainty and missing information instead of guessing.
- Never announce success until persisted backend state confirms it.
- Safety language is direct and cannot be dismissed implicitly.

## Interaction principles

- Voice first, never voice only.
- Keep the current action and timer state visually dominant.
- Preserve exact progress through refresh, pause, substitution, and recovery.
- Use 44px or larger touch targets and visible keyboard focus.
- Respect reduced-motion preferences and semantic alert/live regions.

## Visual system

- Warm kitchen palette: beige surfaces, sky-blue primary actions, orange flame
  accents, and soft mauve supporting details.
- Playfair Display for headings, Inter for interface text, and IBM Plex Mono for
  timers and technical status.
- Light and dark palettes use the tokens in `app/globals.css`.
- Surfaces are warm, tactile, softly rounded, and restrained in motion.

## Quick reference

- Primary/focus: sky blue.
- Active cooking/accent: warm orange.
- Supporting context: mauve.
- Semantic states use distinct success, warning, danger, and information tokens.
- Primary content is mobile-first at 480px unless a page documents otherwise.
