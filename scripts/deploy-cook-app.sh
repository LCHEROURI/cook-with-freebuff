#!/usr/bin/env bash
# ============================================================================
# scripts/deploy-cook-app.sh — labeled Firebase App Hosting deploy for
# cook-with-freebuff (Kitchen Agent).
#
# Twin of the car app's scripts/deploy-car-app.sh (same mirrored CLI steps,
# same label/annotation scheme): `firebase deploy --only apphosting` creates
# rollouts with no commit metadata, so this performs the SAME steps the CLI
# performs internally (firebase-tools lib/deploy/apphosting + lib/gcp/
# apphosting):
#
#   1. compute the next build id (from BOTH builds and rollouts lists)
#   2. bake provenance into the source (.env.production + commit-sha.txt)
#   3. zip the repo root, honoring .gitignore; upload to the sources bucket
#   4. builds.create   — labeled with commit SHA, run URL
#   5. rollouts.create (validate-only, then real) — same labels
#   6. poll build + rollout operations to a terminal state
#
# Cook specifics vs the car app: the app IS the repo root (no subdirectory);
# commit-sha.txt is a TRACKED file that next.config.mjs reads so the existing
# /api/build-info endpoint keeps reporting the right SHA — it is refreshed
# transiently here and restored afterwards; and rollouts.create retries the
# one-rollout-at-a-time 409 like the CLI deploy path did.
#
# Result: every rollout in the Firebase Console history self-describes with
# the commit that produced it, and /api/version reports identical provenance
# JSON to the car app. Required env: GITHUB_SHA, RUN_URL, and auth
# (GOOGLE_APPLICATION_CREDENTIALS, or ambient gcloud ADC for local runs).
# Optional env: PROJECT/LOCATION/BACKEND/BUCKET, COMMIT_URL.
# ============================================================================
set -euo pipefail

PROJECT="${PROJECT:-portfolio-app-freebuff2}"
LOCATION="${LOCATION:-us-central1}"
BACKEND="${BACKEND:-cook-with-freebuff}"
BUCKET="${BUCKET:-firebaseapphosting-sources-952213217375-us-central1}"
API="https://firebaseapphosting.googleapis.com/v1beta"

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${RUN_URL:?RUN_URL is required}"

# ── 0. Auth ─────────────────────────────────────────────────────────────────
auth() { curl -sfS -m 60 -H "Authorization: Bearer $(gcloud auth print-access-token)" "$@"; }

# ── 1. Build id — same scheme as the CLI (build-YYYY-MM-DD-NNN). Computed
# FIRST so it can be baked into the app itself (/api/version reports it).
# The CLI derives the next suffix from BOTH the rollouts and builds lists;
# scanning builds alone collides with existing ids (400).
TODAY="$(date -u +%Y-%m-%d)"
LAST_ID="$( { auth "$API/projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/builds?pageSize=100"; \
              auth "$API/projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/rollouts?pageSize=100"; } \
  | jq -s -r --arg t "$TODAY" '[ .[] | (.builds[]?, .rollouts[]?) | select(.name | test("build-" + $t + "-(\\d+)$")) | .name | capture("-(?<n>[0-9]+)$").n | tonumber ] | max // 0')"
NEXT_N="$(printf '%03d' "$((LAST_ID + 1))")"
BUILD_ID="build-${TODAY}-${NEXT_N}"
echo "build id: $BUILD_ID"

# ── 2. Bake provenance into the source, then zip the repo root ─────────────
# App Hosting builds in the CLOUD from this archive; NEXT_PUBLIC_* values in
# .env.production are inlined by Next.js during that build (the runner env is
# long gone by then) — /api/version reports them. commit-sha.txt is tracked
# and read by next.config.mjs for the existing /api/build-info endpoint: it
# must carry THIS deploy's SHA or the deployed-hash gate would see a stale
# commit. Both files hold only public values; the upload honors .gitignore,
# and neither file is ignored.
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'NEXT_PUBLIC_COMMIT_SHA=%s\nNEXT_PUBLIC_ROLLOUT_ID=%s\nNEXT_PUBLIC_DEPLOYED_AT=%s\n' \
  "$GITHUB_SHA" "$BUILD_ID" "$DEPLOYED_AT" > .env.production

RESTORE_SHA_TXT=0
if [ -f commit-sha.txt ] && git ls-files --error-unmatch commit-sha.txt > /dev/null 2>&1; then
  cp commit-sha.txt /tmp/commit-sha.txt.bak
  RESTORE_SHA_TXT=1
fi
printf '%s\n' "$GITHUB_SHA" > commit-sha.txt

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ZIP="/tmp/cook-app-src-${STAMP}-${GITHUB_SHA::7}.zip"
# Zip exactly the TRACKED file list (+ the provenance env) instead of the
# whole directory: firebase-tools' own packaging honors .gitignore, and the
# repo root carries ~1.5 GB of ignored state (.freebuff/, node_modules,
# .next) that must never reach the upload. zip reads the refreshed on-disk
# commit-sha.txt, so the stamped SHA is what ships.
git ls-files -z | xargs -0 zip -q "$ZIP"
zip -q "$ZIP" .env.production
rm -f .env.production
if [ "$RESTORE_SHA_TXT" = "1" ]; then mv /tmp/commit-sha.txt.bak commit-sha.txt; fi
SIZE="$(du -h "$ZIP" | cut -f1 | tr -d ' ')"
echo "packaged source: $ZIP ($SIZE)"

