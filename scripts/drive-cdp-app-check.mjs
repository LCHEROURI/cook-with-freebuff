// ============================================================================
// scripts/drive-cdp-app-check.mjs — inject an admin-minted App Check token
// into the headless driver browser's same-origin /api/* requests via CDP
// Fetch interception.
//
// Headless Chrome cannot complete reCAPTCHA v3 attestation, so a page whose
// OWN client code calls the gated routes (the /cook starter's create_recipe,
// the live-voice token mint) is 403'd by production enforcement even though
// the driver's fetch-based checks attest fine. The post-deploy verify:live
// drivers solve this the way Step 6S proved: verify-live.mjs mints a short-
// lived admin App Check token and hands it to the drivers via
// VERIFY_APP_CHECK_TOKEN; the driver arms this interception so the page's
// requests carry it — at the CDP level, never touching app code.
//
// Only same-origin /api/* HTTP(S) requests are intercepted; third-party
// origins (Google, Gemini, reCAPTCHA, Firebase Auth) and WebSockets pass
// through untouched. Any existing x-firebase-appcheck header on an
// intercepted request is REPLACED — a stale SDK token must never win over
// the admin token.
// ============================================================================

/**
 * Arm CDP Fetch interception that adds the admin App Check token to the
 * driver browser's same-origin /api/* requests.
 *
 * @param {{ ws: WebSocket, send: (method: string, params?: object) => Promise<unknown>, app: string, token: string, note?: (m: string) => void }} opts
 * @returns {((event: MessageEvent) => void) | null} the installed message
 *   handler (for cleanup), or null when no token was supplied.
 */
export function installAppCheckInjection({ ws, send, app, token, note = () => {} }) {
  if (!token) return null;
  let host;
  try {
    host = new URL(app).host;
  } catch {
    return null;
  }

  send('Fetch.enable', {
    patterns: [{ urlPattern: `*://${host}/api/*`, requestStage: 'Request' }],
  }).catch(() => {});

  const handler = (event) => {
    let m;
    try {
      m = JSON.parse(event.data);
    } catch {
      return;
    }
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params ?? {};
    if (!requestId) return;
    const url = request?.url ?? '';
    if (url.startsWith(`${app}/api/`)) {
      // continueRequest replaces the ENTIRE header set — re-send every
      // existing header (minus any stale appcheck) plus the admin token.
      const headers = Object.entries(request.headers ?? {})
        .filter(([name]) => name.toLowerCase() !== 'x-firebase-appcheck')
        .map(([name, value]) => ({ name, value }));
      headers.push({ name: 'X-Firebase-AppCheck', value: token });
      send('Fetch.continueRequest', { requestId, headers }).catch(() => {});
    } else {
      send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  };
  ws.addEventListener('message', handler);
  note('App Check header injection armed (CDP Fetch interception, same-origin /api/*)');
  return handler;
}
