import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/codex-review-pr-gate.test.ts — lock the PR-time Codex review gate.
//
// The chatgpt-codex-connector[bot] posts inline review comments on a PR after
// it opens; the post-merge monitor catches untriaged findings, but a PR can
// still MERGE with an open P1. This gate runs as a required check on the PR.
// Load-bearing properties locked here: it reads ONLY the bot's comments and
// reviews; classifies severity from the badge URL and blocks on P0/P1 by
// default (P2 only with --include-p2, and never P3+); treats a finding as
// OPEN until a human reply lands on its thread (in_reply_to_id — the
// resolution-note convention); scopes findings to the CURRENT head so a
// stale comment from a previous commit cannot block; and waits for a real
// Codex review of the head before passing — an empty comment list is NOT a
// clean review. The workflow re-runs on review-comment (created + deleted)
// and review events so a late bot review or a deleted resolution reply still
// updates the check. A future edit that drops the bot filter, the
// reply-based resolution, the P0/P1 default, the head scoping, or the
// wait-for-review fails here instead of silently letting P1s merge.
// ============================================================================

const GATE = readFileSync('scripts/codex-review-pr-gate.mjs', 'utf8');
const WORKFLOW = readFileSync('.github/workflows/codex-review-pr-gate.yml', 'utf8');

