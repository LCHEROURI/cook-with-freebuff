import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/pre-push.test.ts — lock .githooks/pre-push's verify:deployed-hash
// gate.
//
// Same discipline as the other contract tests in this repo: read the REAL
// hook from disk and assert the load-bearing pieces survive future edits, so
// a change that silently breaks the pre-push protection — dropping the gate
// invocation, losing the production-branch scoping, killing the escape hatch,
// flattening the exit-2 credential path, or removing the rollback block —
// fails here instead of at the next `git push`.
//
// The hook's contracts:
//   1. Only production pushes (remote ref refs/heads/main) run the gate —
//      feature-branch pushes never pay the Vercel round-trip.
//   2. SKIP_VERIFY_DEPLOYED_HASH=1 bypasses entirely.
//   3. The shared gate driver (scripts/verify-deployed-hash-gate.mjs) is
//      spawned, not reimplemented — one source of truth with `npm run
//      verify:deployed-hash` and the CI post-deploy gate.
//   4. Exit routing: 0 → no-op note; 2 → invalid token, warn + continue;
//      1 + live behind HEAD (ancestor) → forward-deploy warn + continue;
//      1 + live NOT behind → BLOCKED with exit 1 (rollback protection).
// ============================================================================

const HOOK = readFileSync('.githooks/pre-push', 'utf8');

describe('.githooks/pre-push · gate invocation', () => {
  it('runs the shared verify:deployed-hash gate driver, not a reimplementation', () => {
    expect(HOOK).toContain('node scripts/verify-deployed-hash-gate.mjs');
  });

  it('cds to the repo root before running (hook can fire from any cwd)', () => {
    expect(HOOK).toContain('git rev-parse --show-toplevel');
    expect(HOOK).toContain('cd "$ROOT"');
  });

  it('captures the gate output and exit code so the verdict can be routed', () => {
    expect(HOOK).toContain('OUTPUT="$(node scripts/verify-deployed-hash-gate.mjs 2>&1)"');
    expect(HOOK).toContain('CODE=$?');
  });
});

describe('.githooks/pre-push · production-branch scoping', () => {
  it('only triggers when a pushed remote ref is refs/heads/main', () => {
    expect(HOOK).toContain('while read -r');
    expect(HOOK).toContain('refs/heads/main');
    expect(HOOK).toContain('MAIN_PUSH');
    expect(HOOK).toContain('[ "$MAIN_PUSH" -eq 1 ] || exit 0');
  });

  it('keeps the SKIP_VERIFY_DEPLOYED_HASH escape hatch', () => {
    expect(HOOK).toContain('SKIP_VERIFY_DEPLOYED_HASH');
    expect(HOOK).toContain('${SKIP_VERIFY_DEPLOYED_HASH:-0}');
  });
});

describe('.githooks/pre-push · live-sha parsing', () => {
  it('parses the 40-hex live commit from the gate output', () => {
    // The gate prints "  commit  <sha>" — the hook must extract it to decide
    // direction; a broken parse silently loses the rollback protection.
    expect(HOOK).toContain('LIVE="$(printf');
    expect(HOOK).toContain("sed -n 's/^  commit");
    expect(HOOK).toContain('head -1');
  });
});

describe('.githooks/pre-push · exit-code routing', () => {
  it('exit 0 (live == HEAD) → no-op note and continue', () => {
    expect(HOOK).toContain('live is already at your local HEAD');
    expect(HOOK).toContain('[ "$CODE" -eq 0 ]');
    expect(HOOK).toContain('exit 0');
  });

  it('exit 2 (invalid/revoked token) → warn and continue, never blocks', () => {
    expect(HOOK).toContain('[ "$CODE" -eq 2 ]');
    expect(HOOK).toContain('invalid/revoked token');
  });

  it('exit 1 with no live sha (offline/API error) → warn and continue', () => {
    expect(HOOK).toContain('[ -z "$LIVE" ]');
    expect(HOOK).toContain('offline or Vercel API error');
  });

  it('forward deploy (live is an ancestor of HEAD) → warn and continue', () => {
    expect(HOOK).toContain('git merge-base --is-ancestor "$LIVE" HEAD');
    expect(HOOK).toContain('forward deploy');
  });

  it('live NOT an ancestor of HEAD → BLOCKS the push with exit 1', () => {
    expect(HOOK).toContain('✗ BLOCKED');
    expect(HOOK).toContain('roll the site back');
    expect(HOOK).toContain('exit 1');
    // The block must come AFTER the forward-deploy warn in the routing body
    // (anchored to body-only strings — the header comment also says BLOCKED,
    // which would make a naive indexOf comparison meaningless). A reorder
    // that lets a forward push fall into the block fails here.
    const forward = HOOK.indexOf('(forward deploy)');
    const blocked = HOOK.indexOf('✗ BLOCKED');
    expect(forward).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(forward);
  });
});
