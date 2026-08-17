import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/reply-finding.test.ts — pin the finding-reply REST shape.
//
// The gate resolves a finding only when a human reply lands on its thread.
// The reply POST has four load-bearing details, all observed on PR #128/#130:
//   • endpoint: pulls/{n}/comments (review comments), never issues/{n}/comments
//   • reply key: `in_reply_to` as a JSON number — the lookalike
//     `in_reply_to_id` is rejected with 422 ("not a permitted key") and a
//     string in_reply_to fails the schema as if the key were absent
//   • payload via --input (a JSON.stringify'd temp file), so no body content
//     (quotes, $VAR, $(...), backticks) ever reaches a shell — the -f body
//     interpolation was rejected as a P2 on PR #130
//   • pinned API version header through the same gh wrapper as the gate
// This reads the real script from disk and pins the exact command text, the
// same contract-locked style as the gate's tests: an edit that swaps in the
// wrong key, endpoint, or shell interpolation turns these assertions red.
// ============================================================================

const REPLY = readFileSync('scripts/reply-finding.mjs', 'utf8');

describe('scripts/reply-finding.mjs · correct in_reply_to contract', () => {
  it('posts to the REVIEW-comments endpoint (pulls/{n}/comments), never issues/{n}/comments', () => {
    expect(REPLY).toContain('repos/${repo}/pulls/${pr}/comments');
    // An issue comment never resolves a finding thread: the gate only builds
    // its replied-to set from pulls/{n}/comments, so the wrong endpoint would
    // post a comment that looks fine but never unblocks the PR.
    expect(REPLY).not.toContain('repos/${repo}/issues/${pr}/comments');
  });

  it('sends in_reply_to as a JSON number in the payload, and never the 422 lookalike', () => {
    expect(REPLY).toContain('in_reply_to: Number(commentId)');
    // The wrong key is rejected outright by the API. Scoped to the payload
    // form: the header comment legitimately names `in_reply_to_id` while
    // explaining the 422, so the word alone must not fail.
    expect(REPLY).not.toContain('in_reply_to_id:');
    // The string form fails the schema as if the key were absent.
    expect(REPLY).not.toContain('-f in_reply_to=');
  });

  it('sends the payload via --input so no body content can reach the shell', () => {
    expect(REPLY).toContain('--input ${bodyFile}');
    expect(REPLY).toContain('JSON.stringify({ body, in_reply_to: Number(commentId) })');
    // The body must never be interpolated into a shell command: $VAR, $(...),
    // backticks, or quotes in a custom --body would otherwise be expanded or
    // executed before gh ever saw it (the P2 on PR #130).
    expect(REPLY).not.toContain('${body}');
    // The temp payload file is cleaned up on every path.
    expect(REPLY).toContain('rmSync(bodyFile');
  });

  it('stamps the pinned API version header through the same gh wrapper as the gate', () => {
    expect(REPLY).toContain("const API_VERSION = '2022-11-28';");
    expect(REPLY).toContain('function gh(cmd)');
    expect(REPLY).toContain('X-GitHub-Api-Version: ${API_VERSION}');
    // No bare gh api invocation may bypass the wrapper.
    expect(REPLY).not.toContain('runLoud(`gh api');
  });

  it('fails loudly on a rejected call instead of swallowing the 422 (a silent stall blocks merges)', () => {
    expect(REPLY).toContain('process.exit(1)');
    expect(REPLY).toContain('stderr');
  });
});
