#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/codex-review-monitor.mjs — poll the Codex review bot's findings
//
// The chatgpt-codex-connector[bot] leaves inline review comments on PRs shortly
// after they open. This monitor runs on a schedule (and via workflow_dispatch),
// sweeps open + recently updated PRs for those comments, and opens a labeled
// GitHub issue the first time each finding is seen. Dedupe is durable: every
// reported finding's unique comment ID is embedded in the issue body as a
// `<!-- codex-finding: <id> -->` marker, and the next run reads all open
// issues with the label to build the already-reported set — so consecutive
// runs never spam, and a finding already reported (open or later fixed) is
// never re-opened.
//
// Exit codes: 0 on success (whether or not new findings existed), 1 on a hard
// failure (gh missing, API error, issue-create failure). New findings are
// printed to stdout so the workflow log itself is the triage record.
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_LOGIN = 'chatgpt-codex-connector[bot]';
const LABEL = 'codex-review';
const DEFAULT_REPO = 'LCHEROURI/cook-with-freebuff';
const LOOKBACK_DAYS = 14;
const FINDING_MARKER = (id) => `<!-- codex-finding: ${id} -->`;

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const repo = take('--repo') ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
const lookbackDays = Number(take('--lookback-days') ?? LOOKBACK_DAYS);

function runQuiet(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function fetchJson(cmd) {
  try {
    return JSON.parse(runQuiet(cmd));
  } catch (e) {
    console.error(`✗ API call failed: ${cmd}`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// ── Sweep: open + recently-updated PRs, Codex's inline comments ─────────────

const cutoff = Date.now() - lookbackDays * 86_400_000;

// --paginate on every collection (Codex P2, PR #51 review): gh api caps each
// request at per_page, so without it the sweep silently sees only the first
// page once the repo grows past 50 PRs / 100 comments / 100 issues.
const pulls = fetchJson(
  `gh api --paginate "repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50"`,
);
// Open PRs always count; merged/closed PRs only within the lookback window
// (the bot comments shortly after a PR opens, so a fresh PR is caught even if
// it merged quickly).
const inWindow = pulls.filter((p) => p.state === 'open' || Date.parse(p.updated_at) >= cutoff);

/** @type {{ commentId: string; prNumber: number; prTitle: string; path: string; line: string; summary: string; url: string }[]} */
const findings = [];
for (const pr of inWindow) {
  const comments = fetchJson(
    `gh api --paginate "repos/${repo}/pulls/${pr.number}/comments?per_page=100"`,
  );
  for (const c of comments) {
    if (c.user?.login !== BOT_LOGIN) continue;
    const firstLine = c.body.split('\n').find((l) => l.trim().length > 0) ?? '';
    findings.push({
      commentId: String(c.id),
      prNumber: pr.number,
      prTitle: pr.title,
      path: c.path ?? '',
      line: c.line ?? c.original_line ?? '',
      summary: firstLine.replace(/\s+/g, ' ').slice(0, 220),
      url: c.html_url ?? `https://github.com/${repo}/pull/${pr.number}#discussion_r${c.id}`,
    });
  }
}

// ── Dedupe: already-reported comment IDs live in labeled issues ────────────
// Read ALL issues (open + closed): a finding whose issue was closed after the
// fix must still suppress re-reporting — otherwise the next run would re-open
// the same finding every time someone closed its issue.
const issues = fetchJson(
  `gh api --paginate "repos/${repo}/issues?state=all&labels=${LABEL}&per_page=100"`,
);
const reported = new Set();
for (const issue of issues) {
  const body = issue.body ?? '';
  for (const m of body.matchAll(/codex-finding: (\d+)/g)) reported.add(m[1]);
}

const fresh = findings.filter((f) => !reported.has(f.commentId));

if (fresh.length === 0) {
  console.log(`✓ No new Codex findings (${findings.length} in window, all already reported)`);
  process.exit(0);
}

// ── Report: one issue per PR with new findings ──────────────────────────────

const byPr = new Map();
for (const f of fresh) {
  if (!byPr.has(f.prNumber)) byPr.set(f.prNumber, []);
  byPr.get(f.prNumber).push(f);
}

const tempDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
let created = 0;
for (const [prNumber, list] of byPr) {
  const pr = inWindow.find((p) => p.number === prNumber);
  const items = list
    .map(
      (f) =>
        `- **${f.path}${f.line ? ':' + f.line : ''}** — ${f.summary}\n  ${f.url}`,
    )
    .join('\n');
  const markers = list.map((f) => FINDING_MARKER(f.commentId)).join('\n');
  const body = [
    `The Codex review bot left ${list.length} new finding(s) on PR #${prNumber}${pr ? ` (${pr.title})` : ''}.`,
    '',
    items,
    '',
    markers,
    '',
  ].join('\n');

  const bodyFile = join(tempDir, `pr-${prNumber}.md`);
  writeFileSync(bodyFile, body);
  try {
    runQuiet(`gh label create "${LABEL}" --force --repo "${repo}" || true`);
    const url = runQuiet(
      `gh issue create --repo "${repo}" --title "Codex review: ${list.length} new finding(s) on PR #${prNumber}" --label "${LABEL}" --body-file "${bodyFile}"`,
    );
    console.log(`✎ ${url}`);
    created += 1;
  } catch (e) {
    console.error(`✗ Could not open issue for PR #${prNumber}`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

console.log(`✓ Reported ${fresh.length} new Codex finding(s) across ${created} PR issue(s)`);
