import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/cleanup-correlation-markers.test.ts — lock the marker cleanup.
//
// correlation_markers grows forever as processed correlation ids accumulate
// (one doc per transition, cleared only on the rollback path). The cleanup
// bounds it by deleting markers older than a TTL cutoff. Its load-bearing
// safety properties are: the script is only a CLI wrapper — the sweep and
// every Firestore write live behind the repository boundary
// (deleteStaleCorrelationMarkers, Codex P1, PR #70 review); the cutoff only
// ever selects docs with markedAt < cutoff (never "everything");
// MARKER_TTL_DAYS < 1 is rejected so the script cannot be pointed at the
// whole collection; DRY_RUN writes nothing; batches respect Firestore's
// 500-write limit; and the weekly workflow runs it with the same
// skip-not-fail fork discipline as the other scheduled jobs. A future edit
// that weakens any of these fails here.
// ============================================================================

const SCRIPT = readFileSync('scripts/cleanup-correlation-markers.ts', 'utf8');
const REPO = readFileSync('lib/server/repositories.ts', 'utf8');
const PKG = readFileSync('package.json', 'utf8');
const WORKFLOW = readFileSync('.github/workflows/marker-cleanup.yml', 'utf8');

describe('correlation-marker cleanup · contract lock', () => {
  it('delegates the sweep to the repository — the script has no raw Firestore access', () => {
    // The script imports the repository function and owns no admin/Firestore
    // code of its own (Codex P1, PR #70 review — raw writes from a script
    // bypassed the schema-validated repository boundary).
    expect(SCRIPT).toContain("import { deleteStaleCorrelationMarkers } from '../lib/server/repositories'");
    expect(SCRIPT).toContain('deleteStaleCorrelationMarkers(cutoff, { dryRun: DRY_RUN })');
    expect(SCRIPT).not.toContain('initializeApp');
    expect(SCRIPT).not.toContain("getFirestore(");
    expect(SCRIPT).not.toContain('batch.commit()');
    // The repository owns the deletion.
    expect(REPO).toContain('export async function deleteStaleCorrelationMarkers');
  });

  it('deletes ONLY docs older than the cutoff — never the whole collection', () => {
    // The only read of the collection is the filtered range query inside the
    // repository; a bare (unfiltered) sweep would fetch and delete everything.
    expect(REPO).toContain(".where('markedAt', '<', cutoffMs)");
    expect(REPO).not.toContain("collection('correlation_markers').get()");
    // The cutoff is always derived from the TTL — the sweep is bounded.
    expect(SCRIPT).toContain('cutoff = Date.now() - TTL_DAYS * 86_400_000');
  });

  it('rejects MARKER_TTL_DAYS < 1 so the sweep can never be told to delete everything', () => {
    expect(SCRIPT).toContain('TTL_DAYS < 1');
    expect(SCRIPT).toContain('MARKER_TTL_DAYS must be a positive number of days');
    expect(SCRIPT).toContain('process.exit(1)');
  });

  it('defaults to a 30-day cutoff', () => {
    expect(SCRIPT).toContain('process.env.MARKER_TTL_DAYS ?? 30');
  });

  it('DRY_RUN=1 reports without writing a single batch', () => {
    expect(SCRIPT).toContain("process.env.DRY_RUN === '1'");
    expect(SCRIPT).toContain('would delete');
    // Dry-run is honored by the repository sweep.
    expect(REPO).toContain('dryRun');
    expect(REPO).toContain('if (!options.dryRun) {');
  });

  it('batches at Firestore\'s 500-write limit and paginates with startAfter', () => {
    // The batch limit lives in the repository, where the writes happen.
    expect(REPO).toContain('options.batchSize ?? 500');
    expect(REPO).toContain('batchSize < 1 || batchSize > 500');
    expect(REPO).toContain('.orderBy(\'markedAt\')');
    expect(REPO).toContain('startAfter(lastDoc)');
    expect(REPO).toContain('batch.commit()');
  });

  it('runs via tsx + the server-only shim, the runtime that can load the TS repository layer', () => {
    expect(PKG).toContain('"cleanup:markers": "node --import ./scripts/stub-server-only.mjs --import tsx scripts/cleanup-correlation-markers.ts"');
    expect(PKG).toContain('"tsx"');
    // The shim exists and stubs server-only as a no-op outside Next.
    const SHIM = readFileSync('scripts/stub-server-only.mjs', 'utf8');
    expect(SHIM).toContain("request === 'server-only'");
    expect(SHIM).toContain('return {};');
  });

  it('the weekly workflow runs it on a schedule with skip-not-fail fork discipline', () => {
    expect(WORKFLOW).toContain('schedule:');
    expect(WORKFLOW).toContain('cron:');
    expect(WORKFLOW).toContain('workflow_dispatch:');
    // Run step gated on the credential (skip-not-fail)…
    expect(WORKFLOW).toContain("if: ${{ env.FIREBASE_SERVICE_ACCOUNT != '' }}");
    // …and the loud guard is canonical-repo-only, like the other monitors.
    expect(WORKFLOW).toContain("github.repository == 'LCHEROURI/cook-with-freebuff'");
    expect(WORKFLOW).toContain('npm run cleanup:markers');
  });
});
