# TypeScript Style Guide

- Keep strict mode enabled; do not use `any` to cross a trust boundary.
- Validate untrusted data with existing Zod schemas at its boundary.
- Use `import type` for type-only dependencies.
- Keep `lib/server/` server-only and out of client modules.
- API routes derive `userId` from `resolveUserId`; request data is not authority.
- Services depend on narrow store/provider interfaces with in-memory test stores.
- Keep state-machine and authorization decisions in small testable functions.
- React components use controlled inputs and receive remote data through props.
- Model access uses provider interfaces and model-role resolution.
- Comments document invariants and non-obvious failure behavior.
