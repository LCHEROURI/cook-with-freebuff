import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/dataconnect-contract.test.ts — lock the session-update concurrency
// contract in the SQL Connect connector.
//
// repositories.updateSession runs an optimistic-concurrency update: the write
// applies only when the stored version equals the caller's expectedVersion,
// and a lost race surfaces as the version-conflict error the session service
// maps to VersionConflictError. In SQL Connect that contract lives in the
// UpdateSession mutations (the plain variant and the marker-carrying
// UpdateSessionWithMarker): NO_ACCESS auth (the Node Admin SDK is the only
// caller), a @transaction filtered update on id + version, `version_update:
// { inc: 1 }`, and a @check that aborts the transaction when no row matched.
// A future edit that drops any of these would silently break the session
// service's concurrency and retry-dedupe semantics — this test fails instead.
// ============================================================================

const MUTATIONS = readFileSync('dataconnect/example/mutations.gql', 'utf8');

/** Extract a top-level mutation's text, from `mutation <name>(` to its balanced close brace. */
function mutationText(src: string, name: string): string {
  const start = src.indexOf(`mutation ${name}(`);
  expect(start, `mutation ${name} not found`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

describe('dataconnect session-update concurrency contract', () => {
  for (const mutation of ['UpdateSession', 'UpdateSessionWithMarker']) {
    const text = mutationText(MUTATIONS, mutation);

    it(`${mutation} stays @auth(level: NO_ACCESS)`, () => {
      expect(text).toMatch(/@auth\(level: NO_ACCESS\)/);
    });

    it(`${mutation} stays a @transaction`, () => {
      expect(text).toMatch(/@transaction/);
    });

    it(`${mutation} keeps the version-guarded filtered update`, () => {
      // The write must match BOTH the id and the expected version, and bump
      // the version — dropping any of these breaks optimistic concurrency.
      expect(text).toContain('id: { eq: $id }');
      expect(text).toContain('version: { eq: $expectedVersion }');
      expect(text).toContain('version_update: { inc: 1 }');
    });

    it(`${mutation} keeps the @check conflict guard with the mapped message`, () => {
      // The session service maps this message back to its existing
      // "Session ${id} version conflict" error; rewording it breaks that
      // mapping and the tests that expect it.
      expect(text).toContain(
        '@check(expr: "this != null", message: "Session version conflict or missing")',
      );
    });
  }

  it('every mutation in the connector stays NO_ACCESS (the server is the only principal)', () => {
    const names = [...MUTATIONS.matchAll(/^mutation (\w+)\(/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        mutationText(MUTATIONS, name),
        `mutation ${name} lost its NO_ACCESS auth`,
      ).toMatch(/@auth\(level: NO_ACCESS\)/);
    }
  });
});
