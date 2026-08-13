import { NextResponse } from 'next/server';
import { getAdminDb, resolveUserId } from '@/lib/server/admin';

// GET /api/status — one glance at the app's health: the live commit + build
// time (same public facts as /api/build-info) plus the last post-deploy
// verify:live verdict, which the verify-live CI job records to the
// `deploy_status/verify_live` doc (scripts/record-verify-status.mjs).
//
// Public by design (the documented exception, exactly like /api/build-info):
// the commit SHA and build time carry no secrets, and the verify:live verdict
// is already public via the GitHub Actions run. To stay inside the repo's
// auth boundary, a caller who DOES present a bearer token must present a
// VALID one — the token is resolved server-side and an invalid token is
// rejected with 401, never silently ignored. The status page sends its ID
// token when signed in. The verify record is read with the ADMIN SDK
// (server-only), so the client rules stay untouched — direct client reads of
// `deploy_status` remain denied.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    const userId = await resolveUserId(token);
    if (!userId) {
      return NextResponse.json({ error: 'invalid token' }, { status: 401 });
    }
  }
  let verifyLive: {
    verdict: string;
    commitSha: string;
    ranAt: string;
    runUrl: string;
  } | null = null;

  const db = getAdminDb();
  if (db) {
    try {
      const snap = await db.collection('deploy_status').doc('verify_live').get();
      if (snap.exists) {
        const d = snap.data() ?? {};
        verifyLive = {
          verdict: typeof d.verdict === 'string' ? d.verdict : '',
          commitSha: typeof d.commitSha === 'string' ? d.commitSha : '',
          ranAt: typeof d.ranAt === 'string' ? d.ranAt : '',
          runUrl: typeof d.runUrl === 'string' ? d.runUrl : '',
        };
      }
    } catch {
      // The status page degrades gracefully — build facts still show even if
      // the verify record can't be read (e.g. emulator mode without one).
      verifyLive = null;
    }
  }

  return NextResponse.json({
    commitSha: process.env.NEXT_PUBLIC_APP_COMMIT_SHA ?? '',
    builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT ?? '',
    emulator: !!process.env.FIRESTORE_EMULATOR_HOST,
    verifyLive,
  });
}
