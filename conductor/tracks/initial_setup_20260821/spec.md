# Spec: initial_setup_20260821

## Goal

Initialize a single-product Conductor context for Cook With Freebuff.

## Acceptance Criteria

- [x] Product scope names only `cook-with-freebuff`.
- [x] Context reflects the existing repository and design system.
- [x] Existing specs, plans, AGENTS instructions, and gates remain authoritative.
- [x] Track registry and setup state are initialized.

## Functional Requirements

- Agents can navigate context from `conductor/index.md`.
- Future tracks use a stable registry and directory convention.

## Non-Functional Requirements

- No secrets, environment values, or other active product scopes are introduced.
- Workflow requires TDD, 80% coverage for new logic, and phase approval.

## Out of Scope

- Application implementation changes.
- Firebase or provider configuration changes.
