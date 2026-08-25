import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-deployed-hash-gate.test.ts — lock the verify:deployed-hash
// gate driver.
//
// Same discipline as verify-live-local.test.ts / ci-workflows.test.ts: read
// the REAL script from disk and assert the load-bearing pieces survive future
// edits, so a change that silently breaks the pre-deploy gate — drifting the
// live URL, losing the local-HEAD wiring, reintroducing a credential path, or
// reversing the HEAD-then-compare sequence — fails here instead of at the
// next deploy.
//
// The gate's contracts:
//   1. It must target the canonical Firebase App Hosting URL (public — the
//      /api/build-info read needs no token).
//   2. Local HEAD must be resolved FIRST via git rev-parse HEAD and passed to
//      the shared driver as --expect, so the gate compares live vs the
//      operator's actual working tree.
//   3. The shared driver (scripts/verify-deployed-hash.mjs) must be SPAWNED
//      (not reimplemented) — one source of truth with every other gate.
//   4. Exit codes must mirror the child (0 = PASS, 1 = FAIL). There is no
//      exit-2 credential path anymore — the gate is tokenless, so any
//      reintroduced exit-2/VERCEL_TOKEN machinery fails the negative lock.
// ============================================================================

const SRC = readFileSync('scripts/verify-deployed-hash-gate.mjs', 'utf8');

describe('scripts/verify-deployed-hash-gate.mjs · live-URL contract', () => {
  it('targets the canonical App Hosting URL (public — no token needed)', () => {
    expect(SRC).toContain("export const CANONICAL_URL = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';");
    // The canonical URL must actually be the one passed to the hash driver.
    expect(SRC).toContain("'--url', CANONICAL_URL");
  });

  it('passes only --url and --expect to the shared driver (no second host, no token)', () => {
    expect(SRC).toContain("['scripts/verify-deployed-hash.mjs', '--url', CANONICAL_URL, '--expect', LOCAL_HEAD]");
    expect(SRC).not.toContain('--apphosting-url');
    expect(SRC).not.toContain('VERCEL_TOKEN');
  });
});

describe('scripts/verify-deployed-hash-gate.mjs · local-HEAD comparison', () => {
  it('resolves local HEAD via git rev-parse before comparing', () => {
    // The resolution now lives in the else branch of the --head split (the
    // PR-time variant pins the expected head instead), but the operator
    // contract is unchanged: rev-parse output feeds LOCAL_HEAD.
    expect(SRC).toContain("spawnSync('git', ['rev-parse', 'HEAD']");
    expect(SRC).toContain('LOCAL_HEAD = head.stdout.trim();');
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
    // stdio piped so --stale-guard can parse the live commit; the child's
    // output is still forwarded verbatim either way.
    expect(SRC).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(SRC).toContain('if (child.stdout) process.stdout.write(child.stdout);');
    expect(SRC).toContain('if (child.stderr) process.stderr.write(child.stderr);');
  });

  it('mirrors the child exit code (0 = PASS, 1 = FAIL)', () => {
    expect(SRC).toContain('const code = child.status ?? 1;');
    expect(SRC).toContain('process.exit(code);');
  });

  it('has NO exit-2 credential path — the gate is tokenless', () => {
    // The migration removed the token chain, so exit 2 no longer exists: a
    // mismatch is simply exit 1, and any reintroduced VERCEL_TOKEN or exit-2
    // handling fails here (a silent credential degradation would resurface
    // the old "cannot verify, warn and continue" hole in the hook).
    expect(SRC).not.toContain('process.exit(2)');
    expect(SRC).not.toContain('code === 2');
    expect(SRC).not.toContain('VERCEL_TOKEN');
  });
});

