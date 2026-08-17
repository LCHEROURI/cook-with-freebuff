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
//   • blocks on P0 and P1 by default; the stricter bar (also blocking P2)
//     comes from --include-p2 or the CODEX_GATE_INCLUDE_P2 repo variable —
//     other P severities never block,
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
// CODEX_GATE_WAIT_SECONDS (default 360); if none appears it first pushes up
// to CODEX_GATE_NUDGE_MAX (default 2) empty "nudge" commits to re-trigger the
// bot's synchronize event, and only then fails with a WAITING message so the
// PR cannot merge before the bot has reviewed it. The nudge push needs the
// CODEX_NUDGE_TOKEN PAT (GITHUB_TOKEN would change the head without re-running
// the required validate check); without that secret the nudge is skipped. The
// bot occasionally skips a PR entirely; after confirming that is the case,
// re-run with --allow-no-review to certify the PR as reviewed-by-human.
// (Codex P1, PR #73 review.)
//
// A red gate running in Actions (GITHUB_ACTIONS=true and GH_TOKEN set) ALSO
// keeps a bot-style comment on the PR thread summarizing the open findings —
// one per head SHA, edited in place as the finding set changes and resolved
// when the gate turns green — so the block is visible without opening the
// check details. Local runs never comment.
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
//   CODEX_GATE_INCLUDE_P2=true node scripts/codex-review-pr-gate.mjs --pr 42
//     (repo variable: same stricter bar as --include-p2)
//   CODEX_GATE_NUDGE_MAX=3 node scripts/codex-review-pr-gate.mjs --pr 42
//     (or --nudge-max 3: cap the nudge commits before the WAITING fallback)
//   CODEX_GATE_NUDGE_TOKEN=<pat> node scripts/codex-review-pr-gate.mjs --pr 42
//     (a PAT with contents: write; the nudge is skipped without it)
// ============================================================================

import { execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOT_LOGIN = 'chatgpt-codex-connector[bot]';
const DEFAULT_REPO = 'LCHEROURI/cook-with-freebuff';
const DEFAULT_WAIT_SECONDS = 360;
const POLL_MS = 15_000;
// How many empty "nudge" commits the gate may push to re-trigger a review
// before giving up and asking the human to certify via --allow-no-review.
const DEFAULT_NUDGE_MAX = 2;

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
// --include-p2 (CLI flag, local runs) or the CODEX_GATE_INCLUDE_P2 repo
// variable (persistent team-wide stricter bar) turn on blocking P2 findings;
// otherwise only P0/P1 block. The variable is the only workflow path that can
// strengthen the required merge gate (a dispatch input never enters the PR
// status rollup — Codex P2, PR #78 review).
const includeP2 =
  args.includes('--include-p2') || process.env.CODEX_GATE_INCLUDE_P2 === 'true';
// Certification comes from --allow-no-review (local run / dispatch input) or
// from the CODEX_GATE_BOT_SKIPPED_PRS repo variable (comma-separated PR
// numbers). A workflow_dispatch check never enters the PR status rollup, so
// only a pull_request-triggered run can satisfy the required merge gate for
// a bot-skipped PR — hence the repo variable path, which rides the next
// synchronize run.
const allowNoReview =
  args.includes('--allow-no-review') ||
  process.env.CODEX_GATE_ALLOW_NO_REVIEW === 'true' ||
  (process.env.CODEX_GATE_BOT_SKIPPED_PRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(pr));
const waitMs =
  (Number(process.env.CODEX_GATE_WAIT_SECONDS ?? DEFAULT_WAIT_SECONDS) || DEFAULT_WAIT_SECONDS) * 1000;
const nudgeMaxArg = take('--nudge-max') ?? process.env.CODEX_GATE_NUDGE_MAX;
const nudgeMax = nudgeMaxArg == null ? DEFAULT_NUDGE_MAX : Math.max(0, Number(nudgeMaxArg) || 0);
const blockingSet = includeP2 ? BLOCKING_INCLUDE_P2 : BLOCKING_DEFAULT;

if (!pr) {
  console.error('✗ FAIL: --pr <number> (or PR_NUMBER env) is required');
  process.exit(2);
}

// Only a real Actions run may touch the PR thread — GH_TOKEN alone is not an
// Actions signal (a local dev exporting it would otherwise post comments),
// so GITHUB_ACTIONS must also be true (Codex P2, PR #79 review). Defined here
// rather than in the verdict section because the degraded-service note is
// posted from the wait loop, before the scan reaches the verdict.
const inActions = process.env.GITHUB_ACTIONS === 'true' && !!process.env.GH_TOKEN;

// Preflight: is GitHub's platform degraded for the endpoints this gate needs?
// The PR #125 reviews-list 404 and the PR #126 comments-list 504 were the
// platform being degraded — not a bot skip and not a code finding. When the
// relevant components are degraded, the gate reports a distinct "degraded
// service, retry later" state instead of the bot-skip WAITING message, so a
// human does not certify a skip for what is really a platform delay. The
// probe is non-fatal: an unknown or failed probe never fails the gate.
const STATUS_COMPONENTS = ['API Requests', 'Pull Requests', 'Actions', 'Webhooks'];
async function checkGitHubStatus() {
  // Test seam: an explicit value overrides the live probe so tests stay
  // hermetic (no network from the test runner).
  const forced = process.env.CODEX_GATE_STATUS;
  if (forced === 'operational') return false;
  if (forced === 'degraded') return true;
  try {
    const res = await fetch('https://www.githubstatus.com/api/v2/summary.json', {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.components ?? []).some(
      (c) => STATUS_COMPONENTS.includes(c.name) && c.status !== 'operational',
    );
  } catch {
    return null; // unknown — never let the status probe fail the gate
  }
}

// Pin the REST API version on every gh api call. gh has defaulted to
// 2022-11-28 for years, but that default is not contractual: a future gh
// release could bump it and silently change the endpoint responses this gate
// parses. (The PR #125 reviews-list 404 was NOT version drift — the runner's
// gh 2.97.0 sends the identical header — but pinning removes that whole class
// of surprise.) Codex P1, PR #125 review.
const API_VERSION = '2022-11-28';
function gh(cmd) {
  return `gh api -H "X-GitHub-Api-Version: ${API_VERSION}" ${cmd}`;
}

function runQuiet(cmd) {
  // Same cap as the monitor: a paginated PR/comments sweep can exceed
  // execSync's 1 MB default once the repo grows past a few dozen PRs.
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function sleepSync(ms) {
  // Synchronous sleep: the initial comments/reviews fetches run before the
  // async wait-for-review loop, so a transient-error retry cannot await.
  // Atomics.wait on the main thread blocks for ms without spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Paginated fetch. gh api --paginate emits one JSON document per page, so
 * JSON.parse breaks on a multi-page collection (Codex P2, PR #53 review);
 * --slurp wraps every page in one outer array and we flatten one level — the
 * same pattern as the monitor.
 *
 * Resilience: the reviews list may 404 on the Actions runner even for a PR the
 * meta fetch already resolved, and a degraded GitHub API surfaces as transient
 * 5xx/timeouts on any list (both observed on PR #125/#126). A 404 on the
 * reviews list is treated as empty; transient errors are retried a bounded
 * number of times before the gate fails closed.
 */
function fetchList(cmd, { tolerate404 = false, maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return JSON.parse(runQuiet(`${cmd} --slurp`)).flat();
    } catch (e) {
      const stderr = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr) : '';
      const message = e instanceof Error ? e.message : String(e);
      const text = `${message}\n${stderr}`;
      if (tolerate404 && /not found|404/i.test(text)) {
        // The reviews list is only the secondary "did the bot submit a review"
        // signal behind the inline-comments endpoint, so an unreadable list is
        // treated as empty rather than failing the whole gate (Codex P1,
        // PR #125 review). The PR-existence fetch (pulls/{pr}) above has
        // already run, so a wrong repo/pr would have failed there first.
        console.warn(`  - ${cmd} returned 404 — treating as an empty list (no review list available)`);
        return [];
      }
      // A degraded GitHub API also surfaces as transient 5xx/timeouts on the
      // otherwise-healthy comments list (Codex P1, PR #126 review). Retry a
      // few times before failing, so one 504 does not block the gate.
      const transient = /50[0-9]|429|couldn't respond|timed out|timeout|try resubmitting|connection reset/i.test(text);
      if (transient && attempt < maxAttempts) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  - ${cmd} returned a transient error (attempt ${attempt}/${maxAttempts}) — retrying in ${backoff}ms`);
        sleepSync(backoff);
        continue;
      }
      console.error(`✗ FAIL: could not read review comments (${cmd})`);
      console.error(message);
      if (stderr) console.error(stderr);
      process.exit(1);
    }
  }
}

// ── Head + review observation ────────────────────────────────────────────────

// A finding/review only counts for the commit it was left on; a stale comment
// from a previous head must never block the current one.
const prMeta = JSON.parse(runQuiet(gh(`"repos/${repo}/pulls/${pr}"`)));
const headSha = prMeta.head.sha;
const headRef = prMeta.head.ref;
// Nudging only works for same-repo branches (a fork's head lives in the fork,
// where this workflow's token cannot push).
const headRepoFullName = prMeta.head.repo?.full_name ?? repo;

function fetchComments() {
  return fetchList(gh(`--paginate "repos/${repo}/pulls/${pr}/comments?per_page=100"`));
}
function fetchReviews() {
  return fetchList(gh(`--paginate "repos/${repo}/pulls/${pr}/reviews?per_page=100"`), {
    tolerate404: true,
  });
}

/** Has the bot actually reviewed the CURRENT head (submitted review or inline comment)? */
function botObservedOnHead(comments, reviews) {
  return (
    comments.some((c) => c.user?.login === BOT_LOGIN && c.commit_id === headSha) ||
    reviews.some((r) => r.user?.login === BOT_LOGIN && r.commit_id === headSha)
  );
}

const githubDegraded = await checkGitHubStatus();
if (githubDegraded === true) {
  console.warn(
    '⚠ GitHub platform is degraded — the Codex review may be delayed; if none ' +
      'arrives the gate reports a distinct "degraded service, retry later" state ' +
      'rather than a bot skip.',
  );
}

let comments = fetchComments();
let reviews = fetchReviews();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Nudge (re-trigger a skipped review) ─────────────────────────────────────
// The bot occasionally misses a PR entirely (no review after the wait window).
// Rather than fall straight to the human --allow-no-review certification, the
// gate pushes an empty commit on the PR head — the synchronize event is the
// universal "please re-review" signal. The push MUST use a dedicated PAT
// (CODEX_NUDGE_TOKEN), never GITHUB_TOKEN: a GITHUB_TOKEN push changes the
// head but Actions suppresses the synchronize event for its own token, so the
// required `validate` check never runs on the nudge head and the PR becomes
// unmergeable even after the bot reviews (Codex P1, PR #103 review). A PAT
// push triggers the normal pull_request workflows AND re-fires the bot, so
// every required check re-runs on the new head. Without the token the nudge is
// skipped (the head is left untouched) and the WAITING fallback applies.
// Nudges are capped and only ever fire on real pull_request runs against
// same-repo heads.
const NUDGE_MARKER = 'codex-nudge:';
const canNudge =
  process.env.GITHUB_ACTIONS === 'true' &&
  !!process.env.GH_TOKEN &&
  !!process.env.CODEX_NUDGE_TOKEN &&
  process.env.GITHUB_EVENT_NAME === 'pull_request' &&
  headRepoFullName === repo;

function countNudges() {
  const commits = fetchList(gh(`--paginate "repos/${repo}/pulls/${pr}/commits?per_page=100"`));
  return commits.filter((c) => (c.commit?.message ?? '').includes(NUDGE_MARKER)).length;
}

function pushNudge(attempt) {
  const token = process.env.CODEX_NUDGE_TOKEN ?? '';
  const message = `${NUDGE_MARKER} retry Codex review (attempt ${attempt} of ${nudgeMax})`;
  // The token rides the push URL (never the logged command): redact it from
  // any failure message so a broken push cannot leak the secret.
  const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const cmds = [
    'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"',
    'git config user.name "github-actions[bot]"',
    `git fetch --no-tags origin "pull/${pr}/head"`,
    `git checkout -q -B "__codex-nudge-${pr}" FETCH_HEAD`,
    `git commit -q --allow-empty -m "${message}"`,
    `git push "${pushUrl}" "HEAD:refs/heads/${headRef}"`,
  ];
  const redact = (s) => (token ? s.replaceAll(token, '***') : s);
  for (const cmd of cmds) {
    try {
      runQuiet(cmd);
    } catch (e) {
      console.warn(
        `  - nudge failed at \`${redact(cmd)}\` (${redact(e instanceof Error ? e.message : String(e))})`,
      );
      return false;
    }
  }
  return true;
}

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
    if (githubDegraded === true) {
      // Distinct state (Codex P1, PR #125/#126 review): the review has not
      // arrived because GitHub's platform is degraded — not because the bot
      // skipped the PR and not because of a code finding. A human must retry
      // later; certifying this as a bot skip would be wrong. The nudge is
      // skipped too: pushing an empty commit re-fires the bot, which is
      // itself delayed by the same outage.
      console.error(
        `✗ FAIL: GitHub platform is degraded — the Codex review has not arrived for head ${headSha} ` +
          `and is likely delayed by the outage. Retry later (do NOT certify this as a bot skip).`,
      );
      postDegradedAlert(headSha);
      process.exit(1);
    }
    // Before asking for the human --allow-no-review certification, give the
    // bot another chance: push an empty nudge commit (capped) so its
    // synchronize event re-fires the review. Only in Actions, only on
    // pull_request runs, only on same-repo heads.
    if (canNudge && nudgeMax > 0) {
      const nudgesSoFar = countNudges();
      if (nudgesSoFar < nudgeMax && pushNudge(nudgesSoFar + 1)) {
        console.error(
          `✗ FAIL: no Codex review observed on head ${headSha} — pushed a nudge commit ` +
            `(attempt ${nudgesSoFar + 1} of ${nudgeMax}) to re-trigger the bot; its review ` +
            `will re-run this check. If the bot still does not review after the nudges, ` +
            `re-run with --allow-no-review.`,
        );
        process.exit(1);
      }
    }
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
  resolveAlertIfPosted(headSha);
  resolveDegradedIfPosted(headSha);
  selfHealCancelledRun();
  process.exit(0);
}

/** The gate's bot-style comment already posted on the thread carrying `marker`, if any. */
function gateCommentForHead(marker) {
  try {
    return (
      JSON.parse(
        runQuiet(gh(`--paginate "repos/${repo}/issues/${pr}/comments?per_page=100" --slurp`)),
      ).flat().find((c) => typeof c.body === 'string' && c.body.includes(marker)) ?? null
    );
  } catch {
    return null;
  }
}

function writeCommentBody(body) {
  const bodyFile = join(tmpdir(), `codex-gate-alert-${pr}-${Date.now()}.json`);
  writeFileSync(bodyFile, JSON.stringify({ body }));
  return bodyFile;
}

function sendComment(body, comment, verb) {
  const bodyFile = writeCommentBody(body);
  try {
    if (comment) {
      runQuiet(gh(`--method PATCH "repos/${repo}/issues/comments/${comment.id}" --input ${bodyFile}`));
    } else {
      runQuiet(gh(`--method POST "repos/${repo}/issues/${pr}/comments" --input ${bodyFile}`));
    }
    console.log(`  ✎ ${verb} alert comment on PR #${pr}`);
  } catch (e) {
    console.warn(`  - could not ${verb} alert comment (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    try {
      rmSync(bodyFile, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Keep a bot-style summary of the open findings on the PR thread, so the
 * block is visible without opening the check details. One comment per head:
 * a fresh finding on the same head EDITS the existing comment rather than
 * posting another, so the summary is always current (Codex P2, PR #79
 * review).
 */
function postRedAlert(findings, head) {
  if (!inActions) return;
  const marker = `<!-- codex-gate-red: ${head} -->`;
  const lines = [
    marker,
    `## 🚫 Codex review gate is blocking PR #${pr}`,
    '',
    `${findings.length} open Codex finding(s) — fix the code, then reply \`Resolved …\` on each thread to turn the gate green:`,
    '',
    ...findings.map((f) => {
      const color = f.severity === 'P0' ? 'red' : 'orange';
      return (
        `- ![${f.severity} Badge](https://img.shields.io/badge/${f.severity}-${color}?style=flat) ` +
        `**${f.path}${f.line ? ':' + f.line : ''}** — ${f.summary}\n` +
        `  ${f.url}`
      );
    }),
    '',
    'This check is required to merge — the block lifts when every thread above is answered.',
  ];
  const existing = gateCommentForHead(`<!-- codex-gate-red: ${head} -->`);
  sendComment(lines.join('\n'), existing, existing ? 'updated' : 'posted');
}

/**
 * When the gate turns green on a head that was blocked, resolve the stale
 * "blocking" comment instead of leaving it as a permanent lie (Codex P2,
 * PR #79 review). No-op when no red alert was posted for this head.
 */
function resolveAlertIfPosted(head) {
  if (!inActions) return;
  const existing = gateCommentForHead(`<!-- codex-gate-red: ${head} -->`);
  if (!existing) return;
  const body =
    `<!-- codex-gate-resolved: ${head} -->\n` +
    `## ✅ Codex review gate is green on this head\n\n` +
    'All findings that blocked this PR have been answered on their threads.';
  sendComment(body, existing, 'resolved');
}

/**
 * Keep a visible note when the gate is blocked by a degraded GitHub platform
 * rather than by a finding or a bot skip (Codex P1, PR #125/#126 review), so
 * the "retry later" state is visible on the PR thread without opening the
 * check details. One comment per head, edited in place like the red alert.
 */
function postDegradedAlert(head) {
  if (!inActions) return;
  const marker = `<!-- codex-gate-degraded: ${head} -->`;
  const lines = [
    marker,
    '## ⚠️ Codex review gate: GitHub platform is degraded',
    '',
    'The Codex review has not arrived for this head because GitHub\'s platform is degraded. ' +
      'Retry later — this is not a bot skip and not a code finding.',
    '',
    'This check is required to merge — the block lifts when the platform recovers and the bot\'s review lands.',
  ];
  const existing = gateCommentForHead(marker);
  sendComment(lines.join('\n'), existing, existing ? 'updated' : 'posted');
}

/**
 * Resolve a stale degraded-service note once the gate turns green on that
 * head (the platform recovered and the review landed), mirroring the red-alert
 * resolution so the thread never carries a permanent lie.
 */
function resolveDegradedIfPosted(head) {
  if (!inActions) return;
  const marker = `<!-- codex-gate-degraded: ${head} -->`;
  const existing = gateCommentForHead(marker);
  if (!existing) return;
  const body =
    `<!-- codex-gate-degraded-resolved: ${head} -->\n` +
    '## ✅ Codex review gate is green on this head\n\n' +
    'The degraded-platform block has lifted — the review landed and the gate is green.';
  sendComment(body, existing, 'resolved');
}

/**
 * Re-run the merge evaluation after a cancelled gate run left it stale
 * (Codex, PR #113). Review events arrive in bursts, so GitHub cancels the
 * queued gate runs in the concurrency group — and the merge can stay BLOCKED
 * even though the check is green. The recovery a human did by hand was an
 * empty `codex-nudge:` commit to force a fresh evaluation; a green gate in a
 * canonical pull_request run instead re-runs its own check through the
 * Actions API (GITHUB_TOKEN + actions: write), which posts a fresh success
 * check run on the head and re-evaluates the merge — no PAT, no head churn.
 * It runs only on run_attempt 1 so the re-run itself cannot re-trigger and
 * loop, and only after a green verdict (a red gate correctly blocks).
 */
function selfHealCancelledRun() {
  if (!inActions) return;
  // Permit green review-comment/review runs to refresh stale merge state as
  // well as canonical pull_request runs: when a finding is resolved by replying
  // to its thread, the resulting green run is triggered by
  // pull_request_review_comment, not pull_request (Codex P1, PR #122 review).
  const healedEvents = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);
  if (!healedEvents.has(process.env.GITHUB_EVENT_NAME ?? '')) return;
  if ((process.env.GITHUB_RUN_ATTEMPT ?? '1') !== '1') return;

  let runs;
  try {
    runs = JSON.parse(
      runQuiet(gh(`--paginate "repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100" --slurp`)),
    ).flatMap((page) => page.workflow_runs ?? []);
  } catch {
    return; // a read-only probe — never fail the gate because the probe did
  }

  const gateRuns = runs
    .filter((r) => r.name === 'Codex review gate')
    .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
  if (!gateRuns.some((r) => r.conclusion === 'cancelled')) return;
  const toRerun = gateRuns.find((r) => r.conclusion === 'success' || r.conclusion === 'failure');
  if (!toRerun) return;

  try {
    runQuiet(gh(`--method POST "repos/${repo}/actions/runs/${toRerun.id}/rerun"`));
    console.log(
      `  ↻ re-ran the gate check (run ${toRerun.id}) to refresh a stale merge evaluation ` +
        `after a cancelled run on head ${headSha}`,
    );
  } catch (e) {
    console.warn(
      `  - could not re-run the gate check to refresh the merge evaluation ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

postRedAlert(blocking, headSha);
console.error(`✗ FAIL: ${blocking.length} open Codex finding(s) on PR #${pr} — fix, then reply on each thread:`);
for (const f of blocking) {
  console.error(`  • [${f.severity}] ${f.path}${f.line ? ':' + f.line : ''} — ${f.summary}`);
  console.error(`    ${f.url}`);
}
process.exit(1);
