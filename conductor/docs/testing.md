# Testing Context

## Layers

- Pure domain and service tests run in Node.
- Browser-dependent components and hooks opt into jsdom per test file.
- Route tests mock authentication, App Check, and production context while using
  deterministic in-memory stores.
- Emulator tests prove Firestore ownership and transaction behavior.
- Contract tests inspect real scripts, workflows, configs, and golden text.
- Live drivers verify deployed commit, auth, cooking, voice, persistence, and
  cleanup.

## Rules

- Write the failing test before production behavior changes.
- Test both success and the security/error boundary.
- Use deterministic users, clocks, IDs, and correlation IDs.
- Do not relax golden comparators or cleanup protections.
- Preserve probe namespaces and grace periods in `scripts/AGENTS.md`.

## Standard commands

- Focused: `npm test -- <test-file>`
- Full suite: `npm test`
- Emulator: `npm run test:emulator`
- Aggregate gate: `npm run check`
- Deployed flow: `npm run verify:live`

The clean baseline passed `npm test` on 2026-08-21.
