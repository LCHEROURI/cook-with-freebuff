import Link from 'next/link';

// Human-readable twin of /api/version — same pattern as the car app's
// /status page (portfolio-app-freebuff repo), at /version here because
// cook's /status is the auth-gated owner operations dashboard. Server-
// rendered per request so the self-check always reflects the build that
// is actually serving.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Build provenance',
};

type CheckState = 'pass' | 'warn' | 'fail';

const RAW_COMMIT = process.env.NEXT_PUBLIC_COMMIT_SHA ?? '';
const ROLLOUT_ID = process.env.NEXT_PUBLIC_ROLLOUT_ID || null;
const DEPLOYED_AT = process.env.NEXT_PUBLIC_DEPLOYED_AT || null;
const COMMIT = RAW_COMMIT ? RAW_COMMIT.slice(0, 7) : null;
// Same rule as the API route: nulls mean "built without the deploy script".
const HAS_PROVENANCE = Boolean(COMMIT && ROLLOUT_ID && DEPLOYED_AT);

function prettyDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // NB: Intl throws a TypeError when dateStyle/timeStyle are combined with
  // timeZoneName, so the zone is appended manually.
  return `${d.toLocaleString('en-US', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  })} UTC`;
}

const STATE_STYLES: Record<CheckState, { badge: string; icon: string; label: string }> = {
  pass: { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: '✓', label: 'Pass' },
  warn: { badge: 'bg-amber-50 text-amber-700 ring-amber-200', icon: '!', label: 'Warning' },
  fail: { badge: 'bg-red-50 text-red-700 ring-red-200', icon: '✗', label: 'Fail' },
};

