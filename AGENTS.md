# Cook With Freebuff

A voice first cooking companion that guides you step by step from "what do I have?" to a plated dinner.

## Stack

- **Language / Runtime**: TypeScript, Node 22
- **Framework**: Next.js 15 (App Router)
- **Key dependencies**: Firebase (auth + Firestore), Gemini (AI generation + live voice), Zod (schemas)
- **Package manager**: npm
- **Testing**: Vitest + Testing Library + jsdom

## Build approach

<TBD, set by /scope>

## Commands

```bash
# Install
npm install

# Dev server
npm run dev

# Build
npm run build

# Typecheck
npm run typecheck

# Test
npm test
```

## Specs

Stored in `docs/specs/NNNN-title.md`. Current: 0001 App Hosting primary host, 0002 probe grace constants, 0003 recipe detail page.

## Rules

- Server code lives under `lib/server/` and never imports client code; client code never imports server modules (`server-only` guards enforce this)
- Every API route resolves the Firebase ID token server side via `resolveUserId` — the client never supplies the user id
- All Firestore writes are schema validated (Zod) at the repository layer before persisting
- Tool calls are the only way the AI model touches state — every tool logs latency and error codes to `agent_tool_logs`
- Gemini model names resolve from one shared table (`lib/ai/model-roles.ts`) in the order Remote Config, then env var, then hardcoded default, so a model version can change without a deploy; call sites never hardcode a model name
- Voice flows through hooks (`useVoiceInput`, `useGeminiLive`, `useLiveDictation`), not form field level mic buttons
- Components use controlled inputs with `useState`, not `react-hook-form`
- Tests use `// @vitest-environment jsdom` pragma on component files; default environment is `node`
- Probe cleanup grace durations are declared per driver (`scripts/verify-live.mjs`, `scripts/drive-live-voice.mjs`) with a rationale comment at each declaration, and the shared 15 minute seed grace is pinned identical across both files by the lockstep contract in `scripts/verify-live-cleanup.test.ts`; never introduce a shared constants module (spec 0002)

## Context files

- [ARCHITECTURE.md](ARCHITECTURE.md): layered architecture, request flow, and the Mermaid diagram
- [DATA_MODEL.md](DATA_MODEL.md): domain types, schemas, and Firestore collection layout
- [AGENT_TOOLS.md](AGENT_TOOLS.md): tool registry and the model's structured tool calling surface
- [lib/ai/AGENTS.md](lib/ai/AGENTS.md): AI provider boundary, model resolution, and structured JSON conventions
- [scripts/AGENTS.md](scripts/AGENTS.md): deploy-verification drivers, the Codex review pipeline, and the landing path conventions
- [STATE_MACHINE.md](STATE_MACHINE.md): cooking session phase machine and state transitions
- [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md): realtime voice provider abstraction and Gemini Live integration
- [TESTING.md](TESTING.md): test conventions, jsdom pragma, and the verify driver pattern
- [SECURITY.md](SECURITY.md): auth architecture, token flow, and tool call logging

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
