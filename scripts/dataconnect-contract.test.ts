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

/**
 * Extract the version-guard filter block: the `where: { ... }` that holds the
 * `_and` array in the session update. The caller asserts on this whole block
 * rather than on independent substrings, so a change from `_and` to `_or`
 * (which would update a session when EITHER the id or version matches, and
 * silently defeat optimistic concurrency) fails the contract test.
 */
function versionGuardFilter(text: string): string {
  const whereIdx = text.indexOf('where: {');
  expect(whereIdx, `${text.split('\n')[0]} lost its where block`).toBeGreaterThanOrEqual(0);
  const andIdx = text.indexOf('_and: [', whereIdx);
  expect(andIdx, `${text.split('\n')[0]} lost the _and conjunction`).toBeGreaterThanOrEqual(0);
  const close = text.indexOf(']', andIdx);
  expect(close, `${text.split('\n')[0]} lost the _and array close`).toBeGreaterThanOrEqual(0);
  return text.slice(whereIdx, close + 1);
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
      // The write must match BOTH the id and the expected version (AND, never
      // OR — an _or filter would update a session when either matches), and
      // bump the version — dropping any of these breaks optimistic
      // concurrency. The whole filter block is asserted, not the two
      // predicates independently, so the conjunction itself is pinned.
      const filter = versionGuardFilter(text);
      expect(filter).toContain('_and: [');
      expect(filter).toContain('{ id: { eq: $id } }');
      expect(filter).toContain('{ version: { eq: $expectedVersion } }');
      expect(filter).not.toContain('_or');
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
