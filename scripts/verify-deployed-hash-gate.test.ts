import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-deployed-hash-gate.test.ts — lock the verify:deployed-hash
// gate driver.
//
// Same discipline as verify-live-local.test.ts / ci-workflows.test.ts: read
// the REAL script from disk and assert the load-bearing pieces survive future
// edits, so a change that silently breaks the pre-deploy gate — drifting the
// live URL, losing the local-HEAD wiring, swallowing the exit-2 credential
// path, or reversing the HEAD-then-compare sequence — fails here instead of
// at the next deploy.
//
// The gate's contracts:
//   1. It must target the live PRODUCTION alias (public, not
//      deployment-protected) — the same URL the CI drift watch uses.
//   2. Local HEAD must be resolved FIRST via git rev-parse HEAD and passed to
//      the shared driver as --expect, so the gate compares live vs the
//      operator's actual working tree.
//   3. The shared driver (scripts/verify-deployed-hash.mjs) must be SPAWNED
//      (not reimplemented) — one source of truth with the post-deploy gate.
//   4. Exit codes must mirror the child: 0/1 forward, and exit 2 (invalid or
//      revoked VERCEL_TOKEN) must stay DISTINCT from FAIL so a caller can
//      surface a credential problem instead of a gate failure.
// ============================================================================

const SRC = readFileSync('scripts/verify-deployed-hash-gate.mjs', 'utf8');

describe('scripts/verify-deployed-hash-gate.mjs · live-URL contract', () => {
  it('targets the canonical production alias (public, not deployment-protected)', () => {
    // The deployment-specific subdomain answers 401 Protected deployment; the
    // canonical alias is public — the gate must hit the alias, exactly like
    // the CI drift-watch step.
    expect(SRC).toContain("export const CANONICAL_URL = 'https://cook-with-freebuff.vercel.app';");
    // The canonical URL must actually be the one passed to the hash driver.
    expect(SRC).toContain("'--url', CANONICAL_URL");
  });
});

describe('scripts/verify-deployed-hash-gate.mjs · local-HEAD comparison', () => {
  it('resolves local HEAD via git rev-parse before comparing', () => {
    expect(SRC).toContain("spawnSync('git', ['rev-parse', 'HEAD']");
    expect(SRC).toContain("const LOCAL_HEAD = head.stdout.trim();");
  });

  it('passes the resolved HEAD as --expect to the shared driver', () => {
    expect(SRC).toContain("'--expect', LOCAL_HEAD");
  });

  it('fails loudly when git rev-parse itself fails', () => {
    expect(SRC).toContain('could not resolve local HEAD');
    expect(SRC).toContain('process.exit(1);');
  });

  it('runs the HEAD resolution BEFORE the hash driver spawn', () => {
    const headIdx = SRC.indexOf("spawnSync('git', ['rev-parse', 'HEAD']");
    const spawnIdx = SRC.indexOf("['scripts/verify-deployed-hash.mjs'");
    expect(headIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(headIdx);
  });
});

describe('scripts/verify-deployed-hash-gate.mjs · shared-driver composition', () => {
  it('spawns the existing verify-deployed-hash.mjs instead of reimplementing it', () => {
    // One source of truth with the CI post-deploy gate: same token chain,
    // team resolution, v13 lookup, and exit-code contract.
    expect(SRC).toContain("spawnSync(\n  process.execPath,\n  ['scripts/verify-deployed-hash.mjs'");
    // stdio inherited so the child's report + RESULT: verdict pass through.
    expect(SRC).toContain("stdio: 'inherit'");
  });

  it('mirrors the child exit code (0 = PASS, 1 = FAIL)', () => {
    expect(SRC).toContain('const code = child.status ?? 1;');
    expect(SRC).toContain('process.exit(code);');
  });

  it('keeps the exit-2 credential path distinct from a generic FAIL', () => {
    // An invalid/revoked VERCEL_TOKEN must surface as exit 2 (paste a fresh
    // token), never be flattened into exit 1 — the contract the CI gate and
    // any future ship:ready caller rely on.
    expect(SRC).toContain('if (code === 2) {');
    expect(SRC).toContain('process.exit(2);');
    const exit2 = SRC.indexOf('if (code === 2) {');
    const exit2Call = SRC.indexOf('process.exit(2);');
    expect(exit2Call).toBeGreaterThan(exit2);
    // The exit-2 branch must precede the generic forward (a reorder that
    // lets exit 2 fall through to exit(code) fails here).
    expect(SRC.indexOf('process.exit(2);')).toBeLessThan(SRC.indexOf('process.exit(code);'));
  });
});
