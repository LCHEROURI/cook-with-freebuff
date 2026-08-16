import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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
    expect(GATE).toContain('pulls/${pr}"`))');
    expect(GATE).toContain('const headSha = prMeta.head.sha;');
    expect(GATE).toContain('c.commit_id != null && c.commit_id !== headSha');
  });

  it('classifies severity from the badge URL and blocks on P0 and P1 by default', () => {
    expect(GATE).toContain("c.body.match(/badge\\/(P\\d)-/)");
    // Explicit blocking sets: P0/P1 by default, P2 added only with --include-p2,
    // and never P3+ (Codex P1, PR #73 review).
    expect(GATE).toContain("const BLOCKING_DEFAULT = new Set(['P0', 'P1'])");
    expect(GATE).toContain("const BLOCKING_INCLUDE_P2 = new Set(['P0', 'P1', 'P2'])");
    expect(GATE).toContain('args.includes(\'--include-p2\')');
    // The stricter bar is also configurable via the CODEX_GATE_INCLUDE_P2
    // repo variable, enforced through the same required check. Variable-only
    // by design: a workflow_dispatch input cannot strengthen the merge gate,
    // because dispatch checks never enter the PR status rollup (Codex P2,
    // PR #78 review).
    expect(GATE).toContain("process.env.CODEX_GATE_INCLUDE_P2 === 'true'");
    expect(WORKFLOW).toContain('CODEX_GATE_INCLUDE_P2: ${{ vars.CODEX_GATE_INCLUDE_P2 == \'true\' }}');
    expect(WORKFLOW).not.toContain('include_p2:');
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

  it('nudges a skipped PR with a capped empty commit before the WAITING fallback', () => {
    expect(GATE).toContain('CODEX_GATE_NUDGE_MAX');
    expect(GATE).toContain("const NUDGE_MARKER = 'codex-nudge:'");
    expect(GATE).toContain('pulls/${pr}/commits?per_page=100');
    expect(GATE).toContain('git push "${pushUrl}"');
    expect(GATE).toContain('git commit -q --allow-empty');
    // The nudge push must ride a PAT (CODEX_NUDGE_TOKEN), never GITHUB_TOKEN:
    // the latter changes the head without re-running the required validate
    // check, leaving the PR unmergeable (Codex P1, PR #103 review).
    expect(GATE).toContain('CODEX_NUDGE_TOKEN');
    expect(GATE).toContain("!!process.env.CODEX_NUDGE_TOKEN");
    expect(GATE).toContain('x-access-token');
    expect(GATE).toContain('replaceAll(token');
    // Only a real pull_request Actions run on a same-repo head may nudge (a
    // fork head or a review/dispatch run must fall back to the WAITING message).
    expect(GATE).toContain("process.env.GITHUB_EVENT_NAME === 'pull_request'");
    expect(GATE).toContain('headRepoFullName === repo');
    // The push needs contents:write on top of the existing comment write perm,
    // and the workflow must thread the PAT secret into the gate env.
    expect(WORKFLOW).toContain('contents: write');
    expect(WORKFLOW).toContain('pull-requests: write');
    expect(WORKFLOW).toContain('CODEX_NUDGE_TOKEN: ${{ secrets.CODEX_NUDGE_TOKEN }}');
  });

  it('guards the nudge token scope: an Actions secret (repo or org) satisfies it, never an environment secret', () => {
    // The nudge token reaches the gate ONLY through the workflow's env
    // mapping `${{ secrets.CODEX_NUDGE_TOKEN }}`. That expression resolves
    // from the Actions secret scope (repository or organization), never from
    // an environment scope — an environment-scoped secret (Preview or
    // Production) is never in scope for this job and can never satisfy the
    // nudge, no matter what it is named. If a future edit adds an
    // `environment:` block to the codex-gate job, this guard goes red with it,
    // because that is the one edit that would let the expression start
    // resolving to an environment secret instead.
    expect(WORKFLOW).toContain('CODEX_NUDGE_TOKEN: ${{ secrets.CODEX_NUDGE_TOKEN }}');
    // Scope the negative to the codex-gate JOB only: bound the slice at the
    // next sibling job key (a two-space-indented name followed by a colon), so
    // a future job appended after codex-gate with its own environment block
    // cannot false-fail this guard. The gate's secret context must stay in the
    // Actions scope, but a sibling job may legitimately target an environment.
    const codexGateStart = WORKFLOW.indexOf('codex-gate:');
    // Fail loudly if the job key was renamed, rather than letting slice(-1)
    // check only the workflow's last character and pass vacuously.
    expect(codexGateStart).toBeGreaterThanOrEqual(0);
    const restOfFile = WORKFLOW.slice(codexGateStart);
    const nextJobAt = restOfFile.search(/\n  [a-zA-Z_][a-zA-Z0-9_-]*:/);
    const codexGateJob = nextJobAt === -1 ? restOfFile : restOfFile.slice(0, nextJobAt);
    expect(codexGateJob).not.toContain('environment:');
    // And the script's only token source is that env var: no file read, no gh
    // secret lookup, nothing that could reach an environment secret directly.
    expect(GATE).toContain("const token = process.env.CODEX_NUDGE_TOKEN ?? '';");
    expect(GATE).toContain('!!process.env.CODEX_NUDGE_TOKEN');
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

  it('the workflow passes PR_NUMBER + GH_TOKEN, the allow-no-review dispatch input, and comment write perms', () => {
    expect(WORKFLOW).toContain('GH_TOKEN: ${{ github.token }}');
    expect(WORKFLOW).toContain('PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || github.event.inputs.pr }}');
    expect(WORKFLOW).toContain('CODEX_GATE_ALLOW_NO_REVIEW: ${{ github.event.inputs.allow_no_review == \'true\' }}');
    expect(WORKFLOW).toContain('allow_no_review:');
    // write so a red gate can post its bot-style summary on the PR thread.
    expect(WORKFLOW).toContain('pull-requests: write');
    expect(WORKFLOW).toContain('node scripts/codex-review-pr-gate.mjs');
  });

  it('a red gate posts a bot-style PR-thread comment, workflow-only and deduped per head', () => {
    // The alert rides the issues/{pr}/comments endpoint with a per-head marker,
    // and is gated on GH_TOKEN so local runs never comment on PRs.
    expect(GATE).toContain('codex-gate-red');
    expect(GATE).toContain('issues/${pr}/comments');
    // GH_TOKEN alone is not an Actions signal — local devs exporting it must
    // not post comments; GITHUB_ACTIONS must also be true (Codex P2, PR #79).
    expect(GATE).toContain("process.env.GITHUB_ACTIONS === 'true'");
    expect(GATE).toContain('block lifts when every thread above is answered');
    // Same-head updates edit the existing comment; a green gate resolves it.
    expect(GATE).toContain('--method PATCH');
    expect(GATE).toContain('resolved');
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
      opts: {
        reviews?: unknown[];
        extraArgs?: string;
        extraEnv?: Record<string, string>;
        gateComments?: unknown[];
        nudgeCommits?: unknown[];
      } = {},
    ) => {
      const {
        reviews = [botReview],
        extraArgs = '',
        extraEnv = {},
        gateComments = [],
        nudgeCommits = [],
      } = opts;
      const stubDir = mkdtempSync(join(tmpdir(), 'codex-gate-stub-'));
      const stubPath = join(stubDir, 'gh');
      const postsLog = join(stubDir, 'posts.log');
      const gitLog = join(stubDir, 'git.log');
      writeFileSync(
        stubPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
const HEAD = ${JSON.stringify(HEAD)};
const comments = ${JSON.stringify(comments)};
const reviews = ${JSON.stringify(reviews)};
const gateComments = ${JSON.stringify(gateComments)};
const nudgeCommits = ${JSON.stringify(nudgeCommits)};
const postsLog = ${JSON.stringify(postsLog)};
const url = process.argv.join(' ');
if (url.includes('issues/42/comments?')) {
  process.stdout.write(JSON.stringify([gateComments]));
} else if ((url.includes('issues/42/comments') || url.includes('issues/comments/')) && url.includes('--input')) {
  const i = process.argv.indexOf('--input');
  fs.appendFileSync(postsLog, fs.readFileSync(process.argv[i + 1], 'utf8') + '<<<POST>>>');
  process.stdout.write('{}');
} else if (url.includes('/42/comments?')) {
  process.stdout.write(JSON.stringify([comments]));
} else if (url.includes('/42/reviews?')) {
  process.stdout.write(JSON.stringify([reviews]));
} else if (url.includes('pulls/42/commits')) {
  process.stdout.write(JSON.stringify(nudgeCommits));
} else if (url.includes('pulls/42')) {
  process.stdout.write(JSON.stringify({ head: { sha: HEAD, ref: 'feature/branch', repo: { full_name: 'fake/repo' } } }));
} else {
  process.exit(1);
}
`,
      );
      chmodSync(stubPath, 0o755);
      // A stub git logs every invocation and exits 0, so the nudge path can be
      // exercised without a real repository or token.
      const gitPath = join(stubDir, 'git');
      writeFileSync(
        gitPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(gitLog)}, process.argv.join(' ') + '<<<GIT>>>');
`,
      );
      chmodSync(gitPath, 0o755);
      const readPosts = () =>
        existsSync(postsLog)
          ? readFileSync(postsLog, 'utf8').split('<<<POST>>>').filter((s) => s.trim().length > 0)
          : [];
      const readGitLog = () =>
        existsSync(gitLog)
          ? readFileSync(gitLog, 'utf8').split('<<<GIT>>>').filter((s) => s.trim().length > 0)
          : [];
      try {
        try {
          const env: NodeJS.ProcessEnv = { ...process.env };
          // Deterministic: local runs must not post comments — only a real
          // Actions run (GITHUB_ACTIONS=true AND GH_TOKEN) does. CI runners
          // carry GITHUB_ACTIONS=true in process.env, so it must be scrubbed
          // here or the 'local run' case would leak into a posting run.
          delete env.GH_TOKEN;
          delete env.GITHUB_TOKEN;
          delete env.GITHUB_ACTIONS;
          Object.assign(env, { PATH: `${stubDir}:${process.env.PATH}` }, extraEnv);
          const out = execSync(
            `node scripts/codex-review-pr-gate.mjs --repo fake/repo --pr 42 ${extraArgs}`,
            { encoding: 'utf8', env },
          );
          return { status: 0, out, posts: readPosts(), gitLog: readGitLog() };
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          return {
            status: err.status ?? 1,
            out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
            posts: readPosts(),
            gitLog: readGitLog(),
          };
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

    // ── Nudge (re-trigger a skipped review) ────────────────────────────────
    // In a pull_request Actions run, a skipped review pushes a capped empty
    // nudge commit (re-firing the bot's synchronize event) before the WAITING
    // fallback.
    const nudgeEnv = {
      GH_TOKEN: 'stub-token',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      CODEX_GATE_WAIT_SECONDS: '1',
      CODEX_NUDGE_TOKEN: 'pat-stub',
    };
    const nudged = run([], { reviews: [], extraEnv: nudgeEnv });
    expect(nudged.status).toBe(1);
    expect(nudged.out).toContain('pushed a nudge commit');
    expect(nudged.out).toContain('attempt 1 of 2');
    expect(nudged.gitLog.some((c) => c.includes('git push'))).toBe(true);
    expect(nudged.gitLog.some((c) => c.includes('codex-nudge:'))).toBe(true);

    // The nudge is capped: once the PR already carries nudge commits up to the
    // max, the gate falls straight back to the WAITING message (no new push).
    const capped = run([], {
      reviews: [],
      extraEnv: nudgeEnv,
      nudgeCommits: [
        { sha: 'n1', commit: { message: 'codex-nudge: retry Codex review (attempt 1 of 2)' } },
        { sha: 'n2', commit: { message: 'codex-nudge: retry Codex review (attempt 2 of 2)' } },
      ],
    });
    expect(capped.status).toBe(1);
    expect(capped.out).toContain('no Codex review observed on head');
    expect(capped.out).not.toContain('pushed a nudge commit');
    expect(capped.gitLog.length).toBe(0);

    // A review-event run (not pull_request) never nudges — the bot has just
    // reviewed (or the event is unrelated), so only the WAITING path applies.
    const noNudge = run([], {
      reviews: [],
      extraEnv: { GH_TOKEN: 'stub-token', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request_review', CODEX_GATE_WAIT_SECONDS: '1' },
    });
    expect(noNudge.status).toBe(1);
    expect(noNudge.out).toContain('no Codex review observed on head');
    expect(noNudge.gitLog.length).toBe(0);

    // A nudge max of 0 disables the retry entirely.
    const disabled = run([], { reviews: [], extraEnv: { ...nudgeEnv, CODEX_GATE_NUDGE_MAX: '0' } });
    expect(disabled.status).toBe(1);
    expect(disabled.out).not.toContain('pushed a nudge commit');
    expect(disabled.gitLog.length).toBe(0);

    // Without the PAT the nudge is skipped entirely — the head must never be
    // advanced via GITHUB_TOKEN, or validate never re-runs on it and the PR
    // cannot merge even after the bot reviews (Codex P1, PR #103 review).
    const noToken = run([], {
      reviews: [],
      extraEnv: {
        GH_TOKEN: 'stub-token',
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        CODEX_GATE_WAIT_SECONDS: '1',
      },
    });
    expect(noToken.status).toBe(1);
    expect(noToken.out).toContain('no Codex review observed on head');
    expect(noToken.gitLog.length).toBe(0);

    // The stricter bar via env (repo variable / dispatch input) blocks a P2
    // the same way the --include-p2 flag does — no flag needed.
    expect(run([P(61, 'P2')], { extraEnv: { CODEX_GATE_INCLUDE_P2: 'true' } }).status).toBe(1);
    // And P3 still never blocks, even under the stricter bar.
    expect(run([P(63, 'P3')], { extraEnv: { CODEX_GATE_INCLUDE_P2: 'true' } }).status).toBe(0);

    // ── Red-alert comment ────────────────────────────────────────────────
    // In the workflow (GITHUB_ACTIONS + GH_TOKEN), a red gate posts a
    // bot-style summary on the PR thread with the per-head marker and the
    // finding thread URL.
    const actions = { GH_TOKEN: 'stub-token', GITHUB_ACTIONS: 'true' };
    const alerted = run([P(71, 'P1')], { extraEnv: actions });
    expect(alerted.status).toBe(1);
    expect(alerted.posts.length).toBe(1);
    expect(alerted.posts[0]).toContain('codex-gate-red: abc123def456');
    expect(alerted.posts[0]).toContain('https://example.com/r71');
    expect(alerted.posts[0]).toContain('Codex review gate is blocking PR #42');

    // Local runs never comment, even when red — with or without GH_TOKEN
    // exported (GITHUB_ACTIONS is the Actions signal, Codex P2, PR #79).
    expect(run([P(72, 'P1')]).posts.length).toBe(0);
    expect(run([P(72, 'P1')], { extraEnv: { GH_TOKEN: 'stub-token' } }).posts.length).toBe(0);

    // Same head, new finding set: the existing comment is EDITED (PATCH) with
    // the fresh summary instead of posting a second one.
    const alreadyAlerted = run([P(73, 'P1')], {
      gateComments: [{ id: 9001, body: '<!-- codex-gate-red: abc123def456 -->\nOlder finding.' }],
      extraEnv: actions,
    });
    expect(alreadyAlerted.status).toBe(1);
    expect(alreadyAlerted.posts.length).toBe(1);
    expect(alreadyAlerted.posts[0]).toContain('https://example.com/r73');

    // A green gate posts nothing when no alert exists…
    expect(run([], { extraEnv: actions }).posts.length).toBe(0);
    // …and RESOLVES a stale blocking comment when one exists for this head.
    const resolved = run([], {
      gateComments: [{ id: 9002, body: '<!-- codex-gate-red: abc123def456 -->\nOld block.' }],
      extraEnv: actions,
    });
    expect(resolved.status).toBe(0);
    expect(resolved.posts.length).toBe(1);
    expect(resolved.posts[0]).toContain('Codex review gate is green');
    expect(resolved.posts[0]).toContain('codex-gate-resolved');
  }, 20_000);
});
