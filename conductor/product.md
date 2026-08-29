# Product: Cook With Freebuff

## Vision

Help a home cook move from “what do I have?” to a plated dinner through a
voice-first, screen-light companion that stays honest, safe, and resumable.

## Problem

Cooking is hands-busy and stateful. Ordinary recipe pages force cooks to scroll,
remember context, translate quantities, manage timers, and recover manually when
ingredients or plans change. Conversational AI can help only if it never invents
state, skips safety gates, or claims an action succeeded before persistence is
confirmed.

## Users

- Primary: home cooks using a phone while preparing a meal.
- Accessibility: cooks who benefit from large touch targets, spoken guidance,
  typed fallbacks, reduced motion, and strong contrast.

## Core capabilities

- Capture available ingredients by voice, text, or image.
- Generate and validate structured recipes under dietary and equipment
  constraints.
- Guide one physical action at a time through a persistent session state machine.
- Persist recipes, pantry items, leftovers, grocery items, timers, profiles, and
  audit events per authenticated user.
- Support corrections, substitutions, pause/resume, safety confirmation, and
  bounded recovery without losing the cook's exact place.
- Offer Gemini Live voice with browser speech and typed fallbacks.

## Non-goals

- A general meal-planning product or application portfolio dashboard.
- Storing culinary state only in conversation history.
- Allowing the model to write application state outside registered tools.
- Trusting client-provided user identities.

## Constraints

- The only active product in this Conductor context is `cook-with-freebuff`.
- Protected routes derive identity from a verified Firebase ID token.
- Firestore writes cross the repository layer and are Zod validated at the
  documented boundary.
- Quota-bearing AI routes preserve App Check gating.
- Server modules never enter client bundles.
- Voice features retain a typed fallback and never auto-submit.
- Existing specs, contract tests, deployment gates, and PR-only landing rules
  remain authoritative.
