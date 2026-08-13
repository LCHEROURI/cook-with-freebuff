'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';

interface VerifyLive {
  verdict: string;
  commitSha: string;
  ranAt: string;
  runUrl: string;
}

interface Status {
  commitSha: string;
  builtAt: string;
  emulator: boolean;
  verifyLive: VerifyLive | null;
}

const shortSha = (sha: string) => (sha ? sha.slice(0, 7) : 'unknown');
const commitUrl = (sha: string) => `https://github.com/LCHEROURI/cook-with-freebuff/commit/${sha}`;
const formatTime = (iso: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [denied, setDenied] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
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
    try {
      await auth.signIn();
    } finally {
      setSigningIn(false);
    }
  };

  const verdictClass =
    status?.verifyLive?.verdict === 'success'
      ? styles.pass
      : status?.verifyLive?.verdict === 'failure'
        ? styles.fail
        : styles.unknown;

  const verdictLabel =
    status?.verifyLive?.verdict === 'success'
      ? '✓ Passing'
      : status?.verifyLive?.verdict === 'failure'
        ? '✗ Failing'
        : 'No run recorded yet';

  return (
    <main className={styles.main}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Cook With Me</span>
        <Link href="/" className={styles.backLink}>
          ← Back to start
        </Link>
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

      {auth.state === 'ready' && !auth.user && (
        <section className={styles.cards} aria-label="Sign in required">
          <article className={styles.card}>
            <h2 className={styles.cardTitle}>Sign in to see kitchen status</h2>
            <p className={styles.cardMeta}>
              The status surface is private — sign in with Google to see the
              live commit, build time, and the last verify:live result.
            </p>
            <button
              type="button"
              className={styles.signInButton}
              onClick={() => void handleSignIn()}
              disabled={signingIn}
            >
              {signingIn ? 'Signing in…' : 'Sign in with Google'}
            </button>
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
          <h2 className={styles.cardTitle}>Last verify:live</h2>
          {status ? (
            status.verifyLive ? (
              <>
                <p className={`${styles.verdict} ${verdictClass}`}>{verdictLabel}</p>
                <p className={styles.cardMeta}>
                  {status.verifyLive.verdict === 'success' ? 'Verified' : 'Last failed'} on{' '}
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
