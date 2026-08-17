import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/reply-finding.test.ts — pin the finding-reply REST shape.
//
// The gate resolves a finding only when a human reply lands on its thread.
// The reply POST has three load-bearing details, all observed live on PR #128
// where a wrong call silently stalled the merge:
//   • endpoint: pulls/{n}/comments (review comments), never issues/{n}/comments
//   • reply key: `in_reply_to` (typed -F, a JSON number) — the lookalike
//     `in_reply_to_id` is rejected with 422 ("not a permitted key") and a
//     string in_reply_to fails the schema as if the key were absent
//   • body as a plain string field (-f body=)
// This reads the real script from disk and pins the exact command text, the
// same contract-locked style as the gate's tests: an edit that swaps in the
// wrong key or endpoint turns these assertions red.
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

  it('uses the typed -F in_reply_to=<id> key, and never the 422 lookalike', () => {
    expect(REPLY).toContain('-F in_reply_to=${commentId}');
    // The wrong key is rejected outright by the API. Scoped to the command
    // form: the header comment legitimately names `in_reply_to_id` while
    // explaining the 422, so the word alone must not fail.
    expect(REPLY).not.toContain('in_reply_to_id=${commentId}');
    // The string form (-f) fails the schema as if the key were absent.
    expect(REPLY).not.toContain('-f in_reply_to=');
  });

  it('sends the body as a plain string field', () => {
    expect(REPLY).toContain('-f body=');
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
