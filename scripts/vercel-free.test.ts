import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/vercel-free.test.ts — lock the repo free of Vercel wiring.
//
// The App Hosting primary migration (spec 0001) retired Vercel from the
// pipeline: the deployment_status workflow (verify-deployed.yml) was deleted,
// VERCEL_TOKEN appears nowhere, every gate is tokenless, and no vercel.app
// URL is a valid target. The Vercel GitHub integration was also disconnected
// from the repo (the cook-with-freebuff Vercel project was unlinked and
// deleted). This test reads the REAL files from disk (never fixtures) and
// asserts none of that wiring can quietly reappear in the two surfaces that
// could reintroduce it: the GitHub workflows and the runnable scripts.
//
// Scope discipline (mirrors ci-workflows.test.ts): test files are excluded
// from the scripts scan because they legitimately NAME Vercel in their own
// negative locks (e.g. expect(CI).not.toContain('VERCEL_TOKEN')). A raw scan
// of test files would false-positive on exactly the assertions that keep the
// migration locked. Non-test .mjs and .ts scripts are the surfaces that could
// actually call Vercel, so those are scanned.
//
// The scripts scan is RECURSIVE on purpose: a runnable script added under a
// subdirectory (e.g. scripts/deploy/release.mjs) must be caught by the same
// contract as one at the top level. The workflow scan stays flat because
// GitHub Actions only reads .github/workflows/*.yml at the top level.
// ============================================================================

const WORKFLOW_DIR = '.github/workflows';
const SCRIPTS_DIR = 'scripts';

// Walk a directory tree recursively and return every runnable script path
// (.mjs or .ts, excluding test files and type declarations).
function walkRunnableScripts(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRunnableScripts(full, acc);
    } else if (
      (entry.name.endsWith('.mjs') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.') &&
      !entry.name.endsWith('.d.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

const workflowFiles = readdirSync(WORKFLOW_DIR).filter(
  (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
);
const scriptFiles = walkRunnableScripts(SCRIPTS_DIR);

describe('no Vercel wiring can reappear in workflows or scripts', () => {
  it('reads the REAL files from disk (non-empty, never fixtures)', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(scriptFiles.length).toBeGreaterThan(0);
    for (const f of workflowFiles) {
      expect(readFileSync(join(WORKFLOW_DIR, f), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('has NO Vercel reference of any kind in any workflow file', () => {
    // Covers vercel.app URLs, VERCEL_TOKEN, api.vercel.com calls, vercel CLI
    // auth, and the deployment_status trigger (the retired Vercel event) in
    // one sweep: /vercel/i matches every reintroduction shape.
    for (const f of workflowFiles) {
      expect(readFileSync(join(WORKFLOW_DIR, f), 'utf8')).not.toMatch(/vercel/i);
    }
  });

  it('has NO Vercel reference of any kind in any non-test script', () => {
    for (const f of scriptFiles) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/vercel/i);
    }
  });

  it('has NO deployment_status trigger in any workflow file', () => {
    // verify-deployed.yml (the Vercel deployment_status workflow) was deleted
    // in the migration. A workflow that triggers on deployment_status is the
    // old event shape returning; it must never come back.
    for (const f of workflowFiles) {
      expect(readFileSync(join(WORKFLOW_DIR, f), 'utf8')).not.toContain('deployment_status');
    }
  });
});
