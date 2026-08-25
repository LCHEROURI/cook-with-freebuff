# Delivery Workflow

## TDD strictness

TDD is strict for meaningful behavior and security changes.

1. Red: add the smallest focused test and run it to prove the intended failure.
2. Green: implement the minimum code that satisfies the test.
3. Refactor: improve the design while focused and related tests stay green.

Contract-sensitive scripts and workflows require tests that read the real file,
not a copied fixture. Component tests opt into jsdom only when browser APIs are
required; the default environment remains Node.

## Commit and landing strategy

- Use `type(scope): description` commit subjects.
- Include the track ID in Conductor task commits.
- Commit each completed implementation task and record its hash in metadata.
- Never commit `.env*.local`, credentials, `.freebuff/`, generated builds, or
  unrelated user changes.
- Meaningful changes land through the branch + PR workflow, never direct `main`.

## Quality gates

- Focused tests during Red/Green/Refactor.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
- `npm run check` as the aggregate local gate.
- Emulator tests when persistence, ownership, or transactions change.
- Applicable live verification when a track changes production flows.
- New testable logic targets at least 80% line coverage.

## Verification checkpoints

- Run phase-specific checks after every phase.
- Report completed tasks, commands, results, manual verification, and limits.
- Stop for explicit user approval before beginning the next phase.
- Stop on test, Git, or tool failure and present recovery choices.
- Do not weaken an existing contract or live gate to make a change pass.

## Definition of done

- Acceptance criteria have evidence.
- Required automated and manual checks pass.
- Security and ownership invariants remain explicit.
- Existing specs and plans are updated when their contracts change.
- Conductor plan, metadata, registry, and commit list reflect actual progress.
