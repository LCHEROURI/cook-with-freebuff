import { NextResponse } from 'next/server';

// GET /api/build-info — expose the commit SHA this build was compiled from.
// The deployed-hash gate reads this on hosts that don't expose a git-commit
// lookup API (Firebase App Hosting), so the "what commit is live" question
// has one answer no matter where the app is deployed. Public by design: a
// commit SHA carries no secrets.
export async function GET() {
  return NextResponse.json({
    commitSha: process.env.NEXT_PUBLIC_APP_COMMIT_SHA ?? '',
    builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT ?? '',
  });
}
