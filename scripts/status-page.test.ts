import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/status-page.test.ts — lock the status surface contract.
//
// The /status page shows three facts at a glance: the live commit, the build
// time, and the last post-deploy verify:live result. Load-bearing properties:
// the route REQUIRES a valid bearer token outright (the repo's auth boundary:
// every API route resolves the ID token via resolveUserId — no token, or an
// invalid one, gets 401; no public exception). The status page sends its ID
// token when signed in and shows a sign-in prompt when signed out. It returns
// the same build facts as /api/build-info plus a `verifyLive` record read with
// the ADMIN SDK from `deploy_status/verify_live` (client rules untouched), and
// the CI recorder validates the document with a Zod schema before persisting
// — a malformed commit or run URL is never stored and later trusted. A future
// edit that drops the auth gate, the admin-only read, or the recorder contract
// fails here instead of shipping a status page that silently shows nothing.
// ============================================================================

const ROUTE = readFileSync('app/api/status/route.ts', 'utf8');
const PAGE = readFileSync('app/status/page.tsx', 'utf8');
const RECORDER = readFileSync('scripts/record-verify-status.mjs', 'utf8');

describe('app/api/status/route.ts · authenticated status route', () => {
  it('requires a valid bearer token outright — no tokenless public exception', () => {
    // The repo's auth boundary: every API route resolves the Firebase ID token
    // server side. No token (or an invalid one) is rejected with 401 — the
    // route is never readable tokenless.
    expect(ROUTE).toContain("import { getAdminDb, resolveUserId } from '@/lib/server/admin'");
    expect(ROUTE).toContain('authorization');
    expect(ROUTE).toContain('Bearer ');
    expect(ROUTE).toContain("const userId = await resolveUserId(token);");
    expect(ROUTE).toContain("if (!userId) {");
    expect(ROUTE).toContain("NextResponse.json(");
    expect(ROUTE).toContain("status: 401 }");
  });

  it('returns the same build facts as /api/build-info', () => {
    expect(ROUTE).toContain('NEXT_PUBLIC_APP_COMMIT_SHA');
    expect(ROUTE).toContain('NEXT_PUBLIC_APP_BUILT_AT');
    expect(ROUTE).toContain('emulator: !!process.env.FIRESTORE_EMULATOR_HOST');
  });

  it('reads the verify:live record with the ADMIN SDK from deploy_status/verify_live', () => {
    expect(ROUTE).toContain("import { getAdminDb, resolveUserId } from '@/lib/server/admin'");
    expect(ROUTE).toContain("collection('deploy_status').doc('verify_live')");
    // The admin SDK bypasses client rules — the route must never open a
    // client-readable path to the record.
    expect(ROUTE).not.toContain('getFirestore(');
  });

  it('degrades gracefully when the record cannot be read', () => {
    expect(ROUTE).toContain('verifyLive = null');
  });
});

describe('app/status/page.tsx · the glance surface', () => {
  it('shows the three facts and the pass/fail verdict', () => {
    expect(PAGE).toContain('Live commit');
    expect(PAGE).toContain('Built');
    expect(PAGE).toContain('Last verify:live');
    expect(PAGE).toContain("'✓ Passing'");
    expect(PAGE).toContain("'✗ Failing'");
    expect(PAGE).toContain('No run recorded yet');
  });

  it('fetches the status route WITH the ID token and links to the commit + CI run', () => {
    // The page sends its Firebase ID token when signed in so the route's
    // token resolution runs — never a tokenless fetch that hides the
    // auth-boundary wiring.
    expect(PAGE).toContain("fetch('/api/status'");
    expect(PAGE).toContain('headers.authorization = `Bearer ${token}`');
    expect(PAGE).toContain("import { useAuthSession } from '@/lib/auth/useAuthSession'");
    expect(PAGE).toContain('LCHEROURI/cook-with-freebuff/commit/');
    expect(PAGE).toContain('View the CI run ↗');
  });

  it('gates the fetch on a signed-in user — never a tokenless request', () => {
    expect(PAGE).toContain("if (auth.state !== 'ready' || !auth.user) return;");
    expect(PAGE).toContain('res.status === 401');
  });

  it('shows a sign-in prompt when signed out instead of an empty state', () => {
    expect(PAGE).toContain('Sign in to see kitchen status');
    expect(PAGE).toContain('Sign in with Google');
    expect(PAGE).toContain('auth.signIn()');
    expect(PAGE).toContain('signInButton');
  });

});

describe('scripts/record-verify-status.mjs · the recorder', () => {
  it('writes the fixed doc the route reads, with verdict + commit + run url', () => {
    expect(RECORDER).toContain("collection('deploy_status').doc('verify_live')");
    expect(RECORDER).toContain('verdict,');
    expect(RECORDER).toContain('commitSha,');
    expect(RECORDER).toContain('ranAt: new Date().toISOString()');
    expect(RECORDER).toContain('runUrl');
  });

  it('requires the service account already present in the verify-live job env', () => {
    expect(RECORDER).toContain('FIREBASE_SERVICE_ACCOUNT required');
    expect(RECORDER).toContain('already wired in the verify-live job env');
  });

  it('only accepts success|failure and fails loudly otherwise', () => {
    expect(RECORDER).toContain("verdict !== 'success' && verdict !== 'failure'");
    expect(RECORDER).toContain("verdict must be success|failure");
    expect(RECORDER).toContain('process.exit(1)');
  });

  it('validates the document with a Zod schema BEFORE persisting it', () => {
    // A malformed commit or run URL must never be stored and later trusted by
    // the /api/status route — schema-validate the write like every repository.
    expect(RECORDER).toContain("import { z } from 'zod'");
    expect(RECORDER).toContain('verifyLiveStatusSchema');
    expect(RECORDER).toContain('safeParse(statusDoc)');
    expect(RECORDER).toContain('refusing to persist an invalid status document');
    expect(RECORDER).toContain('doc.set(parsed.data)');
  });
});
