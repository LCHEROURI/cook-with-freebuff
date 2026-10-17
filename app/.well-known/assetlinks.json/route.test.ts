import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from './route';

describe('GET /.well-known/assetlinks.json', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANDROID_PACKAGE_NAME;
    delete process.env.ANDROID_SHA256_FINGERPRINTS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default package and placeholder fingerprint when env is unset', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(body[0].target.namespace).toBe('android_app');
    expect(body[0].target.package_name).toBe('com.freebuff.cookwithme');
    expect(body[0].target.sha256_cert_fingerprints).toHaveLength(1);
  });

  it('uses configured package name and comma-separated fingerprints', async () => {
    process.env.ANDROID_PACKAGE_NAME = 'com.custom.cookapp';
    process.env.ANDROID_SHA256_FINGERPRINTS = 'AA:BB:CC, DD:EE:FF';

    const res = await GET();
    const body = await res.json();
    expect(body[0].target.package_name).toBe('com.custom.cookapp');
    expect(body[0].target.sha256_cert_fingerprints).toEqual(['AA:BB:CC', 'DD:EE:FF']);
  });

  it('parses JSON array format in ANDROID_SHA256_FINGERPRINTS', async () => {
    process.env.ANDROID_SHA256_FINGERPRINTS = JSON.stringify(['11:22:33', '44:55:66']);

    const res = await GET();
    const body = await res.json();
    expect(body[0].target.sha256_cert_fingerprints).toEqual(['11:22:33', '44:55:66']);
  });
});