describe('scripts/verify-deployed-hash-gate.mjs · --stale-guard direction routing', () => {
  it('defines the flag and only applies direction routing when it is set', () => {
    expect(SRC).toContain("export const STALE_GUARD = process.argv.includes('--stale-guard');");
    // Without the flag the plain mismatch is still the verdict.
    expect(SRC).toContain('if (!STALE_GUARD) process.exit(1);');
  });

  it('parses the live commit sha from the child report', () => {
    // The direction call needs the live sha — a broken parse silently loses
    // the stale-head protection (and would block every forward push).
    expect(SRC).toContain("childOut.match(/^  commit  ([0-9a-f]{40})$/m)");
  });

  it('fails loudly when the live commit cannot be determined', () => {
    expect(SRC).toContain('could not determine the live commit');
    expect(SRC).toContain('process.exit(1);');
  });

  it('forward deploy (live is an ancestor of the expected head) → PASS, left to the post-deploy gate', () => {
    // The ancestry check targets LOCAL_HEAD (the resolved expected head —
    // local HEAD, or the --head value on PRs) rather than the literal
    // checkout HEAD: on a PR the checkout is the MERGE ref, which always
    // contains current base main and would make every stale PR pass.
    expect(SRC).toContain("spawnSync('git', ['merge-base', '--is-ancestor', live, LOCAL_HEAD])");
    expect(SRC).toContain('RESULT: PASS (stale-guard)');
    expect(SRC).toContain('process.exit(0);');
  });

  it('stale head (live NOT an ancestor) → STALE-HEAD BLOCK with exit 1', () => {
    expect(SRC).toContain('✗ STALE-HEAD BLOCK');
    expect(SRC).toContain('Pushing would roll the site back or clobber history');
    expect(SRC).toContain('RESULT: FAIL');
    // The block must come AFTER the forward-pass check — a reorder that lets
    // a stale push fall into the PASS branch fails here.
    const forward = SRC.indexOf('RESULT: PASS (stale-guard)');
    const blocked = SRC.indexOf('✗ STALE-HEAD BLOCK');
    expect(forward).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(forward);
  });

  it('content-equivalent head (live NOT an ancestor, identical TREE) → PASS', () => {
    // Squash merges break ancestry, not content: merging a branch that was
    // deployed out-of-band (e.g. from its own PR head) creates a fresh commit
    // whose tree is byte-identical to what production serves while containing
    // NONE of live's history. The ancestry rule alone then blocks a push that
    // changes nothing — observed for real on the post-squash #166 main push.
    // The gate must therefore compare TREE oids when ancestry fails and PASS
    // as content-equivalent when they match; only a genuinely different tree
    // may reach the STALE-HEAD BLOCK.
    expect(SRC).toContain("spawnSync('git', ['rev-parse', `${live}^{tree}`]");
    expect(SRC).toContain("spawnSync('git', ['rev-parse', `${LOCAL_HEAD}^{tree}`]");
    expect(SRC).toContain('RESULT: PASS (stale-guard · content-equivalent)');
    // Ordering: the escape hatch sits between the failed ancestry check and
    // the block. A tree-mismatch must still be able to reach the block.
    const ancIdx = SRC.indexOf("['merge-base', '--is-ancestor', live, LOCAL_HEAD]");
    const equivIdx = SRC.indexOf('RESULT: PASS (stale-guard · content-equivalent)');
    const blocked = SRC.indexOf('✗ STALE-HEAD BLOCK');
    expect(ancIdx).toBeGreaterThan(-1);
    expect(equivIdx).toBeGreaterThan(ancIdx);
    expect(blocked).toBeGreaterThan(equivIdx);
  });

  it('fails loudly when the tree comparison cannot run (no silent green)', () => {
    // A broken rev-parse on either side must not silently fall through to
    // either verdict — the same no-silent-green discipline as the live-sha
    // and commit-fetch failure paths above.
    expect(SRC).toContain('could not compare trees');
  });
});