# ── 3. Upload to the App Hosting sources bucket ─────────────────────────────
OBJECT="cook-with-freebuff--${STAMP}-${GITHUB_SHA::7}.zip"
echo "uploading to gs://$BUCKET/$OBJECT"
gcloud storage cp "$ZIP" "gs://$BUCKET/$OBJECT" --quiet
STORAGE_URI="gs://$BUCKET/$OBJECT"

cleanup() { rm -f "$ZIP"; }
trap cleanup EXIT

COMMIT_URL="${COMMIT_URL:-https://github.com/LCHEROURI/cook-with-freebuff/commit/$GITHUB_SHA}"

# POST with the body echoed on failure: -f would hide the API's error JSON.
post() { # $1=url, $2=body-file
  local http_body
  http_body="$(curl -sS -m 60 -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" -d "$2" "$1")"
  if [ "$(printf '%s' "$http_body" | tail -n1)" != "200" ]; then
    printf '%s\n' "$http_body" | sed '$d' >&2
    return 1
  fi
  printf '%s\n' "$http_body" | sed '$d'
}

# ── 4. builds.create — the labels ride on the build ────────────────────────
# Label VALUES only allow [a-z0-9-_] (the API rejects ':' and '/', so a URL
# can never be a label value). Annotations are the unrestricted key/value map
# for external-tool metadata — the run URL lives there; the label keeps a
# safe, scannable SHA.
BUILD_BODY="$(jq -n \
  --arg sha "$GITHUB_SHA" \
  --arg runurl "$RUN_URL" \
  --arg uri "$STORAGE_URI" \
  --arg desc "commit ${GITHUB_SHA::7}" \
  '{source: {archive: {userStorageUri: $uri, description: $desc}},
    labels: {"commit-sha": $sha},
    annotations: {"run-url": $runurl, "commit-sha": $sha}}')"
if ! post "$API/projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/builds?buildId=$BUILD_ID" "$BUILD_BODY" > /tmp/cook-build-op.json; then
  echo "builds.create failed" >&2
  exit 1
fi
echo "build operation: $(jq -r .name /tmp/cook-build-op.json)"

# ── 5. Rollout — validate-only first (the build name may not be visible yet;
#      retry), then the real create with the same 409 retry the CLI path had
#      (App Hosting accepts ONE rollout at a time). ──────────────────────────
ROLLOUT_BODY="$(jq -n --arg b "projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/builds/$BUILD_ID" \
  --arg sha "$GITHUB_SHA" --arg runurl "$RUN_URL" \
  '{build: $b,
    labels: {"commit-sha": $sha},
    annotations: {"run-url": $runurl, "commit-sha": $sha}}')"
TRIES=0
until [ "$TRIES" -ge 5 ]; do
  TRIES=$((TRIES + 1))
  if post "$API/projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/rollouts?rolloutId=$BUILD_ID&validateOnly=true" "$ROLLOUT_BODY" > /dev/null; then
    break
  fi
  echo "validate-only not ready (try $TRIES) — waiting 2s"
  sleep 2
done
if [ "$TRIES" -ge 5 ]; then
  echo "rollout validate-only kept failing after 5 tries" >&2
  exit 1
fi

ATTEMPT=1
MAX_ATTEMPTS=5
while true; do
  if post "$API/projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/rollouts?rolloutId=$BUILD_ID" "$ROLLOUT_BODY" > /tmp/cook-rollout-op.json; then
    echo "rollout accepted (attempt $ATTEMPT)"
    break
  fi
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    echo "rollouts.create still conflicting/failing after $MAX_ATTEMPTS attempts" >&2
    exit 1
  fi
  WAIT_S=$((ATTEMPT * 30))
  echo "::warning::rollout already in flight (409). Retrying in ${WAIT_S}s (attempt $ATTEMPT/$MAX_ATTEMPTS)..."
  sleep "$WAIT_S"
  ATTEMPT=$((ATTEMPT + 1))
done
echo "rollout operation: $(jq -r .name /tmp/cook-rollout-op.json)"

# ── 6. Poll build + rollout operations to a terminal state (≤ 20 min) ──────
poll_op() { # $1 = op file; echoes terminal state or fails after timeout
  local opfile="$1" name state
  for _ in $(seq 1 80); do
    name="$(jq -r .name "$opfile")"
    state="$(auth "$API/$name" | jq -r '.done // false' )"
    if [ "$state" = "true" ]; then
      auth "$API/$name" > /tmp/cook-op-final.json
      if [ "$(jq -r 'has("error")' /tmp/cook-op-final.json)" = "true" ]; then
        echo "operation FAILED: $(jq -c .error /tmp/cook-op-final.json)" >&2
        exit 1
      fi
      echo "operation done"
      return 0
    fi
    sleep 15
  done
  echo "operation timed out after 20 minutes" >&2
  exit 1
}
echo "polling build operation…"; poll_op /tmp/cook-build-op.json
echo "polling rollout operation…"; poll_op /tmp/cook-rollout-op.json

echo "✓ rollout $BUILD_ID deployed with labels commit-sha=${GITHUB_SHA::7} run-url=$RUN_URL"

# Expose the rollout to later workflow steps (the run summary prints it).
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "ROLLOUT_NAME=projects/$PROJECT/locations/$LOCATION/backends/$BACKEND/rollouts/$BUILD_ID" >> "$GITHUB_ENV"
  echo "ROLLOUT_CREATE=$DEPLOYED_AT" >> "$GITHUB_ENV"
fi
