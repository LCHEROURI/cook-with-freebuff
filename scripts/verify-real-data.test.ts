import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = 'scripts/verify-real-data.mjs';
const SCRIPT = existsSync(SCRIPT_PATH) ? readFileSync(SCRIPT_PATH, 'utf8') : '';
const PACKAGE = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('verify:real-data production safety contract', () => {
  it('is explicit opt-in and refuses emulator configuration', () => {
    expect(PACKAGE.scripts?.['verify:real-data']).toBe(
      'node scripts/verify-real-data.mjs --confirm-production',
    );
    expect(SCRIPT).toContain("process.argv.includes('--confirm-production')");
    expect(SCRIPT).toContain('FIRESTORE_EMULATOR_HOST');
    expect(SCRIPT).toContain('FIREBASE_AUTH_EMULATOR_HOST');
    expect(SCRIPT).toContain('Refusing to run a production proof with emulator hosts configured');
    expect(SCRIPT).toContain("const EXPECTED_PROJECT_ID = 'portfolio-app-freebuff2'");
    expect(SCRIPT).toContain('serviceAccount.project_id !== EXPECTED_PROJECT_ID');
  });

  it('proves the deployed revision and App Check enforcement before Admin setup', () => {
    expect(SCRIPT).toContain('parseProductionPreflightOptions(process.argv.slice(2), process.env)');
    expect(SCRIPT).toContain('await verifyProductionPreflight(preflightOptions)');
    expect(SCRIPT.indexOf('await verifyProductionPreflight(preflightOptions)')).toBeLessThan(
      SCRIPT.indexOf('initializeAdminApp('),
    );
  });

  it('uses two unique temporary identities and authenticated client writes', () => {
    expect(SCRIPT).toContain('randomUUID()');
    expect(SCRIPT).toContain('verify-real-data-owner-');
    expect(SCRIPT).toContain('verify-real-data-other-');
    expect(SCRIPT.match(/createCustomToken\(/g)).toHaveLength(2);
    expect(SCRIPT.match(/signInWithCustomToken\(/g)).toHaveLength(2);
    expect(SCRIPT).toContain("doc(ownerDb, 'pantry_items', documentId)");
    expect(SCRIPT).toContain('await setDoc(ownerRef, pantryItem)');
    expect(SCRIPT).toContain('await getDoc(ownerRef)');
    expect(SCRIPT).toContain('await updateDoc(ownerRef');
    expect(SCRIPT).toContain('await deleteDoc(ownerRef)');
    expect(SCRIPT).toContain("await expectPermissionDenied('owner post-delete read'");
    expect(SCRIPT).not.toContain('const removed = await getDoc(ownerRef)');
  });

  it('proves second-user read, update, and delete are permission-denied', () => {
    expect(SCRIPT).toContain("doc(otherDb, 'pantry_items', documentId)");
    expect(SCRIPT).toContain("await expectPermissionDenied('cross-user read'");
    expect(SCRIPT).toContain("await expectPermissionDenied('cross-user update'");
    expect(SCRIPT).toContain("await expectPermissionDenied('cross-user delete'");
    expect(SCRIPT).toContain("code !== 'permission-denied'");
  });

  it('always removes the probe document and temporary Auth users', () => {
    expect(SCRIPT).toContain('try {');
    expect(SCRIPT).toContain('finally {');
    expect(SCRIPT).toContain('adminDb.collection(PANTRY_COLLECTION).doc(documentId).delete()');
    expect(SCRIPT).toContain('await Promise.allSettled([ownerUid, otherUid].map');
    expect(SCRIPT).toContain("result.status === 'rejected'");
    expect(SCRIPT).toContain("process.once('SIGINT'");
    expect(SCRIPT).toContain("process.once('SIGTERM'");
  });

  it('keeps credentials and tokens out of output', () => {
    expect(SCRIPT).not.toMatch(/console\.(?:log|error)\([^\n]*(?:customToken|idToken|API_KEY|SA_JSON)/);
    expect(SCRIPT).not.toContain('console.log(process.env');
    expect(SCRIPT).toContain('No credentials or tokens are printed.');
  });
});