describe('scripts/codex-review-pr-gate.mjs', () => {
  it('requires a PR number (--pr or PR_NUMBER) and exits 2 on usage error', () => {
    expect(GATE).toContain("take('--pr') ?? process.env.PR_NUMBER");
    expect(GATE).toContain('if (!pr) {');
    expect(GATE).toContain('process.exit(2)');
  });

  it('reads the bot comments and reviews, paginated and slurped, and resolves the head', () => {
    expect(GATE).toContain("const BOT_LOGIN = 'chatgpt-codex-connector[bot]';");
    expect(GATE).toContain("c.user?.login !== BOT_LOGIN");
    expect(GATE).toContain('pulls/${pr}/comments?per_page=100');
    expect(GATE).toContain('pulls/${pr}/reviews?per_page=100');
    expect(GATE).toContain('gh api --paginate');
    expect(GATE).toContain('--slurp');
    expect(GATE).toContain(')).flat()');
    // Findings are scoped to the current head (stale comments from a previous
    // commit cannot block a head that already addressed them).
    expect(GATE).toContain('pulls/${pr}"`)).head.sha');
    expect(GATE).toContain('c.commit_id != null && c.commit_id !== headSha');
  });

  it('classifies severity from the badge URL and blocks on P0 and P1 by default', () => {
    expect(GATE).toContain("c.body.match(/badge\\/(P\\d)-/)");
    // Explicit blocking sets: P0/P1 by default, P2 added only with --include-p2,
    // and never P3+ (Codex P1, PR #73 review).
    expect(GATE).toContain("const BLOCKING_DEFAULT = new Set(['P0', 'P1'])");
    expect(GATE).toContain("const BLOCKING_INCLUDE_P2 = new Set(['P0', 'P1', 'P2'])");
    expect(GATE).toContain('args.includes(\'--include-p2\')');
  });

  it('treats a finding as resolved only once its thread has a reply', () => {
    expect(GATE).toContain('c.in_reply_to_id != null');
    expect(GATE).toContain('repliedTo.has(String(c.id))');
  });

  it('waits for a real Codex review of the head — empty is NOT clean (Codex P1, PR #73 review)', () => {
    expect(GATE).toContain('CODEX_GATE_WAIT_SECONDS');
    expect(GATE).toContain('--allow-no-review');
    expect(GATE).toContain('no Codex review observed on head');
    expect(GATE).toContain('cannot be');
    expect(GATE).toContain('distinguished from no review yet');
    expect(GATE).toContain('process.env.CODEX_GATE_ALLOW_NO_REVIEW === \'true\'');
    // The bot-skipped-PR certification must ride a pull_request-triggered
    // run (a workflow_dispatch check never enters the PR status rollup, so
    // only the repo-variable path can satisfy the required merge gate).
    expect(GATE).toContain('CODEX_GATE_BOT_SKIPPED_PRS');
    expect(WORKFLOW).toContain('CODEX_GATE_BOT_SKIPPED_PRS: ${{ vars.CODEX_GATE_BOT_SKIPPED_PRS }}');
  });

  it('exits 1 with the blocking findings listed when an open P0/P1 exists', () => {
    expect(GATE).toContain('blocking.length === 0');
    expect(GATE).toContain('process.exit(0)');
    expect(GATE).toContain('process.exit(1)');
    expect(GATE).toContain('open Codex finding(s) on PR');
  });

  it('the workflow reports the check under the exact required-check name', () => {
    expect(WORKFLOW).toContain('name: Codex P1 gate');
  });

  it('the workflow re-runs on review-comment (created + deleted) and review events', () => {
    expect(WORKFLOW).toContain('pull_request:');
    expect(WORKFLOW).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(WORKFLOW).toContain('pull_request_review_comment:');
    // A deleted resolution reply re-opens its finding — the check must
    // recompute rather than keep the stale green (Codex P2, PR #73 review).
    expect(WORKFLOW).toContain('types: [created, deleted]');
    expect(WORKFLOW).toContain('pull_request_review:');
    expect(WORKFLOW).toContain('workflow_dispatch:');
  });

  it('the workflow passes PR_NUMBER + GH_TOKEN, the allow-no-review dispatch input, and read-only perms', () => {
    expect(WORKFLOW).toContain('GH_TOKEN: ${{ github.token }}');
    expect(WORKFLOW).toContain('PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || github.event.inputs.pr }}');
    expect(WORKFLOW).toContain('CODEX_GATE_ALLOW_NO_REVIEW: ${{ github.event.inputs.allow_no_review == \'true\' }}');
    expect(WORKFLOW).toContain('allow_no_review:');
    expect(WORKFLOW).toContain('pull-requests: read');
    expect(WORKFLOW).toContain('node scripts/codex-review-pr-gate.mjs');
  });

  it('behaves end to end against a stubbed gh', () => {
    const bot = 'chatgpt-codex-connector[bot]';
    const HEAD = 'abc123def456';
    const OLD = 'deadbeef00';

    const P = (id: number, severity: string, commit = HEAD, path = 'lib/a.ts') => ({
      id,
      user: { login: bot },
      body: `**<sub><sub>![${severity} Badge](https://img.shields.io/badge/${severity}-orange)</sub></sub>\n\nThis is the ${severity} finding text`,
      path,
      line: 3,
      commit_id: commit,
      html_url: `https://example.com/r${id}`,
    });
    const reply = (to: number) => ({
      id: to + 1_000_000,
      user: { login: 'LCHEROURI' },
      in_reply_to_id: to,
      body: 'Resolved and merged.',
    });
    const botReview = { user: { login: bot }, commit_id: HEAD, state: 'COMMENTED' };

    const run = (
      comments: unknown[],
      opts: { reviews?: unknown[]; extraArgs?: string; extraEnv?: Record<string, string> } = {},
    ) => {
      const { reviews = [botReview], extraArgs = '', extraEnv = {} } = opts;
      const stubDir = mkdtempSync(join(tmpdir(), 'codex-gate-stub-'));
      const stubPath = join(stubDir, 'gh');
      writeFileSync(
        stubPath,
        `#!/usr/bin/env node
const HEAD = ${JSON.stringify(HEAD)};
const comments = ${JSON.stringify(comments)};
const reviews = ${JSON.stringify(reviews)};
const url = process.argv.join(' ');
if (url.includes('/42/comments?')) {
  process.stdout.write(JSON.stringify([comments]));
} else if (url.includes('/42/reviews?')) {
  process.stdout.write(JSON.stringify([reviews]));
} else if (url.includes('pulls/42')) {
  process.stdout.write(JSON.stringify({ head: { sha: HEAD } }));
} else {
  process.exit(1);
}
`,
      );
      chmodSync(stubPath, 0o755);
      try {
        try {
          const out = execSync(
            `node scripts/codex-review-pr-gate.mjs --repo fake/repo --pr 42 ${extraArgs}`,
            {
              encoding: 'utf8',
              env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ...extraEnv },
            },
          );
          return { status: 0, out };
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
        }
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    };

    // An open P1 on the current head blocks the merge, listing the finding.
    const blocked = run([P(11, 'P1'), P(12, 'P2')]);
    expect(blocked.status).toBe(1);
    expect(blocked.out).toContain('FAIL');
    expect(blocked.out).toContain('[P1] lib/a.ts:3');
    expect(blocked.out).toContain('https://example.com/r11');

    // A P0 blocks by default too (Codex P1, PR #73 review).
    expect(run([P(15, 'P0')]).status).toBe(1);

    // A P1 whose thread has a reply is resolved — the gate passes.
    expect(run([P(21, 'P1'), reply(21)]).status).toBe(0);

    // P2 never blocks by default.
    expect(run([P(31, 'P2')]).status).toBe(0);

    // --include-p2 makes P2 blocking, but P3+ still never blocks.
    expect(run([P(41, 'P2')], { extraArgs: '--include-p2' }).status).toBe(1);
    expect(run([P(43, 'P3')], { extraArgs: '--include-p2' }).status).toBe(0);

    // A finding left on an OLDER head does not block the current one.
    expect(run([P(51, 'P1', OLD)]).status).toBe(0);

    // A bot review with no comments is a clean review — the gate passes.
    expect(run([], { reviews: [botReview] }).status).toBe(0);

    // NO review at all is not clean: the gate waits, then fails with the
    // WAITING message instead of passing (Codex P1, PR #73 review).
    const waiting = run([], {
      reviews: [],
      extraEnv: { CODEX_GATE_WAIT_SECONDS: '1' },
    });
    expect(waiting.status).toBe(1);
    expect(waiting.out).toContain('no Codex review observed on head');

    // --allow-no-review certifies a bot-skipped PR.
    expect(
      run([], { reviews: [], extraArgs: '--allow-no-review', extraEnv: { CODEX_GATE_WAIT_SECONDS: '1' } }).status,
    ).toBe(0);

    // The CODEX_GATE_BOT_SKIPPED_PRS repo variable certifies the same way,
    // so a pull_request-triggered run can satisfy the required merge gate.
    expect(
      run([], {
        reviews: [],
        extraEnv: { CODEX_GATE_WAIT_SECONDS: '1', CODEX_GATE_BOT_SKIPPED_PRS: '41, 42' },
      }).status,
    ).toBe(0);
  }, 20_000);
});
