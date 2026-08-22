import { describe, expect, it, vi } from 'vitest';
import {
  parseProductionPreflightOptions,
  verifyProductionPreflight,
} from './verify-real-data-preflight.mjs';

const EXPECTED_SHA = '33a36985723660f32a1445c8bc0c5c2cffd23b8c';
const PRODUCTION_APP = 'https://cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app';
const PREVIEW_APP = 'https://cook-with-freebuff--portfolio-app-freebuff2-preview.us-central1.hosted.app';
const UNRELATED_APP = 'https://cook-with-freebuff.example';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('verify:real-data production preflight', () => {
  describe('host-to-project binding', () => {
    it('rejects an unrelated --app host that does not reference the production project', () => {
      expect(() =>
        parseProductionPreflightOptions(
          ['--expected-sha', EXPECTED_SHA, '--app', UNRELATED_APP],
          {},
        ),
      ).toThrow(/Refusing preflight against an untrusted/);
    });

    it('rejects an unrelated VERIFY_BASE_URL that does not reference the production project', () => {
      expect(() =>
        parseProductionPreflightOptions(
          ['--expected-sha', EXPECTED_SHA],
          { VERIFY_BASE_URL: UNRELATED_APP },
        ),
      ).toThrow(/Refusing preflight against an untrusted/);
    });

    it('accepts the intended Cook production host', () => {
      expect(() =>
        parseProductionPreflightOptions(
          ['--expected-sha', EXPECTED_SHA, '--app', PRODUCTION_APP],
          {},
        ),
      ).not.toThrow();
    });

    it('accepts a preview-channel host bound to the same project', () => {
      expect(() =>
        parseProductionPreflightOptions(
          ['--expected-sha', EXPECTED_SHA, '--app', PREVIEW_APP],
          {},
        ),
      ).not.toThrow();
    });

    it('preserves trailing-slash stripping for bound hosts', () => {
      const opts = parseProductionPreflightOptions(
        ['--expected-sha', EXPECTED_SHA, '--app', `${PRODUCTION_APP}/`],
        {},
      );
      expect(opts.app).toBe(PRODUCTION_APP);
    });

    it('still enforces SHA length after host binding', () => {
      expect(() =>
        parseProductionPreflightOptions(
          ['--expected-sha', 'short', '--app', PRODUCTION_APP],
          {},
        ),
      ).toThrow('The expected production SHA must be a full 40-character Git commit SHA.');
    });

    describe('spoof resistance', () => {
      const SPOOFS = [
        'evil--portfolio-app-freebuff2.attacker.example',
        'attacker--portfolio-app-freebuff2.evil.com',
        'cook-with-freebuff--portfolio-app-freebuff2.us-central1.hosted.app.attacker.example',
        'portfolio-app-freebuff2.web.app.attacker.example',
        'portfolio-app-freebuff2.firebaseapp.com.attacker.example',
        'portfolio-app-freebuff2.attacker.example',
      ];

      for (const host of SPOOFS) {
        it(`rejects spoofed --app host: ${host}`, () => {
          expect(() =>
            parseProductionPreflightOptions(
              ['--expected-sha', EXPECTED_SHA, '--app', `https://${host}`],
              {},
            ),
          ).toThrow(/Refusing preflight against an untrusted/);
        });

        it(`rejects spoofed VERIFY_BASE_URL: ${host}`, () => {
          expect(() =>
            parseProductionPreflightOptions(
              ['--expected-sha', EXPECTED_SHA],
              { VERIFY_BASE_URL: `https://${host}` },
            ),
          ).toThrow(/Refusing preflight against an untrusted/);
        });
      }
    });
  });

  it('requires an explicit full deployment SHA', () => {
    expect(() => parseProductionPreflightOptions([], {})).toThrow(
      'Refusing real-data access without --expected-sha or VERIFY_EXPECTED_SHA.',
    );
    expect(() => parseProductionPreflightOptions(['--expected-sha', 'main'], {})).toThrow(
      'The expected production SHA must be a full 40-character Git commit SHA.',
    );
  });

  it('checks the exact deployed SHA before probing App Check enforcement', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
      commitSha: '7e5bd6a02d19d9b4497e4d4ce9c134581c7a2de4',
      emulator: false,
    }));

    await expect(verifyProductionPreflight({
      app: PRODUCTION_APP,
      expectedSha: EXPECTED_SHA,
      fetchImpl,
    })).rejects.toThrow(`Refusing stale production revision; expected ${EXPECTED_SHA}`);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${PRODUCTION_APP}/api/build-info`, expect.objectContaining({
      method: 'GET',
    }));
  });

  it('requires an unattested 403 APP_CHECK_FAILED before allowing writes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { commitSha: EXPECTED_SHA, emulator: false }))
      .mockResolvedValueOnce(jsonResponse(401, {
        success: false,
        error: { code: 'UNAUTHENTICATED' },
      }));

    await expect(verifyProductionPreflight({
      app: PRODUCTION_APP,
      expectedSha: EXPECTED_SHA,
      fetchImpl,
    })).rejects.toThrow('App Check production preflight failed; expected HTTP 403 APP_CHECK_FAILED.');

    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${PRODUCTION_APP}/api/cook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list_recipes' }),
    });
  });

  it('passes only after revision identity and App Check enforcement are both proven', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { commitSha: EXPECTED_SHA, emulator: false }))
      .mockResolvedValueOnce(jsonResponse(403, {
        success: false,
        error: { code: 'APP_CHECK_FAILED' },
      }));

    await expect(verifyProductionPreflight({
      app: `${PRODUCTION_APP}/`,
      expectedSha: EXPECTED_SHA,
      fetchImpl,
    })).resolves.toEqual({ deployedSha: EXPECTED_SHA });
  });
});
