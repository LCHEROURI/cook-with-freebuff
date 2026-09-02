import { NextResponse } from 'next/server';

// Build provenance, machine-readable — identical shape to the car app's
// /api/version (portfolio-app-freebuff repo) so both apps report the same
// JSON. Values are baked at BUILD time: the deploy script writes
// NEXT_PUBLIC_COMMIT_SHA / NEXT_PUBLIC_ROLLOUT_ID / NEXT_PUBLIC_DEPLOYED_AT
// into .env.production before uploading the source, and Next.js inlines
// NEXT_PUBLIC_* during App Hosting's cloud build — so these read as
// constants per build. Nulls mean "local dev build without the deploy
// script". The existing /api/build-info endpoint stays untouched: its
// commitSha path (commit-sha.txt + NEXT_PUBLIC_APP_COMMIT_SHA) is what the
// deployed-hash gate reads.
export const dynamic = 'force-dynamic';

const RAW_COMMIT = process.env.NEXT_PUBLIC_COMMIT_SHA ?? '';
const ROLLOUT_ID = process.env.NEXT_PUBLIC_ROLLOUT_ID || null;
const DEPLOYED_AT = process.env.NEXT_PUBLIC_DEPLOYED_AT || null;

export function GET() {
  return NextResponse.json(
    {
      service: 'cook-with-freebuff',
      commit: RAW_COMMIT ? RAW_COMMIT.slice(0, 7) : null,
      commitFull: RAW_COMMIT || null,
      rolloutId: ROLLOUT_ID,
      deployedAt: DEPLOYED_AT,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
