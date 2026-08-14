import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/codex-review-monitor.test.ts — lock the Codex monitor contract.
//
// The chatgpt-codex-connector[bot] leaves inline review comments on PRs shortly
// after they open; a PR that auto-merges can carry findings nobody triaged.
// This monitor sweeps open + recently updated PRs for those comments and opens
// a `codex-review` labeled issue the first time each finding is seen. Load-
// bearing properties locked here: it ONLY reads comments from the bot login
// (never other reviewers), dedupes durably by comment ID (a marker in the
// issue body survives closing — a fixed finding is never re-opened), sweeps a
// real lookback window of open AND recently merged PRs, and creates one issue
// per affected PR with a body-file (quote-safe for any markdown). A future
// edit that drops the bot filter, the dedupe, or the issue creation fails
// here instead of spamming the issue tracker.
// ============================================================================

const MONITOR = readFileSync('scripts/codex-review-monitor.mjs', 'utf8');

describe('scripts/codex-review-monitor.mjs', () => {
  it('sweeps inline review comments from ONLY the Codex bot login', () => {
    expect(MONITOR).toContain("const BOT_LOGIN = 'chatgpt-codex-connector[bot]';");
    expect(MONITOR).toContain("c.user?.login !== BOT_LOGIN");
    expect(MONITOR).toContain("pulls/${pr.number}/comments");
  });

  it('sweeps open PRs plus a real lookback window of merged/closed PRs', () => {
    expect(MONITOR).toContain('const LOOKBACK_DAYS = 14;');
    expect(MONITOR).toContain('p.state === \'open\' || Date.parse(p.updated_at) >= cutoff');
    expect(MONITOR).toContain('state=all&sort=updated&direction=desc');
  });

  it('paginates every monitored collection so a growing repo is not silently truncated', () => {
    // Codex P2 (PR #51 review): gh api caps each request at per_page; without
    // --paginate the sweep sees only the first page once the repo passes 50
    // PRs / 100 comments / 100 issues — missing findings and forgetting dedupe
    // markers.
    expect(MONITOR).toContain('gh api --paginate "repos/${repo}/pulls?state=all');
    expect(MONITOR).toContain('gh api --paginate "repos/${repo}/pulls/${pr.number}/comments');
    expect(MONITOR).toContain('gh api --paginate "repos/${repo}/issues?state=all');
  });

  it('slurps + flattens paginated responses so a multi-page collection parses', () => {
    // Codex P2 (PR #53 review): gh api --paginate emits one JSON document per
    // page, so JSON.parse throws on a collection larger than one page. --slurp
    // wraps every page in one outer array and the helper flattens it. Every
    // collection fetch goes through the slurping helper — never bare fetchJson.
    expect(MONITOR).toContain("return JSON.parse(runQuiet(`${cmd} --slurp`)).flat();");
    const collectionCalls = MONITOR.match(/const (?:pulls|comments|issues) = fetchPaginated\(/g) ?? [];
    expect(collectionCalls).toHaveLength(3);
    expect(MONITOR).not.toContain('gh api --paginate "repos/${repo}/pulls?state=all"');
  });

  it('dedupes durably by comment ID embedded in the issue body', () => {
    // The marker survives in the issue body, so the next run reads it back and
    // never re-opens the same finding — even after the issue is closed.
    expect(MONITOR).toContain('const FINDING_MARKER = (id) => `<!-- codex-finding: ${id} -->`;');
    expect(MONITOR).toContain('commentId: String(c.id)');
    expect(MONITOR).toContain('state=all&labels=');
    expect(MONITOR).toContain('reported.add(m[1])');
    expect(MONITOR).toContain('fresh.length === 0');
  });

  it('opens one labeled issue per affected PR using a body file', () => {
    expect(MONITOR).toContain("const LABEL = 'codex-review';");
    expect(MONITOR).toContain('gh label create "${LABEL}" --force');
    expect(MONITOR).toContain('gh issue create');
    expect(MONITOR).toContain('--label "${LABEL}"');
    expect(MONITOR).toContain('--body-file');
    expect(MONITOR).toContain('one issue per PR with new findings');
  });

  it('fails loudly on a hard error instead of silently passing', () => {
    expect(MONITOR).toContain('process.exit(1)');
    expect(MONITOR).toContain('API call failed');
    expect(MONITOR).toContain('Could not open issue');
  });

  it('sweeps multi-page collections end to end against a stubbed gh (Codex P2 — PR #53)', () => {
    // Run the REAL script against a fake `gh` that mimics gh api --paginate:
    // raw mode emits one JSON document per page (so un-slurped multi-page
    // output is unparseable), --slurp wraps every page in one outer array.
    // Every collection is 2 pages and the load-bearing records live on page
    // 2 (PR #101; comment 5002; the dedupe marker for 5001), so a truncation
    // or a slurp regression fails the assertions below. PR #100's comments
    // carry findings 5001 + 5002; 5001 is already reported (marker on issue
    // page 2), 5002 and 6001 (PR #101) are fresh → exactly 2 new findings.
    const stubDir = mkdtempSync(join(tmpdir(), 'codex-monitor-stub-'));
    const stubPath = join(stubDir, 'gh');
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const cmd = args[0];
const url = args.find((a) => a.startsWith('repos/')) ?? '';
const slurp = args.includes('--slurp');
const emit = (pages) => {
  // Real gh --paginate: raw = one doc per page, slurp = outer array of pages.
  process.stdout.write(slurp ? JSON.stringify(pages) : pages.map((p) => JSON.stringify(p)).join('\\n'));
};
const bot = 'chatgpt-codex-connector[bot]';
const mkPr = (number, title) => ({ number, title, state: 'open', updated_at: new Date().toISOString() });
const mkComment = (id, pr) => ({ id, user: { login: bot }, body: '**P1 Badge**  Finding ' + id, path: 'lib/x.ts', line: 1, html_url: 'https://example.com/discussion_r' + id });
const mkIssue = (number, marker) => ({ number, body: 'old\\n<!-- codex-finding: ' + marker + ' -->' });
if (cmd === 'label') process.exit(0);
if (cmd === 'issue') {
  const m = args.join(' ').match(/PR #(\\d+)/);
  process.stdout.write('https://github.com/fake/repo/issues/' + (m ? m[1] : '0'));
  process.exit(0);
}
if (url.includes('/pulls?')) emit([[mkPr(100, 'PR 100')], [mkPr(101, 'PR 101')]]);
else if (url.includes('/100/comments?')) emit([[mkComment(5001, 100)], [mkComment(5002, 100)]]);
else if (url.includes('/101/comments?')) emit([[mkComment(6001, 101)]]);
else if (url.includes('/issues?')) emit([[mkIssue(10, 9999)], [mkIssue(11, 5001)]]);
else process.exit(1);
`,
    );
    chmodSync(stubPath, 0o755);

    try {
      const out = execSync('node scripts/codex-review-monitor.mjs --repo fake/repo', {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      });
      // Both pages swept: PR #101 (page 2) reported; 5001 deduped via the
      // marker on ISSUE page 2; exactly the two fresh findings create issues.
      expect(out).toContain('Reported 2 new Codex finding(s) across 2 PR issue(s)');
      expect(out).toContain('https://github.com/fake/repo/issues/100');
      expect(out).toContain('https://github.com/fake/repo/issues/101');
      expect(out).not.toContain('API call failed');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
