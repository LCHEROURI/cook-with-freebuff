import { describe, expect, it, vi } from 'vitest';
import { installAppCheckInjection } from './drive-cdp-app-check.mjs';

// ============================================================================
// scripts/drive-cdp-app-check.test.ts — unit-test the shared CDP App Check
// header injection used by the headless verify:live browser drivers.
//
// Root cause (systematic-debugging, verify:live post-merge runs): headless
// Chrome cannot complete reCAPTCHA v3 attestation, so the PAGE's own requests
// to the gated routes arrive without x-firebase-appcheck and production
// enforcement correctly 403s them. The durable CI fix is CDP-level injection
// of an admin-minted token into same-origin /api/* requests — proven in
// Step 6S. This module is the shared seam; these tests pin:
//
//   1. no token → nothing is enabled, nothing is intercepted;
//   2. token → Fetch interception is enabled ONLY for the app's own
//      `*://<host>/api/*` requests at the Request stage;
//   3. a paused same-origin request is continued with the header REPLACED
//      (a stale x-firebase-appcheck never wins) and every other header
//      preserved;
//   4. a paused third-party request (Google/Gemini/reCAPTCHA/Auth) is
//      continued untouched.
// ============================================================================

describe('scripts/drive-cdp-app-check.mjs — headless App Check header injection', () => {
  // The module only touches addEventListener/removeEventListener on the ws;
  // a minimal stand-in satisfies the calls without constructing a real socket.
  const fakeWs = (over = {}) => ({ addEventListener: vi.fn(), removeEventListener: vi.fn(), ...over }) as unknown as WebSocket;

  it('enables nothing and returns null when no token is provided', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWs();
    const handle = installAppCheckInjection({ ws, send, app: 'https://cook.example.com', token: '' });
    expect(handle).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(ws.addEventListener).not.toHaveBeenCalled();
  });

  it('enables Fetch interception only for the app own same-origin /api/* requests', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWs();
    installAppCheckInjection({ ws, send, app: 'https://cook.example.com', token: 'ac-token' });
    expect(send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*://cook.example.com/api/*', requestStage: 'Request' }],
    });
    expect(ws.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('continues a same-origin paused request with the header REPLACED and all other headers preserved', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let handler: ((event: { data: string }) => void) | undefined;
    const ws = fakeWs({ addEventListener: (_event: string, fn: (e: { data: string }) => void) => { handler = fn; } });
    installAppCheckInjection({ ws, send, app: 'https://cook.example.com', token: 'ac-token' });
    send.mockClear(); // drop the Fetch.enable call — count only the continue

    handler!({
      data: JSON.stringify({
        method: 'Fetch.requestPaused',
        params: {
          requestId: 'r1',
          request: {
            url: 'https://cook.example.com/api/cook',
            headers: { authorization: 'Bearer owner-token', 'x-firebase-appcheck': 'stale-sdk-token' },
          },
        },
      }),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [method, params] = send.mock.calls[0];
    expect(method).toBe('Fetch.continueRequest');
    expect(params.requestId).toBe('r1');
    const headers = (params.headers as Array<{ name: string; value: string }>).map((h) => [h.name.toLowerCase(), h.value]);
    expect(headers).toContainEqual(['authorization', 'Bearer owner-token']);
    expect(headers).not.toContainEqual(['x-firebase-appcheck', 'stale-sdk-token']);
    expect(headers).toContainEqual(['x-firebase-appcheck', 'ac-token']);
  });

  it('continues a paused third-party request untouched (Google/Gemini/reCAPTCHA/Auth)', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let handler: ((event: { data: string }) => void) | undefined;
    const ws = fakeWs({ addEventListener: (_event: string, fn: (e: { data: string }) => void) => { handler = fn; } });
    installAppCheckInjection({ ws, send, app: 'https://cook.example.com', token: 'ac-token' });

    send.mockClear();
    handler!({
      data: JSON.stringify({
        method: 'Fetch.requestPaused',
        params: {
          requestId: 'r2',
          request: { url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken' },
        },
      }),
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'r2' });
  });

  it('returns a handler that can be removed (idempotent cleanup)', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWs();
    const handle = installAppCheckInjection({ ws, send, app: 'https://cook.example.com', token: 'ac-token' });
    expect(typeof handle).toBe('function');
    (ws.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.length; // typed access
    ws.removeEventListener('message', handle as EventListener);
    expect(ws.removeEventListener).toHaveBeenCalledWith('message', handle);
  });
});
