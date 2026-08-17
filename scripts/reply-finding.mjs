#!/usr/bin/env node
// ============================================================================
// scripts/reply-finding.mjs — post a reply on a Codex finding's thread.
//
// The gate treats a finding as OPEN until a human reply lands on its thread
// (a comment whose in_reply_to_id points at it). This script posts that reply
// so the gate can resolve the finding and the PR can merge.
//
// The GitHub REST shape is load-bearing:
//   • endpoint: POST /repos/{owner}/{repo}/pulls/{n}/comments (the review
//     comments endpoint, the same one the gate reads replies from). An issue
//     comment (issues/{n}/comments) never resolves a finding thread.
//   • reply target key: `in_reply_to` = the numeric id of the TOP level bot
//     comment. The lookalike key `in_reply_to_id` is NOT permitted and the
//     request is rejected with 422 ("in_reply_to_id is not a permitted key"),
//     leaving the thread open — the exact stall observed live on PR #128.
//   • the value must be a JSON number: the typed -F (not -f) flag, because a
//     string in_reply_to fails the endpoint schema and is rejected as if the
//     key were absent.
// scripts/reply-finding.test.ts pins all three, so a wrong key or endpoint
// fails CI instead of silently stalling a merge.
//
// Usage:
//   node scripts/reply-finding.mjs --pr 128 --comment 3797792074
//   node scripts/reply-finding.mjs --pr 128 --comment 3797792074 --body "Resolved: dropped RESOURCE_EXHAUSTED"
//   PR_NUMBER=128 FINDING_COMMENT_ID=3797792074 node scripts/reply-finding.mjs
//
// Exit codes: 0 = reply posted, 1 = gh rejected or failed the call, 2 = usage.
// ============================================================================

import { execSync } from 'node:child_process';

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
const commentId = take('--comment') ?? process.env.FINDING_COMMENT_ID;
const body = take('--body') ?? 'Resolved';

if (!pr || !/^\d+$/.test(pr)) {
  console.error('✗ FAIL: --pr <number> required');
  process.exit(2);
}
if (!commentId || !/^\d+$/.test(commentId)) {
  console.error('✗ FAIL: --comment <number> required (the bot comment id from pulls/{n}/comments)');
  process.exit(2);
}

// ── gh wrapper ───────────────────────────────────────────────────────────────

// Pin the REST API version on the call, same as the gate: gh's default header
// is not contractual, so this removes version drift from the reply path too.
const API_VERSION = '2022-11-28';
function gh(cmd) {
  return `gh api -H "X-GitHub-Api-Version: ${API_VERSION}" ${cmd}`;
}

function runLoud(cmd) {
  let out;
  try {
    out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    const stderr = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr) : String(e);
    console.error(`✗ FAIL: reply not posted (exit ${e.status ?? 'unknown'}):\n${stderr}`);
    process.exit(1);
  }
  return out;
}

// The reply goes to the REVIEW-comments endpoint with the typed -F
// in_reply_to=<id>. The body is a plain string field. Single line body only:
// a body containing double quotes would break the shell quoting.
const postedId = runLoud(
  gh(`--method POST "repos/${repo}/pulls/${pr}/comments" -f body="${body}" -F in_reply_to=${commentId} --jq '.id'`),
);
console.log(`  ✓ reply posted (comment id ${postedId}) on finding ${commentId} (PR #${pr})`);
