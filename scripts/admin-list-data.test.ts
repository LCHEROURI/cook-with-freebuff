import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/admin-list-data.test.ts — lock the owner-data read contract.
//
// The admin-list script is a READ-ONLY Firestore probe. Its load-bearing
// properties are: (1) it never scans the whole collection — both queries are
// scoped to a uid; (2) it is genuinely read-only (no writes/deletes), so it
// is safe to run against production; (3) it fails loudly instead of returning
// a misleading empty list when its credentials are missing. A future edit
// that breaks any of these fails here.
// ============================================================================

const SCRIPT = readFileSync('scripts/admin-list-data.mjs', 'utf8');
const PKG = readFileSync('package.json', 'utf8');

describe('scripts/admin-list-data.mjs · owner-data read contract', () => {
  it('reads recipes and pantry_items, scoped to the uid (never a full scan)', () => {
    expect(SCRIPT).toContain("collection('recipes')");
    expect(SCRIPT).toContain("collection('pantry_items')");
    expect(SCRIPT).toContain("where('userId', '==', UID)");
  });

  it('is read-only — it never writes or deletes', () => {
    expect(SCRIPT).not.toMatch(/\.(set|add|update|delete)\(/);
  });

  it('fails loudly when the service account or uid is missing (no silent empty list)', () => {
    expect(SCRIPT).toContain('FIREBASE_SERVICE_ACCOUNT');
    expect(SCRIPT).toContain('APP_OWNER_UID');
    expect(SCRIPT).toContain('process.exit(1)');
  });

  it('is wired to the one-command npm script', () => {
    expect(PKG).toContain('"admin:list": "node scripts/admin-list-data.mjs"');
  });
});