function CheckRow({
  state,
  title,
  detail,
}: {
  state: CheckState;
  title: string;
  detail: string;
}) {
  const s = STATE_STYLES[state];
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-1 ${s.badge}`}
        aria-label={s.label}
      >
        {s.icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-900">{title}</p>
        <p className="mt-0.5 break-words text-sm text-stone-600">{detail}</p>
      </div>
    </li>
  );
}

async function selfCheckVersion(origin: string): Promise<{
  state: CheckState;
  title: string;
  detail: string;
}> {
  const title = 'Version endpoint answers (self-check via loopback)';
  try {
    const res = await fetch(`${origin}/api/version`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { state: 'fail', title, detail: `GET /api/version returned HTTP ${res.status}.` };
    }
    const body = (await res.json()) as {
      service?: string;
      commit?: string | null;
      commitFull?: string | null;
      rolloutId?: string | null;
      deployedAt?: string | null;
    };
    if (!body.commit) {
      // Expected on a local dev build (no deploy script) — a warning, not a
      // failure; the provenance row above already flags the missing metadata.
      return {
        state: 'warn',
        title,
        detail:
          'The endpoint answered but reports no commit — this server was built without deploy provenance. Expected on a local dev build, never in production.',
      };
    }
    const matchesBuild = body.commitFull === RAW_COMMIT && body.rolloutId === ROLLOUT_ID;
    return {
      state: matchesBuild ? 'pass' : 'warn',
      title,
      detail: matchesBuild
        ? `GET /api/version → HTTP 200, self-reports commit ${body.commit} (${body.rolloutId}) — matches this build exactly.`
        : `GET /api/version → HTTP 200 but reports commit ${body.commit ?? '?'} (${body.rolloutId ?? '?'}), which does not match this page's build — mixed serving versions.`,
    };
  } catch (err) {
    return {
      state: 'fail',
      title,
      detail: `GET /api/version failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export default async function VersionPage() {
  // Self-check over LOOPBACK, not the public URL: the App Hosting edge
  // 403s the runtime's own requests to its public hostname (verified in
  // production on the car app), while external reachability of that
  // hostname is what the scheduled CI probes already prove. The loopback
  // fetch isolates what this page can attest to: the app layer of THIS
  // process answers and self-reports its provenance.
  const port = process.env.PORT ?? '3000';
  const origin = `http://127.0.0.1:${port}`;
  const versionCheck = await selfCheckVersion(origin);

  const checks: { state: CheckState; title: string; detail: string }[] = [
    {
      state: HAS_PROVENANCE ? 'pass' : 'warn',
      title: 'Build provenance present',
      detail: HAS_PROVENANCE
        ? `This build carries its commit (${COMMIT}), rollout (${ROLLOUT_ID}), and deploy time.`
        : 'This server was built without the deploy script — no commit/rollout metadata is baked in. Expected on a local dev build, never in production.',
    },
    versionCheck,
  ];
  const allPass = checks.every((c) => c.state === 'pass');
  const anyFail = checks.some((c) => c.state === 'fail');

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="sticky top-0 z-30 w-full border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm font-semibold text-stone-900">
            Kitchen Agent
          </Link>
          <Link
            href="/"
            className="rounded-lg px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50"
          >
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 pt-10 pb-24 sm:px-6 sm:pt-14 lg:px-8">
        <div className="mb-8 flex flex-wrap items-center gap-4">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold ring-1 ${
              anyFail
                ? 'bg-red-50 text-red-700 ring-red-200'
                : allPass
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : 'bg-amber-50 text-amber-700 ring-amber-200'
            }`}
          >
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                anyFail ? 'bg-red-600' : allPass ? 'bg-emerald-600' : 'bg-amber-600'
              }`}
            />
            {anyFail ? 'Degraded' : allPass ? 'All checks passed' : 'Healthy with warnings'}
          </span>
          <p className="text-sm text-stone-600">
            {anyFail
              ? 'Serving is impaired — the failing check below says what is wrong.'
              : allPass
                ? 'This deployment is serving normally and self-reports its provenance.'
                : 'Serving normally; the warnings below are expected only on local dev builds.'}
          </p>
        </div>

        <section className="mb-8 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-bold text-stone-900">Build provenance</h1>
          <p className="mt-1 text-sm text-stone-600">
            What is deployed right now. The same values as{' '}
            <code className="rounded bg-stone-100 px-1.5 py-0.5 text-xs">GET /api/version</code>, in
            human form. For the owner operations dashboard (verify-live verdicts, flake streaks),
            see the signed-in <Link href="/status" className="text-amber-700 underline underline-offset-2">/status</Link> page.
          </p>
          <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">Service</dt>
              <dd className="mt-1 text-sm font-semibold text-stone-900">cook-with-freebuff</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">Commit</dt>
              <dd className="mt-1 text-sm font-semibold text-stone-900">
                {COMMIT ? (
                  <a
                    href={`https://github.com/LCHEROURI/cook-with-freebuff/commit/${RAW_COMMIT}`}
                    className="text-amber-700 underline decoration-amber-200 underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {COMMIT}
                  </a>
                ) : (
                  <span className="text-amber-700">not baked (dev build)</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">
                Firebase rollout
              </dt>
              <dd className="mt-1 text-sm font-semibold text-stone-900">
                {ROLLOUT_ID ?? <span className="text-amber-700">not baked (dev build)</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">
                Deployed at
              </dt>
              <dd className="mt-1 text-sm font-semibold text-stone-900">
                {prettyDate(DEPLOYED_AT)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-xl font-bold text-stone-900">Live self-check</h2>
          <p className="mt-1 text-sm text-stone-600">
            Run at page load against this very server — not cached, so a refresh re-tests.
          </p>
          <ul className="mt-3 divide-y divide-stone-100">
            {checks.map((c) => (
              <CheckRow key={c.title} state={c.state} title={c.title} detail={c.detail} />
            ))}
          </ul>
          <p className="mt-4 border-t border-stone-100 pt-4 text-xs leading-relaxed text-stone-500">
            Continuous monitoring runs separately: cook&apos;s CI deploys and verifies every push,
            and the scheduled probes (deploy-health, compare-live) exercise the live host weekly.
            This page is the point-in-time, human-readable view.
          </p>
        </section>
      </main>
    </div>
  );
}
