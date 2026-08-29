'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import { Button } from '@/components/ui/button';
import {
  SPARED_LIVE_REASON,
  VERDICT_EXTERNAL,
  VERDICT_FAILURE,
  VERDICT_SUCCESS,
} from '../../scripts/verify-live-classify.mjs';

interface VerifyLive {
  verdict: string;
  commitSha: string;
  ranAt: string;
  runUrl: string;
  reason: string | null;
}

interface FlakeStreak {
  active: boolean;
  recurringCount: number;
  signature: string | null;
  weeks: string[];
  ranAt: string;
  runUrl: string;
}

interface Status {
  commitSha: string;
  builtAt: string;
  emulator: boolean;
  verifyLive: VerifyLive | null;
  lastExternal: VerifyLive | null;
  flakeStreak: FlakeStreak | null;
}

const shortSha = (sha: string) => (sha ? sha.slice(0, 7) : 'unknown');
const commitUrl = (sha: string) => `https://github.com/LCHEROURI/cook-with-freebuff/commit/${sha}`;
const formatTime = (iso: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [denied, setDenied] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const auth = useAuthSession();
  const getToken = auth.getToken;

  useEffect(() => {
    // The route requires a valid token outright — never fetch signed out.
    if (auth.state !== 'ready' || !auth.user) return;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch('/api/status', { headers });
      if (res.status === 401) {
        if (!cancelled) setDenied(true);
        return;
      }
      const body = (await res.json()) as Status;
      if (!cancelled) {
        setStatus(body);
        setDenied(false);
      }
    })().catch(() => {
      if (!cancelled) setStatus(null);
    });
    return () => {
      cancelled = true;
    };
  }, [auth.state, auth.user, getToken]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      await auth.signIn();
    } catch (e) {
      // Rejected sign-in (popup closed, blocked, provider disabled): the
      // thrown message is already the mapped honest copy — surface it so the
      // failure is never silent.
      setSignInError(e instanceof Error ? e.message : 'Sign in failed. Try again.');
    } finally {
      setSigningIn(false);
    }
  };

  const isSpared = status?.verifyLive?.reason === SPARED_LIVE_REASON;
  const verdictClass =
    status?.verifyLive?.verdict === VERDICT_SUCCESS
      ? styles.pass
      : status?.verifyLive?.verdict === VERDICT_FAILURE
        ? isSpared
          ? styles.unknown
          : styles.fail
        : status?.verifyLive?.verdict === VERDICT_EXTERNAL
          ? styles.unknown
          : styles.unknown;

  const verdictLabel =
    status?.verifyLive?.verdict === VERDICT_SUCCESS
      ? '✓ Passing'
      : status?.verifyLive?.verdict === VERDICT_FAILURE
        ? isSpared
          ? '✗ Failing — spared live session (intentional)'
          : '✗ Failing'
        : status?.verifyLive?.verdict === VERDICT_EXTERNAL
          ? '⚠ External'
          : 'No run recorded yet';

  return (
    <main className={styles.main}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Cook With Me</span>
        <Button asChild variant="ghost" className="min-h-11 text-sm font-semibold text-brand hover:text-brand-hover">
          <Link href="/">← Back to start</Link>
        </Button>
      </header>

      <section className={styles.hero}>
        <h1 className={styles.title}>Kitchen status</h1>
        <p className={styles.heroMotif} aria-hidden="true">
          <span>🧑‍🍳</span>
          <span>🔥</span>
          <span>🌿</span>
        </p>
        <p className={styles.subtitle}>
          The live build, when it shipped, and whether the last full verification passed.
        </p>
      </section>

      {auth.state === 'error' && (
        <section className={styles.cards} aria-label="Sign in unavailable">
          <article className={styles.card}>
            <h2 className={styles.cardTitle}>Sign in is unavailable right now</h2>
            <p className={styles.cardMeta}>{auth.error ?? 'Authentication could not initialize.'}</p>
            <p className={styles.cardMeta}>
              Reload the page to try again. The status surface needs a signed-in
              session to load.
            </p>
          </article>
        </section>
      )}

      {auth.state === 'ready' && !auth.user && (
        <section className={styles.cards} aria-label="Sign in required">
          <article className={styles.card}>
            <h2 className={styles.cardTitle}>Sign in to see kitchen status</h2>
            <p className={styles.cardMeta}>
              The status surface is private — sign in with Google to see the
              live commit, build time, and the last verify:live result.
            </p>
            <Button
              type="button"
              className="mt-3 min-h-11 w-fit"
              onClick={() => void handleSignIn()}
              disabled={signingIn}
            >
              {signingIn ? 'Signing in…' : 'Sign in with Google'}
            </Button>
            {signInError && <p className={styles.cardMeta}>{signInError}</p>}
          </article>
        </section>
      )}

      {denied && (
        <section className={styles.cards} aria-label="Access denied">
          <article className={styles.card}>
            <h2 className={styles.cardTitle}>Could not load status</h2>
            <p className={styles.cardMeta}>
              The server rejected the request. Try signing out and back in, or
              reload the page.
            </p>
          </article>
        </section>
      )}

      {auth.state === 'ready' && auth.user && (
      <section className={styles.cards} aria-label="App status">
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Live commit</h2>
          {status ? (
            <>
              <p className={styles.mono}>
                <a href={commitUrl(status.commitSha)} className={styles.link}>
                  {shortSha(status.commitSha)}
                </a>
              </p>
              <p className={styles.cardMeta}>Built {formatTime(status.builtAt)}</p>
            </>
          ) : (
            <p className={styles.cardMeta}>Loading…</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Last Gemini-credits outage</h2>
          {status ? (
            status.lastExternal ? (
              <>
                <p className={`${styles.verdict} ${styles.unknown}`}>⚠ External</p>
                <p className={styles.cardMeta}>
                  {formatTime(status.lastExternal.ranAt)} ·{' '}
                  <a href={commitUrl(status.lastExternal.commitSha)} className={styles.link}>
                    {shortSha(status.lastExternal.commitSha)}
                  </a>
                </p>
                {status.lastExternal.runUrl && (
                  <p className={styles.cardMeta}>
                    <a href={status.lastExternal.runUrl} className={styles.link}>
                      View the CI run ↗
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p className={styles.cardMeta}>No Gemini-credits outage recorded yet.</p>
            )
          ) : (
            <p className={styles.cardMeta}>Loading…</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Recurring infra flakes</h2>
          {status ? (
            status.flakeStreak?.active ? (
              <>
                <p className={`${styles.verdict} ${styles.fail}`}>
                  {status.flakeStreak.recurringCount} recurring flake
                  {status.flakeStreak.recurringCount === 1 ? '' : 's'}
                </p>
                <p className={styles.mono}>{status.flakeStreak.signature ?? 'unknown signature'}</p>
                {status.flakeStreak.weeks.length > 0 && (
                  <p className={styles.cardMeta}>
                    {status.flakeStreak.weeks.length}-week streak ·{' '}
                    {status.flakeStreak.weeks[0]} →{' '}
                    {status.flakeStreak.weeks[status.flakeStreak.weeks.length - 1]}
                  </p>
                )}
                <p className={styles.cardMeta}>{formatTime(status.flakeStreak.ranAt)}</p>
                {status.flakeStreak.runUrl && (
                  <p className={styles.cardMeta}>
                    <a href={status.flakeStreak.runUrl} className={styles.link}>
                      View the CI run ↗
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p className={styles.cardMeta}>No recurring infra flake right now.</p>
            )
          ) : (
            <p className={styles.cardMeta}>Loading…</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Last verify:live</h2>
          {status ? (
            status.verifyLive ? (
              <>
                <p className={`${styles.verdict} ${verdictClass}`}>{verdictLabel}</p>
                <p className={styles.cardMeta}>
                  {status.verifyLive.verdict === VERDICT_SUCCESS
                    ? 'Verified'
                    : status.verifyLive.verdict === VERDICT_EXTERNAL
                      ? 'External issue (Gemini credits)'
                      : isSpared
                        ? 'Spared a live session — drill/overlap, not a regression'
                        : 'Last failed'}{' '}
                  <a href={commitUrl(status.verifyLive.commitSha)} className={styles.link}>
                    {shortSha(status.verifyLive.commitSha)}
                  </a>
                </p>
                <p className={styles.cardMeta}>{formatTime(status.verifyLive.ranAt)}</p>
                {status.verifyLive.runUrl && (
                  <p className={styles.cardMeta}>
                    <a href={status.verifyLive.runUrl} className={styles.link}>
                      View the CI run ↗
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p className={styles.cardMeta}>No verify:live result recorded yet.</p>
            )
          ) : (
            <p className={styles.cardMeta}>Loading…</p>
          )}
        </article>
      </section>
      )}

      <footer className={styles.footer}>
        <p>
          Cook With Me · the verify:live result updates after every deploy ·{' '}
          <a href="https://github.com/LCHEROURI/cook-with-freebuff" className={styles.link}>
            source
          </a>
        </p>
      </footer>
    </main>
  );
}
