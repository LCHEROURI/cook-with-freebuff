import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-gate-stale-ci.test.ts — lock the post-deploy teeth-proof
// wrapper's contract.
//
// Reads the REAL wrapper from disk and asserts the load-bearing lines survive
// future edits: the shallow-checkout deepen fallback, the precondition probe
// (which reuses the gate's OWN --stale-guard --head direction logic — a
// duplicated verdict implementation here would be the bug), the three
// skip-not-fail branches, and the proof propagation. A future edit that
// silently drops the probe (and would then fail the run on every deploy-lag
// transient) fails here.
// ============================================================================

const WRAPPER = readFileSync('scripts/verify-gate-stale-ci.mjs', 'utf8');

describe('scripts/verify-gate-stale-ci.mjs · post-deploy teeth-proof wrapper', () => {
  it('resolves the parent commit via HEAD~1 by EXIT STATUS (a failed rev-parse echoes its input), with the VERIFY_GATE_STALE_HEAD override', () => {
    // The status check is load-bearing: on a shallow checkout `git rev-parse
    // HEAD~1` FAILS (exit 128) but still echoes 'HEAD~1' to stdout, so a
    // stdout-only check would treat the echo as a resolved parent, skip the
    // deepen, and run the probe with the literal 'HEAD~1' (which can never
    // reproduce a verdict). The teeth runner already checks status; the
    // wrapper must too.
    expect(WRAPPER).toContain('return r.status === 0 ? r.stdout.trim() : \'\';');
    expect(WRAPPER).toContain('still echoes its input');
    expect(WRAPPER).toContain('VERIFY_GATE_STALE_HEAD');
  });

  it('deepens a shallow checkout before resolving HEAD~1, and SKIPs loudly if even that fails', () => {
    // CI checkouts default to fetch-depth 1 — the parent object is absent, so
    // `git rev-parse HEAD~1` fails. The deepen is what makes the proof run at
    // all on the runner; a future edit that removes it would make the wrapper
    // SKIP (or fail) on every CI run. The fallback must SKIP, never fail.
    expect(WRAPPER).toContain("run('git', ['fetch', '--deepen=1', 'origin'], { cwd: ROOT })");
    expect(WRAPPER).toContain("SKIP: gate-stale proof could not resolve the pushed commit's parent (shallow checkout; git fetch --deepen=1 failed).");
    expect(WRAPPER).toContain('process.exit(0)');
  });

  it('probes with the gate\u2019s OWN direction logic — --stale-guard --head <parent> — never a duplicated verdict', () => {
    // The skip decision reuses verify-deployed-hash-gate.mjs's direction
    // logic. The probe invocation is the load-bearing line: without --head
    // the probe would compare against the checkout HEAD (the pushed commit,
    // which live IS ahead of) and the wrapper would run the proof even in
    // deploy-lag states where it cannot reproduce.
    expect(WRAPPER).toContain("run(process.execPath, ['scripts/verify-deployed-hash-gate.mjs', '--stale-guard', '--head', parent], { cwd: ROOT })");
  });

  it('SKIPs-not-fails on all three transient edges: deploy lag (exit 0), API/credential transient (exit 2), and fail-loud-no-live (exit 1 without the BLOCK line)', () => {
    // The blocked condition is the ONLY path that proceeds — everything else
    // is a loud SKIP with exit 0. The reason strings distinguish the deploy
    // (exit 0) from the API/credential (exit 2 / fail-loud) transients so the
    // log explains WHY the teeth were not proven.
    expect(WRAPPER).toContain("const blocked = probe.status === 1 && out(probe).includes('✗ STALE-HEAD BLOCK');");
    expect(WRAPPER).toContain('SKIP: gate-stale proof could not reproduce right after this deploy');
    expect(WRAPPER).toContain('alias promotion lag');
    expect(WRAPPER).toContain('Vercel API / credential transient');
    expect(WRAPPER).toContain('not a failure');
  });

  it('runs the gate-stale proof (the definition behind npm run verify:gate-stale-proof) and propagates its verdict', () => {
    // Proceed path: the teeth runner is spawned directly (stdlib-only, so the
    // wrapper works in jobs without npm ci) with the exact composite mode the
    // npm script wraps, and the proof's exit code IS the wrapper's exit code —
    // a regression (verdict absent where it must appear) fails the run.
    expect(WRAPPER).toContain("run(process.execPath, ['scripts/verify-teeth-proofs.mjs', 'gate-stale'], { cwd: ROOT })");
    expect(WRAPPER).toContain('process.exit(proof.status ?? 1)');
    expect(WRAPPER).toContain('exit 1 = a teeth regression on the real runner');
  });
});
