# App Check production rollout runbook

This runbook applies only to Cook With Freebuff. It covers the App Check gate
on `/api/agent`, `/api/cook`, `/api/tools`, `/api/vision/scan`, and
`/api/voice/token`. Never record service-account JSON, reCAPTCHA secret keys,
debug tokens, or local environment values in this repository or in an incident
report.

## Prerequisites

1. In Firebase Console, select the web app whose public app ID matches
   `NEXT_PUBLIC_FIREBASE_APP_ID` in `apphosting.yaml`.
2. Register that web app with Firebase App Check using a reCAPTCHA v3 site key
   and confirm the Firebase App Check API is enabled for the project.
3. Provision `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` in App Hosting Secret
   Manager. `apphosting.yaml` requires it during both BUILD and RUNTIME; do not
   commit the value. A typical operator command is
   `npx -y firebase-tools@latest apphosting:secrets:set NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY`.
4. Confirm the deployed `FIREBASE_SERVICE_ACCOUNT` can verify App Check tokens.
   The account used by `verify:live` must also be allowed to mint App Check
   tokens (Firebase App Check Admin or the narrower token-exchange permission).
5. Configure the GitHub Actions secrets used by the deployment proof:
   `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_APP_ID`,
   `FIREBASE_SERVICE_ACCOUNT`, `APP_OWNER_UID`, and `GOOGLE_AI_API_KEY`.
6. Confirm the client build includes the site key and sends
   `X-Firebase-AppCheck` on every quota-bearing request before enabling hard
   rejection in a new environment.

## Monitor observation

For a new environment, temporarily deploy with `APP_CHECK_ENFORCED=0`. Monitor
mode verifies tokens that are present and records failures without rejecting
traffic. Exercise all five quota routes from the browser and inspect structured
logs for:

- `app-check.verify-failed` — malformed, expired, or otherwise invalid tokens;
- `app-check.app-mismatch` — a token minted for a different Firebase web app;
- `app-check.replay` — reuse of a token on a single-use route;
- `app-check.unconfigured` — a missing app ID, site key, or Admin credential.

Do not activate enforcement until normal browser traffic is attested, the two
single-use routes receive fresh tokens, and there is no unexplained sustained
failure volume. An unattested request being accepted is expected only during
this observation window.

## Activation

1. Set the App Hosting runtime variable to `APP_CHECK_ENFORCED=1` (the committed
   production configuration already pins this value).
2. Deploy the revision and wait until `/api/build-info` reports its commit.
3. Run `npm run verify:live -- --require-app-check-enforced` with the approved
   CI credentials.
4. Require both proof paths to pass: the owner request without attestation is
   rejected with HTTP 403 `APP_CHECK_FAILED`, and the same authenticated
   read-only request with a minted App Check token succeeds with HTTP 200.
5. Confirm `/api/voice/token` and each `/api/vision/scan` probe mint independent
   tokens; a cached token must never be reused after single-use consumption.

Activation is incomplete if the negative probe is accepted, the positive probe
is rejected, token minting is skipped, or CI runs without the enforcement flag.

## Rollback

If legitimate production clients are being blocked, set
`APP_CHECK_ENFORCED=0` and redeploy the smallest configuration-only revision.
This restores monitor mode while continuing to verify and log tokens that are
present. Keep the site-key secret, route gates, and diagnostic logging in place.

A rollback may relax only App Check rejection. It must not weaken authentication, Firestore rules, write validation, or audit logging. The enforcement-required
CI proof should remain red during the rollback so the degraded protection stays
visible; record the incident, correct the prerequisite, and reactivate with the
full negative-and-positive proof.

## Failure diagnosis

| Signal | Likely cause | Action |
| --- | --- | --- |
| `App Check token missing` | Browser build has no site key, request helper omitted the header, or a stale client is running | Verify the App Hosting secret and deployed build, then inspect the request header |
| `App Check token invalid` / `app-check.verify-failed` | Malformed, expired, or untrusted token | Confirm the Firebase web-app registration and force the client to refresh its token |
| `App Check token is for a different app` | `NEXT_PUBLIC_FIREBASE_APP_ID` and the token's app do not match | Compare the public app ID in App Hosting, Firebase Console, and GitHub Actions |
| `App Check enforcement is not configured` | App ID, site key, or Admin credential is absent | Use the readiness warning's `missing` field and restore only the named prerequisite |
| `App Check token has already been consumed` / `app-check.replay` | A cached token was reused on voice-token or vision-scan | Mint a fresh token for every single-use request; do not retry with the consumed token |
| Driver cannot mint an App Check token | App Check API disabled or CI service account lacks token-mint permission | Enable the API and grant the minimum required App Check role, then rerun |
| Unattested probe returns 200 | Enforcement flag is not live on the deployed revision | Confirm the deployed commit and `APP_CHECK_ENFORCED=1`; do not accept the release |
| Attested probe returns 403 | Wrong app ID, invalid minted token, or server readiness failure | Read the structured reason/log event and correct that prerequisite before retrying |