describe('scripts/verify-deployed-hash-gate.mjs · --head (PR-time variant)', () => {
  it('parses the --head flag and pins the compared-against commit to it', () => {
    // The PR-time step passes github.event.pull_request.head.sha; the gate
    // must use THAT commit for both the --expect wiring and the ancestry
    // check — never the checkout's HEAD (the merge ref).
    expect(SRC).toContain("process.argv.indexOf('--head')");
    expect(SRC).toContain('HEAD_ARG ? \'PR head\' : \'local HEAD\'');
  });

  it('falls back to git rev-parse only when --head is absent', () => {
    // The operator/push-time contract (local HEAD) must remain the default;
    // --head is the PR override. A refactor that resolves local HEAD
    // unconditionally (silently ignoring --head) fails here.
    expect(SRC).toContain('if (HEAD_ARG) {');
    expect(SRC).toContain('LOCAL_HEAD = HEAD_ARG;');
    const headFlagIdx = SRC.indexOf("process.argv.indexOf('--head')");
    const revParseIdx = SRC.indexOf("spawnSync('git', ['rev-parse', 'HEAD']");
    expect(headFlagIdx).toBeGreaterThan(-1);
    expect(revParseIdx).toBeGreaterThan(headFlagIdx);
  });

  it('passes the pinned head as --expect to the shared driver', () => {
    // With --head, the driver still sees the same --expect LOCAL_HEAD wiring
    // (LOCAL_HEAD IS the --head value) — one comparison pipeline, both modes.
    expect(SRC).toContain("'--expect', LOCAL_HEAD");
  });

  it('unshallows the checkout before the ancestry check (shallow CI checkout)', () => {
    // The CI checkout is fetch-depth 1: HEAD is a shallow boundary with NO
    // parents, so `git merge-base --is-ancestor live HEAD` can never walk
    // back to live and would falsely block EVERY forward push. The gate must
    // detect the shallow repo (rev-parse --is-shallow-repository) and deepen
    // it (fetch --unshallow origin) before the merge-base call — the
    // cat-file-then-fetch fallback alone only fetches missing OBJECTS, it
    // cannot restore HEAD's missing parent chain.
    expect(SRC).toContain("spawnSync('git', ['rev-parse', '--is-shallow-repository']");
    expect(SRC).toContain("spawnSync('git', ['fetch', '--quiet', '--unshallow', 'origin'])");
    // The unshallow step must run BEFORE the ancestry check.
    const unshallowIdx = SRC.indexOf("['fetch', '--quiet', '--unshallow', 'origin']");
    const ancIdx = SRC.indexOf("['merge-base', '--is-ancestor', live, LOCAL_HEAD]");
    expect(unshallowIdx).toBeGreaterThan(-1);
    expect(ancIdx).toBeGreaterThan(unshallowIdx);
  });

  it('fails loudly when the shallow checkout cannot be deepened', () => {
    expect(SRC).toContain('could not deepen the shallow checkout for the ancestry check');
    expect(SRC).toContain('process.exit(1);');
  });

  it('fetches commits by sha from origin before the ancestry check (shallow CI checkout)', () => {
    // After unshallowing, the live commit is present on a normal forward push,
    // but the PR-head case (an unmerged branch) still needs the by-sha fetch:
    // the head sha is not reachable from origin/main. The cat-file-then-fetch
    // fallback makes the direction decision real for that case.
    expect(SRC).toContain("spawnSync('git', ['cat-file', '-e', sha])");
    expect(SRC).toContain("spawnSync('git', ['fetch', '--quiet', 'origin', sha])");
    // The fetch must run BEFORE the ancestry check.
    const fetchIdx = SRC.indexOf("['fetch', '--quiet', 'origin', sha]");
    const ancIdx = SRC.indexOf("['merge-base', '--is-ancestor', live, LOCAL_HEAD]");
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(ancIdx).toBeGreaterThan(fetchIdx);
  });

  it('fails loudly when the commits needed for the ancestry check cannot be fetched', () => {
    expect(SRC).toContain('could not fetch the commits needed for the ancestry check');
    expect(SRC).toContain('process.exit(1);');
  });
});
