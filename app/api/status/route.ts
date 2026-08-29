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
  type VerifyRecord = {
    verdict: string;
    commitSha: string;
    ranAt: string;
    runUrl: string;
    // Optional sub-field distinguishing an INTENTIONAL spare-path failure
    // (drill / overlapping-run collision) from a real regression.
    reason: string | null;
    // Dispatch source tag ('ci', 'spare-drill', 'boundary-drill',
    // 'regression-drill'). Only present on drill runs; absent on clean
    // ci.yml runs. Lets the status page flag a reason=null failure that
    // did NOT originate from a drill as a genuine regression.
    source: string | null;
  };
  const toVerifyRecord = (d: Record<string, unknown>): VerifyRecord => ({
    verdict: typeof d.verdict === 'string' ? d.verdict : '',
    commitSha: typeof d.commitSha === 'string' ? d.commitSha : '',
    ranAt: typeof d.ranAt === 'string' ? d.ranAt : '',
    runUrl: typeof d.runUrl === 'string' ? d.runUrl : '',
    reason: typeof d.reason === 'string' ? d.reason : null,
    source: typeof d.source === 'string' ? d.source : null,
  });

  type FlakeStreakRecord = {
    active: boolean;
    recurringCount: number;
    signature: string | null;
    weeks: string[];
    ranAt: string;
    runUrl: string;
  };
  const toFlakeStreakRecord = (d: Record<string, unknown>): FlakeStreakRecord => ({
    active: d.active === true,
    recurringCount: typeof d.recurringCount === 'number' ? d.recurringCount : 0,
    signature: typeof d.signature === 'string' ? d.signature : null,
    weeks: Array.isArray(d.weeks) ? d.weeks.filter((w) => typeof w === 'string') : [],
    ranAt: typeof d.ranAt === 'string' ? d.ranAt : '',
    runUrl: typeof d.runUrl === 'string' ? d.runUrl : '',
  });

  let verifyLive: VerifyRecord | null = null;
  // Sticky Gemini-credits marker: survives later non-external runs so the
  // /status page can show when the billing outage last hit.
  let lastExternal: VerifyRecord | null = null;
  // Current recurring-flake streak, written by the weekly mic-regression
  // escalation step (deploy_status/flake_streak).
  let flakeStreak: FlakeStreakRecord | null = null;

  const db = getAdminDb();
  if (db) {
    try {
      const snap = await db.collection('deploy_status').doc('verify_live').get();
      if (snap.exists) verifyLive = toVerifyRecord(snap.data() ?? {});
      const externalSnap = await db.collection('deploy_status').doc('last_external').get();
      if (externalSnap.exists) lastExternal = toVerifyRecord(externalSnap.data() ?? {});
      const flakeSnap = await db.collection('deploy_status').doc('flake_streak').get();
      if (flakeSnap.exists) flakeStreak = toFlakeStreakRecord(flakeSnap.data() ?? {});
    } catch {
      // The status page degrades gracefully — build facts still show even if
      // the verify record can't be read (e.g. emulator mode without one).
      verifyLive = null;
      lastExternal = null;
      flakeStreak = null;
    }
  }

  // Genuine regression check: a failure with reason=null that did NOT come
  // from a drill dispatch is a real regression — the no-mask rule only
  // applies to drill runs where a co-occurring failure is expected.
  const isGenuineRegression =
    verifyLive?.verdict === 'failure' &&
    verifyLive?.reason === null &&
    verifyLive?.source === null;

  return NextResponse.json({
    commitSha: process.env.NEXT_PUBLIC_APP_COMMIT_SHA ?? '',
    builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT ?? '',
    emulator: !!process.env.FIRESTORE_EMULATOR_HOST,
    verifyLive,
    lastExternal,
    flakeStreak,
    isGenuineRegression,
  });
}
