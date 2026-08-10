import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-deployed-hash.test.ts — lock the base driver's plain-mode
// list query contract.
//
// The v6 deployments LIST endpoint filters by PROJECT ID, not project NAME —
// passing `project=<name>` is silently ignored, so the plain report (no
// --url) used to return the team's LATEST deployment regardless of project
// (which could be the OTHER app's commit). The fix resolves the projectId
// from the `vercel link` file and falls back to the name only before linking.
// CI never uses this list branch (the post-deploy gates always pass --url),
// so this lock protects the local report's trustworthiness.
// ============================================================================

const DRIVER = readFileSync('scripts/verify-deployed-hash.mjs', 'utf8');

describe('scripts/verify-deployed-hash.mjs · plain-mode project filter', () => {
  it('filters the v6 list query by projectId from the vercel link file, not the project name', () => {
    // The load-bearing line: projectId is what the API actually filters on.
    // A future edit that reverts to `project=${PROJECT}` (the silent-ignore
    // bug) fails here.
    expect(DRIVER).toContain("projectId = JSON.parse(readFileSync(resolve(process.cwd(), '.vercel/project.json'), 'utf8'))?.projectId ?? null;");
    expect(DRIVER).toContain('projectId ? `projectId=${encodeURIComponent(projectId)}` : `project=${PROJECT}`');
  });

  it('keeps the name fallback only for pre-link repos, and documents why the id is required', () => {
    // The fallback exists so an unlinked repo still works; the comment must
    // stay so a future edit cannot silently reintroduce the silent-ignore
    // bug without re-deciding. CI never uses this branch (post-deploy gates
    // pass --url), so the lock is about the local report.
    expect(DRIVER).toContain('SILENTLY IGNORED');
    expect(DRIVER).toContain('name fallback only applies before the repo is linked');
    expect(DRIVER).toContain('CI never uses');
    expect(DRIVER).toContain('this list branch');
  });
});
