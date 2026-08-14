import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/cleanup-correlation-markers.test.ts — lock the marker cleanup.
//
// correlation_markers grows forever as processed correlation ids accumulate
// (one doc per transition, cleared only on the rollback path). The cleanup
// script bounds it by deleting markers older than a TTL cutoff. Its
// load-bearing safety properties are: the cutoff only ever selects docs with
// markedAt < cutoff (never "everything"); MARKER_TTL_DAYS < 1 is rejected so
// the script cannot be pointed at the whole collection; DRY_RUN writes
// nothing; batches respect Firestore's 500-write limit; the emulator branch
// needs no service account; and the weekly workflow runs it with the same
// skip-not-fail fork discipline as the other scheduled jobs. A future edit
// that weakens any of these fails here.
// ============================================================================

const SCRIPT = readFileSync('scripts/cleanup-correlation-markers.mjs', 'utf8');
const PKG = readFileSync('package.json', 'utf8');
const WORKFLOW = readFileSync('.github/workflows/marker-cleanup.yml', 'utf8');

describe('correlation-marker cleanup · contract lock', () => {
  it('deletes ONLY docs older than the cutoff — never the whole collection', () => {
    // The only read of the collection is the filtered range query; a bare
    // (unfiltered) sweep would fetch and delete everything.
    expect(SCRIPT).toContain(".where('markedAt', '<', cutoff)");
    expect(SCRIPT).not.toContain("collection('correlation_markers').get()");
    // The cutoff is always derived from the TTL — the sweep is bounded.
    expect(SCRIPT).toContain('cutoff = Date.now() - TTL_DAYS * 86_400_000');
  });

  it('rejects MARKER_TTL_DAYS < 1 so the sweep can never be told to delete everything', () => {
    expect(SCRIPT).toContain('TTL_DAYS < 1');
    expect(SCRIPT).toContain('MARKER_TTL_DAYS must be a positive number of days');
    expect(SCRIPT).toContain('process.exit(1)');
  });

  it('defaults to a 30-day cutoff', () => {
    expect(SCRIPT).toContain("process.env.MARKER_TTL_DAYS ?? 30");
  });

  it('DRY_RUN=1 reports without writing a single batch', () => {
    expect(SCRIPT).toContain("process.env.DRY_RUN === '1'");
    // The batch is only created and committed when NOT dry-running.
    expect(SCRIPT).toContain('if (!DRY_RUN) {');
    expect(SCRIPT).toContain('batch.commit()');
    expect(SCRIPT).toContain('would delete');
  });

  it('batches at Firestore\'s 500-write limit and paginates with startAfter', () => {
    expect(SCRIPT).toContain('const BATCH_SIZE = 500;');
    expect(SCRIPT).toContain('Firestore hard limit: at most 500 writes per batch');
    expect(SCRIPT).toContain('.orderBy(\'markedAt\')');
    expect(SCRIPT).toContain('startAfter(lastDoc)');
  });

  it('initializes without a service account when FIRESTORE_EMULATOR_HOST is set', () => {
    expect(SCRIPT).toContain("process.env.FIRESTORE_EMULATOR_HOST");
    expect(SCRIPT).toContain("initializeApp({ projectId: 'demo-cook-with-freebuff' })");
  });

  it('is wired as the one-command npm script', () => {
    expect(PKG).toContain('"cleanup:markers": "node scripts/cleanup-correlation-markers.mjs"');
  });

  it('the weekly workflow runs it on a schedule with skip-not-fail fork discipline', () => {
    expect(WORKFLOW).toContain('schedule:');
    expect(WORKFLOW).toContain("cron:");
    expect(WORKFLOW).toContain('workflow_dispatch:');
    // Run step gated on the credential (skip-not-fail)…
    expect(WORKFLOW).toContain("if: ${{ env.FIREBASE_SERVICE_ACCOUNT != '' }}");
    // …and the loud guard is canonical-repo-only, like the other monitors.
    expect(WORKFLOW).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(WORKFLOW).toContain('npm run cleanup:markers');
  });
});
