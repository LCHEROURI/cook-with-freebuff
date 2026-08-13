import { NextResponse } from 'next/server';
import { getAdminDb, resolveUserId } from '@/lib/server/admin';

// GET /api/status — one glance at the app's health: the live commit + build
// time plus the last post-deploy verify:live verdict, which the verify-live
// CI job records to the `deploy_status/verify_live` doc
// (scripts/record-verify-status.mjs).
//
// Authenticated outright, matching the repo's auth boundary (every API route
// resolves the Firebase ID token server side via resolveUserId): a caller
// without a valid bearer token gets 401. The status page sends its ID token
// when signed in and shows a sign-in prompt when signed out. The verify
// record is read with the ADMIN SDK (server-only), so the client rules stay
// untouched — direct client reads of `deploy_status` remain denied.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  const userId = await resolveUserId(token);
  if (!userId) {
    return NextResponse.json(
      { error: 'UNAUTHENTICATED', message: 'Authentication required' },
      { status: 401 },
    );
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
