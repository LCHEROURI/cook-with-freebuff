import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/apphosting-config.test.ts — lock the App Hosting build env to the
// REAL Firebase project.
//
// App Hosting builds the deployed app from apphosting.yaml's BUILD env. If
// those six NEXT_PUBLIC_FIREBASE_* values point at the wrong project, the
// deployed app initializes Firebase Auth under the wrong API key: the owner
// session the drivers inject (stamped under the CI key) is never found, the
// app shows the signed-out landing, and the /cook starter never renders —
// verify:live's [3d]/[3e] stages fail with `no-input` / missing dictation
// markers while every gate around them stays green.
//
// That is exactly the bug this file locks: commit ca77468 introduced a
// client config for a DIFFERENT project (key AIzaSyDwSk…, sender 774744467587)
// into apphosting.yaml. The real project is portfolio-app-freebuff2
// (key AIzaSyA9iUv…, sender 952213217375) — the values below, which the CI
// drivers mint the owner token with and which the identitytoolkit probe
// confirms. A future edit that swaps in another project's config fails here.
// ============================================================================

const YAML = readFileSync('apphosting.yaml', 'utf8');

// The known-good client config — the real project, verified by minting an
// owner token with the CI key (iss: securetoken.google.com/portfolio-app-freebuff2)
// and confirmed by the identitytoolkit probe that the old apphosting key
// belonged to projects/809486874543 instead.
const REAL_PROJECT = {
  apiKey: 'AIzaSyA9iUv7FVUDEuwO5pdEd8RXJc9qshNMRlE',
  authDomain: 'portfolio-app-freebuff2.firebaseapp.com',
  projectId: 'portfolio-app-freebuff2',
  storageBucket: 'portfolio-app-freebuff2.firebasestorage.app',
  senderId: '952213217375',
  // App Hosting binds the cook-with-freebuff backend to this dedicated web
  // app. Using the other active web app in the shared Firebase project makes
  // App Check mint/verify against the wrong application identity.
  appId: '1:952213217375:web:ad84f1308f28ca4f523bea',
};

describe('apphosting.yaml · Firebase client config contract lock', () => {
  it('carries the REAL project credentials, not the wrong-project ones', () => {
    expect(YAML).toContain(`value: ${REAL_PROJECT.apiKey}`);
    expect(YAML).toContain(`value: ${REAL_PROJECT.authDomain}`);
    expect(YAML).toContain(`value: ${REAL_PROJECT.projectId}`);
    expect(YAML).toContain(`value: ${REAL_PROJECT.storageBucket}`);
    expect(YAML).toContain(`value: "${REAL_PROJECT.senderId}"`);
    expect(YAML).toContain(`value: ${REAL_PROJECT.appId}`);
  });

  it('no longer contains the wrong-project credentials from commit ca77468', () => {
    expect(YAML).not.toContain('AIzaSyDwSkl-FVO53Vuzeoo3ZjtWhtJumnjtQiU');
    expect(YAML).not.toContain('774744467587');
    expect(YAML).not.toContain('portfolio-app-freebuff2.appspot.com');
  });

  it('is internally consistent: sender id, app id and project id all match', () => {
    // The sender id is the project number; the app id embeds it too. A config
    // where these disagree (as ca77468's did) cannot authenticate against any
    // single project.
    expect(REAL_PROJECT.appId.startsWith(`1:${REAL_PROJECT.senderId}:`)).toBe(true);
    expect(REAL_PROJECT.authDomain).toBe(`${REAL_PROJECT.projectId}.firebaseapp.com`);
    expect(REAL_PROJECT.storageBucket).toBe(`${REAL_PROJECT.projectId}.firebasestorage.app`);
    // And the yaml must expose them together, not split across revisions.
    const apiKeyIdx = YAML.indexOf(REAL_PROJECT.apiKey);
    const senderIdx = YAML.indexOf(REAL_PROJECT.senderId);
    const appIdIdx = YAML.indexOf(REAL_PROJECT.appId);
    expect(apiKeyIdx).toBeGreaterThan(-1);
    expect(senderIdx).toBeGreaterThan(-1);
    expect(appIdIdx).toBeGreaterThan(-1);
  });
});

describe('apphosting.yaml · production App Check contract', () => {
  it('injects the browser site key from Secret Manager at build and runtime', () => {
    expect(YAML).toContain([
      '  - variable: NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY',
      '    secret: NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY',
      '    availability:',
      '      - BUILD',
      '      - RUNTIME',
    ].join('\n'));
  });

  it('enforces App Check in the production runtime', () => {
    expect(YAML).toContain([
      '  - variable: APP_CHECK_ENFORCED',
      '    value: "1"',
      '    availability:',
      '      - RUNTIME',
    ].join('\n'));
  });
});
