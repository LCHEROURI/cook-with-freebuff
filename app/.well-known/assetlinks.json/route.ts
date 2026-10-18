import { NextResponse } from 'next/server';

/**
 * GET /.well-known/assetlinks.json
 *
 * Digital Asset Links verification for Android Trusted Web Activity (TWA).
 * Enables full-screen, native Android app presentation on Google Play without
 * the browser URL address bar (Chrome Custom Tab).
 */
export async function GET() {
  const packageName = process.env.ANDROID_PACKAGE_NAME || 'com.freebuff.cookwithme';
  
  // Can be configured via comma-separated string or JSON array in env
  const envFingerprints = process.env.ANDROID_SHA256_FINGERPRINTS;
  let fingerprints: string[] = [];
  
  if (envFingerprints) {
    try {
      if (envFingerprints.startsWith('[')) {
        fingerprints = JSON.parse(envFingerprints);
      } else {
        fingerprints = envFingerprints.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } catch {
      fingerprints = [envFingerprints.trim()];
    }
  }

  // If no production key configured yet, provide development / placeholder fingerprint
  if (fingerprints.length === 0) {
    fingerprints = [
      // Standard debug keystore / placeholder entry until Play Console key is added
      '39:40:AB:7C:41:E4:41:E7:80:2D:D0:D7:6A:A2:45:1B:40:14:6C:9F:19:9C:EC:B9:19:E4:FF:73:12:46:82:71',
    ];
  }

  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return NextResponse.json(assetlinks, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
