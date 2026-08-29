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

  it('reads the sticky last_external doc so a later green run cannot erase the outage', () => {
    // The single-slot verify_live doc is overwritten every run; the last
    // Gemini-credits outage lives in its own doc that success/failure never
    // writes, so the page can show the recurrence pattern.
    expect(ROUTE).toContain("collection('deploy_status').doc('last_external')");
    expect(ROUTE).toContain('lastExternal');
  });

  it('reads the flake_streak doc so infra flakes get the same at-a-glance visibility', () => {
    // The weekly escalation step records the active recurring-flake streak to
    // its own doc; the route reads and returns it alongside the credits
    // outage, sanitizing each field the way it does the verify record.
    expect(ROUTE).toContain("collection('deploy_status').doc('flake_streak')");
    expect(ROUTE).toContain('flakeStreak');
    expect(ROUTE).toContain('toFlakeStreakRecord');
  });

  it('maps the optional spared-live-session reason through to the payload', () => {
    // The recorder can persist a reason (drill / overlap spared-live-session
    // failure); the route must pass it through sanitized so the page can label
    // it instead of showing a bare failure.
    expect(ROUTE).toContain('reason: typeof d.reason === \'string\' ? d.reason : null');
    expect(ROUTE).toContain('reason: string | null');
  });

  it('maps the optional dispatch source tag through to the payload', () => {
    // The recorder persists a source tag ('spare-drill', 'boundary-drill',
    // 'regression-drill') on drill runs; the route passes it through so the
    // status page can distinguish drill no-mask proofs from genuine
    // regressions when verdict=failure and reason=null.
    expect(ROUTE).toContain('source: typeof d.source === \'string\' ? d.source : null');
    expect(ROUTE).toContain('source: string | null');
  });

  it('computes isGenuineRegression when failure has no drill source', () => {
    // A reason=null failure WITHOUT a source tag is a genuine regression —
    // the no-mask rule only applies to drill runs where a co-occurring
    // failure is expected. The flag is derived from the doc fields, not
    // a separate query, so it stays in lockstep with the recorded data.
    expect(ROUTE).toContain('isGenuineRegression');
    expect(ROUTE).toContain("verdict === 'failure'");
    expect(ROUTE).toContain('reason === null');
    expect(ROUTE).toContain('source === null');
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
    expect(PAGE).toContain("'⚠ External'");
    expect(PAGE).toContain("'No run recorded yet'");
  });

  it('labels a spared-live-session failure as intentional instead of a bare failure', () => {
    // The guard-spare drill recorded verdict failure with reason
    // spared-live-session — the page must label it as an intentional drill /
    // overlapping-run collision, not claim a regression. The reason value
    // comes from the shared SPARED_LIVE_REASON constant (single source of
    // truth with the classifier + recorder), never a page-local literal.
    expect(PAGE).toContain("from '../../scripts/verify-live-classify.mjs'");
    expect(PAGE).toContain('  SPARED_LIVE_REASON,');
    expect(PAGE).toContain('isSpared = status?.verifyLive?.reason === SPARED_LIVE_REASON');
    expect(PAGE).toContain("'✗ Failing — spared live session (intentional)'");
    expect(PAGE).toContain("'Spared a live session — drill/overlap, not a regression'");
    expect(PAGE).toContain('isSpared');
  });

  it('shows when the last Gemini-credits outage occurred (sticky across later green runs)', () => {
    expect(PAGE).toContain('Last Gemini-credits outage');
    expect(PAGE).toContain('No Gemini-credits outage recorded yet.');
    expect(PAGE).toContain('lastExternal');
  });

  it('shows the recurring-flake streak card next to the Gemini-credits outage', () => {
    expect(PAGE).toContain('Recurring infra flakes');
    expect(PAGE).toContain('No recurring infra flake right now.');
    expect(PAGE).toContain('flakeStreak');
    expect(PAGE).toContain('recurringCount');
    expect(PAGE).toContain('week streak');
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
    // The prompt is rendered through the shared shadcn Button on the sign-in card.
    expect(PAGE).toContain("import { Button } from '@/components/ui/button'");
  });

  it('hides the status cards while signed out (no Loading… dead state)', () => {
    // The cards section is gated on a signed-in user — a signed-out visitor
    // sees only the sign-in prompt, never an unconditional Loading… row.
    expect(PAGE).toContain("auth.state === 'ready' && auth.user && (");
    expect(PAGE).toContain('aria-label="App status"');
  });

  it('renders the auth initialization error state honestly', () => {
    expect(PAGE).toContain("auth.state === 'error'");
    expect(PAGE).toContain('Sign in is unavailable right now');
    expect(PAGE).toContain('{auth.error ?? \'Authentication could not initialize.\'}');
  });

  it('surfaces a rejected Google sign-in instead of swallowing it', () => {
    expect(PAGE).toContain('setSignInError');
    expect(PAGE).toContain('e instanceof Error ? e.message : \'Sign in failed. Try again.\'');
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

  it('only accepts success|failure|external and fails loudly otherwise', () => {
    // 'external' is the Gemini credits block: the deploy check passed but
    // recipe generation could not run — the /status page renders it distinctly.
    // The three values derive from the shared VERDICT_* constants — never
    // local literals — so a renamed verdict fails the classifier→recorder→page
    // chain in lockstep (cross-file codegen contract in
    // verify-live-classify.test.ts).
    expect(RECORDER).toContain('verdict !== VERDICT_SUCCESS && verdict !== VERDICT_FAILURE && verdict !== VERDICT_EXTERNAL');
    expect(RECORDER).toContain("verdict must be success|failure|external");
    expect(RECORDER).toContain('z.enum([VERDICT_SUCCESS, VERDICT_FAILURE, VERDICT_EXTERNAL]');
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

  it('pins the last external run to its own doc — only when the verdict is external', () => {
    // The sticky doc must be written ONLY on 'external'; a success/failure run
    // leaves it untouched so the last credits outage survives later green runs.
    expect(RECORDER).toContain('if (verdict === VERDICT_EXTERNAL)');
    expect(RECORDER).toContain("collection('deploy_status').doc('last_external')");
  });

  it('accepts an optional reason and persists it only when valid', () => {
    // --reason is OPTIONAL: an empty/absent value must not persist a stale
    // reason field, and an unknown reason must be rejected by the schema so a
    // typo can never label a real failure as intentional. The enum derives
    // from the shared SPARED_LIVE_REASON constant — never a local literal.
    expect(RECORDER).toContain("from './verify-live-classify.mjs'");
    expect(RECORDER).toContain('  SPARED_LIVE_REASON,');
    expect(RECORDER).toContain("const reason = flag('--reason', process.env.VERIFY_REASON ?? '');");
    expect(RECORDER).toContain('...(reason ? { reason } : {})');
    expect(RECORDER).toContain('z.enum([SPARED_LIVE_REASON]).optional()');
  });
});
