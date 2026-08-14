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
// Load-bearing properties locked here: it reads ONLY the bot's comments;
// classifies severity from the badge URL; treats a finding as OPEN until a
// human reply lands on its thread (in_reply_to_id — the resolution-note
// convention); blocks on P1 by default and only on P2 with --include-p2; and
// the workflow re-runs on review-comment/review events so a late bot review
// still reddens the check. A future edit that drops the bot filter, the
// reply-based resolution, or the P1 default fails here instead of silently
// letting P1s merge.
// ============================================================================

const GATE = readFileSync('scripts/codex-review-pr-gate.mjs', 'utf8');
const WORKFLOW = readFileSync('.github/workflows/codex-review-pr-gate.yml', 'utf8');

describe('scripts/codex-review-pr-gate.mjs', () => {
  it('requires a PR number (--pr or PR_NUMBER) and exits 2 on usage error', () => {
    expect(GATE).toContain("take('--pr') ?? process.env.PR_NUMBER");
    expect(GATE).toContain('if (!pr) {');
    expect(GATE).toContain('process.exit(2)');
  });

  it('reads ONLY the Codex bot inline comments, paginated and slurped', () => {
    expect(GATE).toContain("const BOT_LOGIN = 'chatgpt-codex-connector[bot]';");
    expect(GATE).toContain("c.user?.login !== BOT_LOGIN");
    expect(GATE).toContain('pulls/${pr}/comments?per_page=100');
    expect(GATE).toContain('gh api --paginate');
    expect(GATE).toContain('--slurp');
    expect(GATE).toContain(')).flat()');
  });

  it('classifies severity from the badge URL and blocks on P1 by default', () => {
    expect(GATE).toContain("c.body.match(/badge\\/(P\\d)-/)");
    expect(GATE).toContain("severity !== 'P1' && !includeP2");
    expect(GATE).toContain('args.includes(\'--include-p2\')');
  });

  it('treats a finding as resolved only once its thread has a reply', () => {
    expect(GATE).toContain('c.in_reply_to_id != null');
    expect(GATE).toContain('repliedTo.has(String(c.id))');
  });

  it('exits 1 with the blocking findings listed when an open P1 exists', () => {
    expect(GATE).toContain('blocking.length === 0');
    expect(GATE).toContain('process.exit(0)');
    expect(GATE).toContain('process.exit(1)');
    expect(GATE).toContain('open Codex finding(s) on PR');
  });

  it('the workflow reports the check under the exact required-check name', () => {
    expect(WORKFLOW).toContain('name: Codex P1 gate');
  });

  it('the workflow re-runs on review-comment and review events, not just pull_request', () => {
    expect(WORKFLOW).toContain('pull_request:');
    expect(WORKFLOW).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(WORKFLOW).toContain('pull_request_review_comment:');
    expect(WORKFLOW).toContain('pull_request_review:');
    expect(WORKFLOW).toContain('workflow_dispatch:');
  });

  it('the workflow passes PR_NUMBER + GH_TOKEN and requests only read permissions', () => {
    expect(WORKFLOW).toContain('GH_TOKEN: ${{ github.token }}');
    expect(WORKFLOW).toContain('PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || github.event.inputs.pr }}');
    expect(WORKFLOW).toContain('pull-requests: read');
    expect(WORKFLOW).toContain('node scripts/codex-review-pr-gate.mjs');
  });

  it('behaves end to end against a stubbed gh', () => {
    const bot = 'chatgpt-codex-connector[bot]';
    const P1 = (id: number, path = 'lib/a.ts') => ({
      id,
      user: { login: bot },
      body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>\n\nThis is the finding text',
      path,
      line: 3,
      html_url: `https://example.com/r${id}`,
    });
    const P2 = (id: number) => ({
      id,
      user: { login: bot },
      body: '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>\n\nP2 finding',
      path: 'lib/b.ts',
      line: 7,
      html_url: `https://example.com/r${id}`,
    });
    const reply = (to: number) => ({
      id: to + 1_000_000,
      user: { login: 'LCHEROURI' },
      in_reply_to_id: to,
      body: 'Resolved and merged.',
    });

    const run = (comments: unknown[], extraArgs = '') => {
      const stubDir = mkdtempSync(join(tmpdir(), 'codex-gate-stub-'));
      const stubPath = join(stubDir, 'gh');
      writeFileSync(
        stubPath,
        `#!/usr/bin/env node
const comments = ${JSON.stringify(comments)};
const url = process.argv.join(' ');
if (!url.includes('/42/comments?')) process.exit(1);
process.stdout.write(JSON.stringify([comments]));
`,
      );
      chmodSync(stubPath, 0o755);
      try {
        try {
          const out = execSync(
            `node scripts/codex-review-pr-gate.mjs --repo fake/repo --pr 42 ${extraArgs}`,
            { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } },
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

    // An open P1 blocks the merge, listing the finding.
    const blocked = run([P1(11), P2(12)]);
    expect(blocked.status).toBe(1);
    expect(blocked.out).toContain('FAIL');
    expect(blocked.out).toContain('[P1] lib/a.ts:3');
    expect(blocked.out).toContain('https://example.com/r11');

    // A P1 whose thread has a reply is resolved — the gate passes.
    expect(run([P1(21), reply(21)]).status).toBe(0);

    // P2 never blocks by default.
    expect(run([P2(31)]).status).toBe(0);

    // --include-p2 makes P2 blocking too.
    expect(run([P2(41)], '--include-p2').status).toBe(1);

    // No bot comments at all passes.
    expect(run([]).status).toBe(0);
  });
});
