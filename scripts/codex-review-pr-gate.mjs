#!/usr/bin/env node
// ============================================================================
// scripts/codex-review-pr-gate.mjs — fail a PR when the Codex bot leaves an
// open P0/P1 finding.
//
// The chatgpt-codex-connector[bot] posts inline review comments on a PR
// shortly after it opens — often AFTER the initial checks complete. The
// post-merge issue monitor (codex-review-monitor.mjs) catches findings that
// land untriaged, but a PR can still MERGE with an open P1. This gate runs as
// a required status check ON the PR:
//
//   • scans the PR's inline review comments (pulls/{n}/comments, paginated),
//   • classifies severity from the badge URL in the comment body (P0/P1/P2),
//   • blocks on P0 and P1 by default (P2 only with --include-p2; other P
//     severities never block),
//   • only considers bot comments ON THE CURRENT HEAD — a finding left on an
//     earlier commit that a push already addressed cannot block the new head,
//   • treats a finding as OPEN until a human reply lands on its thread
//     (a comment whose in_reply_to_id points at it) — the resolution-note
//     convention this repo follows: fix, then reply "Resolved …" on the
//     thread.
//
// Wait-for-review: an empty comment list is NOT a clean review — it means the
// bot has not looked at this head yet (it posts minutes after open, and the
// workflow re-runs on review events). The gate polls for a submitted Codex
// review or inline comment on the current head for up to
// CODEX_GATE_WAIT_SECONDS (default 360); if none appears it fails with a
// WAITING message so the PR cannot merge before the bot has reviewed it. The
// bot occasionally skips a PR entirely; after confirming that is the case,
// re-run with --allow-no-review (or the workflow_dispatch input) to certify
// the PR as reviewed-by-human. (Codex P1, PR #73 review.)
//
// Exit codes: 0 = no open P0/P1 findings, 1 = waiting for the bot review or
// open findings block the merge, 2 = usage error (no PR number).
//
// Usage:
//   node scripts/codex-review-pr-gate.mjs --pr 42
//   node scripts/codex-review-pr-gate.mjs --pr=42   (same)
//   PR_NUMBER=42 node scripts/codex-review-pr-gate.mjs
//   node scripts/codex-review-pr-gate.mjs --pr 42 --include-p2
//   node scripts/codex-review-pr-gate.mjs --pr 42 --allow-no-review
//   CODEX_GATE_WAIT_SECONDS=60 node scripts/codex-review-pr-gate.mjs --pr 42
// ============================================================================

import { execSync } from 'node:child_process';

const BOT_LOGIN = 'chatgpt-codex-connector[bot]';
const DEFAULT_REPO = 'LCHEROURI/cook-with-freebuff';
const DEFAULT_WAIT_SECONDS = 360;
const POLL_MS = 15_000;

// Blocking severity set: P0 and P1 by default; --include-p2 adds P2 only, so
// a hypothetical P3+ never blocks (Codex P1, PR #73 review).
const BLOCKING_DEFAULT = new Set(['P0', 'P1']);
const BLOCKING_INCLUDE_P2 = new Set(['P0', 'P1', 'P2']);

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
const allowNoReview =
  args.includes('--allow-no-review') || process.env.CODEX_GATE_ALLOW_NO_REVIEW === 'true';
const waitMs =
  (Number(process.env.CODEX_GATE_WAIT_SECONDS ?? DEFAULT_WAIT_SECONDS) || DEFAULT_WAIT_SECONDS) * 1000;
const blockingSet = includeP2 ? BLOCKING_INCLUDE_P2 : BLOCKING_DEFAULT;

if (!pr) {
  console.error('✗ FAIL: --pr <number> (or PR_NUMBER env) is required');
  process.exit(2);
}

function runQuiet(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/**
 * Paginated fetch. gh api --paginate emits one JSON document per page, so
 * JSON.parse breaks on a multi-page collection (Codex P2, PR #53 review);
 * --slurp wraps every page in one outer array and we flatten one level — the
 * same pattern as the monitor.
 */
function fetchList(cmd) {
  try {
    return JSON.parse(runQuiet(`${cmd} --slurp`)).flat();
  } catch (e) {
    console.error(`✗ FAIL: could not read review comments (${cmd})`);
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// ── Head + review observation ────────────────────────────────────────────────

// A finding/review only counts for the commit it was left on; a stale comment
// from a previous head must never block the current one.
const headSha = JSON.parse(runQuiet(`gh api "repos/${repo}/pulls/${pr}"`)).head.sha;

function fetchComments() {
  return fetchList(`gh api --paginate "repos/${repo}/pulls/${pr}/comments?per_page=100"`);
}
function fetchReviews() {
  return fetchList(`gh api --paginate "repos/${repo}/pulls/${pr}/reviews?per_page=100"`);
}

/** Has the bot actually reviewed the CURRENT head (submitted review or inline comment)? */
function botObservedOnHead(comments, reviews) {
  return (
    comments.some((c) => c.user?.login === BOT_LOGIN && c.commit_id === headSha) ||
    reviews.some((r) => r.user?.login === BOT_LOGIN && r.commit_id === headSha)
  );
}

let comments = fetchComments();
let reviews = fetchReviews();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Wait-for-review: empty is NOT clean (Codex P1, PR #73 review) ───────────
if (allowNoReview) {
  // Human-confirmed certification: the bot is not going to review this PR, so
  // skip the wait — the scan below still runs on whatever findings exist.
  console.log(
    `⚠ certifying PR #${pr} with --allow-no-review (human-confirmed: the bot is not reviewing this PR)`,
  );
} else {
  const deadline = Date.now() + waitMs;
  while (!botObservedOnHead(comments, reviews) && Date.now() < deadline) {
    // Poll to the deadline (bounded), re-checking for the bot's review to land.
    await sleep(Math.min(POLL_MS, Math.max(500, deadline - Date.now())));
    comments = fetchComments();
    reviews = fetchReviews();
  }
  if (!botObservedOnHead(comments, reviews)) {
    console.error(
      `✗ FAIL: no Codex review observed on head ${headSha} — a clean review cannot be ` +
        `distinguished from no review yet, so the PR stays blocked until the bot reviews ` +
        `(the review events re-run this check). If the bot is genuinely not going to review ` +
        `this PR, re-run with --allow-no-review.`,
    );
    process.exit(1);
  }
}

// ── Scan ────────────────────────────────────────────────────────────────────

// A finding is RESOLVED when its thread has a reply (a comment whose
// in_reply_to_id points at the bot comment) — the resolution-note convention.
const repliedTo = new Set(
  comments.filter((c) => c.in_reply_to_id != null).map((c) => String(c.in_reply_to_id)),
);

/** @type {{ id: string; severity: string; path: string; line: string; summary: string; url: string }[]} */
const blocking = [];
for (const c of comments) {
  if (c.user?.login !== BOT_LOGIN) continue;
  // A comment from a previous head does not apply to the current code.
  if (c.commit_id != null && c.commit_id !== headSha) continue;
  const severity = (c.body.match(/badge\/(P\d)-/) ?? [])[1] ?? '';
  if (!severity) {
    console.warn(`  - unparseable severity on bot comment ${c.id} — not treated as blocking (${c.html_url ?? ''})`);
    continue;
  }
  if (!blockingSet.has(severity)) continue;
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
const label = includeP2 ? 'P0/P1/P2' : 'P0/P1';
if (blocking.length === 0) {
  console.log(
    `✓ Codex review gate: no open ${label} findings on PR #${pr}` +
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
