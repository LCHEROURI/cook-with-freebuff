#!/usr/bin/env node
// ============================================================================
// scripts/codex-review-pr-gate.mjs — fail a PR when the Codex bot leaves an
// open P1 finding.
//
// The chatgpt-codex-connector[bot] posts inline review comments on a PR
// shortly after it opens — often AFTER the initial checks complete. The
// post-merge issue monitor (codex-review-monitor.mjs) catches findings that
// land untriaged, but a PR can still MERGE with an open P1. This gate runs as
// a required status check ON the PR:
//
//   • scans the PR's inline review comments (pulls/{n}/comments, paginated),
//   • classifies severity from the badge URL in the comment body (P1/P2),
//   • treats a finding as OPEN until a human reply lands on its thread
//     (a comment whose in_reply_to_id points at it) — the resolution-note
//     convention this repo follows: fix, then reply "Resolved …" on the thread.
//
// Any open P1 exits 1, reddening the check and blocking the merge. P2
// findings never block by default (--include-p2 opts in).
//
// Exit codes: 0 = no open P1 findings, 1 = open P1 finding(s) block the merge,
// 2 = usage error (no PR number).
//
// Usage:
//   node scripts/codex-review-pr-gate.mjs --pr 42
//   node scripts/codex-review-pr-gate.mjs --pr=42   (same)
//   PR_NUMBER=42 node scripts/codex-review-pr-gate.mjs
//   node scripts/codex-review-pr-gate.mjs --pr 42 --include-p2
// ============================================================================

import { execSync } from 'node:child_process';

const BOT_LOGIN = 'chatgpt-codex-connector[bot]';
const DEFAULT_REPO = 'LCHEROURI/cook-with-freebuff';

// ── Arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  if (i !== -1) return args[i + 1];
  // Also accept the --flag=value form.
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
};
const repo = take('--repo') ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
const pr = take('--pr') ?? process.env.PR_NUMBER;
const includeP2 = args.includes('--include-p2');

if (!pr) {
  console.error('✗ FAIL: --pr <number> (or PR_NUMBER env) is required');
  process.exit(2);
}

function runQuiet(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/**
 * Paginated comment fetch. gh api --paginate emits one JSON document per page,
 * so JSON.parse breaks on a multi-page collection (Codex P2, PR #53 review);
 * --slurp wraps every page in one outer array and we flatten one level — the
 * same pattern as the monitor.
 */
function fetchComments(cmd) {
  try {
    return JSON.parse(runQuiet(`${cmd} --slurp`)).flat();
  } catch (e) {
    console.error(`✗ FAIL: could not read review comments (${cmd})`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// ── Scan ────────────────────────────────────────────────────────────────────

const comments = fetchComments(
  `gh api --paginate "repos/${repo}/pulls/${pr}/comments?per_page=100"`,
);

// A finding is RESOLVED when its thread has a reply (a comment whose
// in_reply_to_id points at the bot comment) — the resolution-note convention.
const repliedTo = new Set(
  comments.filter((c) => c.in_reply_to_id != null).map((c) => String(c.in_reply_to_id)),
);

/** @type {{ id: string; severity: string; path: string; line: string; summary: string; url: string }[]} */
const blocking = [];
for (const c of comments) {
  if (c.user?.login !== BOT_LOGIN) continue;
  const severity = (c.body.match(/badge\/(P\d)-/) ?? [])[1] ?? '';
  if (!severity) {
    console.warn(`  - unparseable severity on bot comment ${c.id} — not treated as blocking (${c.html_url ?? ''})`);
    continue;
  }
  if (severity !== 'P1' && !includeP2) continue;
  if (repliedTo.has(String(c.id))) continue;
  // The badge line (the severity pill) is noise — pick the first content line
  // that is not the badge, i.e. the finding's title.
  const firstLine = (c.body.split('\n').find((l) => {
    const t = l.trim();
    return t.length > 0 && !/badge|img\.shields\.io/i.test(t);
  }) ?? '')
    .replace(/[#*`_[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  blocking.push({
    id: String(c.id),
    severity,
    path: c.path ?? '',
    line: c.line ?? c.original_line ?? '',
    summary: firstLine.slice(0, 160),
    url: c.html_url ?? `https://github.com/${repo}/pull/${pr}#discussion_r${c.id}`,
  });
}

// ── Verdict ─────────────────────────────────────────────────────────────────

const botCommentCount = comments.filter((c) => c.user?.login === BOT_LOGIN).length;
if (blocking.length === 0) {
  console.log(
    `✓ Codex review gate: no open ${includeP2 ? 'P1/P2' : 'P1'} findings on PR #${pr}` +
      ` (${botCommentCount} bot comment(s))`,
  );
  process.exit(0);
}

console.error(`✗ FAIL: ${blocking.length} open Codex finding(s) on PR #${pr} — fix, then reply on each thread:`);
for (const f of blocking) {
  console.error(`  • [${f.severity}] ${f.path}${f.line ? ':' + f.line : ''} — ${f.summary}`);
  console.error(`    ${f.url}`);
}
process.exit(1);
