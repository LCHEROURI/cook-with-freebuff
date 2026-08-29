# Technical Stack

## Application

- TypeScript 5.7 in strict mode and Node.js 22.
- Next.js 15 App Router and React 19.
- CSS Modules plus global CSS custom-property design tokens.
- Progressive Web App assets and service-worker registration.

## Identity, data, and security

- Firebase Authentication with server-side ID-token verification.
- Cloud Firestore with authenticated owner isolation.
- Firebase Admin SDK in server-only modules.
- Firebase App Check using reCAPTCHA v3 for quota-bearing endpoints.
- Zod schemas for runtime input, output, and persistence validation.
- The deployed Firestore rules are shared-project infrastructure; this
  Conductor context owns only Cook With Freebuff requirements.

## AI and voice

- Gemini Developer API behind provider interfaces.
- Gemini Live with ephemeral server-minted credentials.
- Firebase Remote Config for model-role selection with environment and code
  fallbacks.
- Browser Web Speech and typed input as fallbacks.

## Hosting and delivery

- Firebase App Hosting on Cloud Run SSR.
- GitHub Actions for validation, deployment, live verification, and Codex review.
- npm with a committed lockfile.

## Testing

- Vitest 3; Node environment by default.
- Testing Library and jsdom for browser-dependent tests.
- Firebase emulators for data and transaction behavior.
- Contract tests that read real scripts and workflows.
- Raw-CDP drivers for deployed UI and voice verification.

## Architecture decisions

### 2026-08-21 — Single-product Conductor scope

Conductor is initialized only for `cook-with-freebuff`. A parent directory name,
shared Firebase project, or shared ruleset does not expand the active scope.

### 2026-08-21 — Server-derived identity

Protected routes verify Firebase credentials and derive the user ID on the
server. Client identity fields are never authoritative.

### 2026-08-21 — Contract-locked production delivery

Meaningful changes follow the branch and PR path and satisfy local checks,
required CI, and applicable deployed verification contracts.
