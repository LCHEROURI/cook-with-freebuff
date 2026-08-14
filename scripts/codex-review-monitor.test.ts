import { readFileSync } from 'node:fs';
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
});
