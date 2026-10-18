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
      'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
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
