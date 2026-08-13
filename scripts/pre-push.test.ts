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
// Architecture this locks: the hook's verdict is FULLY delegated to the
// shared driver in --stale-guard mode (scripts/verify-deployed-hash-gate.mjs)
// — the SAME direction-aware verdict the CI validate job runs. The hook
// contains no bash reimplementation of the direction logic (no merge-base
// ancestry code): the driver's exit code IS the verdict (0 = safe, 1 =
// block). There is no exit-2 credential path — the gate is tokenless — so
// the hook must not carry a warn-and-continue branch. The direction logic
// itself is locked by verify-deployed-hash-gate.test.ts; here we lock that
// the hook delegates and mirrors the codes.
// ============================================================================

const HOOK = readFileSync('.githooks/pre-push', 'utf8');

describe('.githooks/pre-push · gate invocation', () => {
  it('runs the shared gate driver in --stale-guard mode, not a reimplementation', () => {
    expect(HOOK).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard');
    // The whole point of the unification: the hook must NOT reimplement the
    // direction logic in bash. If merge-base ancestry code sneaks back in,
    // the two surfaces can drift again — fail here.
    expect(HOOK).not.toContain('merge-base');
    expect(HOOK).not.toContain('is-ancestor');
  });

  it('cds to the repo root before running (hook can fire from any cwd)', () => {
    expect(HOOK).toContain('git rev-parse --show-toplevel');
    expect(HOOK).toContain('cd "$ROOT"');
  });

  it('captures the driver exit code so the verdict can be routed', () => {
    expect(HOOK).toContain('node scripts/verify-deployed-hash-gate.mjs --stale-guard >&2');
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

describe('.githooks/pre-push · exit-code routing (the driver verdict)', () => {
  it('exit 0 (safe: live == HEAD or forward deploy) → proceed', () => {
    expect(HOOK).toContain('[ "$CODE" -eq 0 ]');
    expect(HOOK).toContain('safe to push');
    expect(HOOK).toContain('exit 0');
  });

  it('has NO warn-and-continue credential branch (the gate is tokenless)', () => {
    // The old exit-2 path (invalid/revoked token → warn + continue) is gone
    // with the token chain. A regression that reintroduces it would silently
    // skip the gate on a class of failures that no longer exists — fail here.
    expect(HOOK).not.toContain('-eq 2');
    expect(HOOK).not.toContain('invalid/revoked');
  });

  it('exit 1 (stale head OR unverifiable) → BLOCKS the push with exit 1', () => {
    expect(HOOK).toContain('✗ BLOCKED');
    expect(HOOK).toContain('SKIP_VERIFY_DEPLOYED_HASH=1');
    expect(HOOK).toContain('exit 1');
    // The block must come AFTER the exit-0 branch — a reorder that lets a
    // blocked push fall through to a proceed branch fails here.
    const proceed = HOOK.indexOf('safe to push');
    const blocked = HOOK.indexOf('✗ BLOCKED');
    expect(proceed).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(proceed);
  });
});
