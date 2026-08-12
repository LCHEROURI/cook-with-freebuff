import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/emulator-setup.test.ts — lock the local Firestore/Auth emulator wiring.
//
// The emulator setup lets development run against a LOCAL Firestore + Auth
// instead of the production project. Its load-bearing properties are: the
// client connects Auth + Firestore to the emulators only under the opt-in
// flag; the admin SDK skips the real service account under
// FIRESTORE_EMULATOR_HOST; firebase.json defines the three emulator ports; and
// the one-command npm script wires it all. A future edit that drops any of
// these fails here instead of silently re-pointing dev at production.
// ============================================================================

const CLIENT = readFileSync('lib/firebase/client.ts', 'utf8');
const ADMIN = readFileSync('lib/server/admin.ts', 'utf8');
const FIREBASE_JSON = readFileSync('firebase.json', 'utf8');
const PKG = readFileSync('package.json', 'utf8');
const ENV_EXAMPLE = readFileSync('.env.example', 'utf8');
const GITIGNORE = readFileSync('.gitignore', 'utf8');

describe('local Firestore/Auth emulator wiring · contract lock', () => {
  it('client connects Auth and Firestore to the emulators only under NEXT_PUBLIC_USE_FIRESTORE_EMULATOR=1', () => {
    expect(CLIENT).toContain("NEXT_PUBLIC_USE_FIRESTORE_EMULATOR === '1'");
    expect(CLIENT).toContain('connectAuthEmulator');
    expect(CLIENT).toContain('connectFirestoreEmulator');
    // Auth emulator URL and Firestore port must match firebase.json below.
    expect(CLIENT).toContain("'http://localhost:9099'");
    expect(CLIENT).toContain('8080');
  });

  it('admin skips the service account and inits a demo project under FIRESTORE_EMULATOR_HOST', () => {
    expect(ADMIN).toContain('FIRESTORE_EMULATOR_HOST');
    expect(ADMIN).toContain("'demo-cook-with-freebuff'");
  });

  it('firebase.json defines the emulators WITHOUT clobbering the existing apphosting/indexes config', () => {
    const cfg = JSON.parse(FIREBASE_JSON);
    expect(cfg.firestore.rules).toBe('firestore.rules');
    expect(cfg.emulators.auth.port).toBe(9099);
    expect(cfg.emulators.firestore.port).toBe(8080);
    expect(cfg.emulators.ui.enabled).toBe(true);
    // The App Hosting deploy config is load-bearing: dropping `backendId` or
    // the `indexes` reference would break `firebase deploy --only apphosting`
    // and the composite-index deploy. A future edit that adds emulator config
    // by REPLACING the whole file (instead of appending) fails here.
    expect(cfg.firestore.indexes).toBe('firestore.indexes.json');
    expect(cfg.apphosting.backendId).toBe('cook-with-freebuff');
    expect(cfg.apphosting.rootDir).toBe('/');
    expect(cfg.apphosting.ignore).toContain('node_modules');
  });

  it('npm run emulators imports the previous snapshot and re-exports on exit', () => {
    expect(PKG).toContain(
      '"emulators": "npx -y firebase-tools@latest emulators:start --only firestore,auth,ui --project demo-cook-with-freebuff --import emulator-data --export-on-exit emulator-data"',
    );
  });

  it('npm run emulators:export snapshots firestore + auth mid-session', () => {
    expect(PKG).toContain(
      '"emulators:export": "npx -y firebase-tools@latest emulators:export --force --only firestore,auth --project demo-cook-with-freebuff emulator-data"',
    );
  });

  it('gitignores the emulator-data export directory so seeded data is never committed', () => {
    expect(GITIGNORE).toContain('emulator-data/');
  });

  it('documents the emulator env vars in .env.example', () => {
    expect(ENV_EXAMPLE).toContain('NEXT_PUBLIC_USE_FIRESTORE_EMULATOR=');
    expect(ENV_EXAMPLE).toContain('FIRESTORE_EMULATOR_HOST=');
    expect(ENV_EXAMPLE).toContain('FIREBASE_AUTH_EMULATOR_HOST=');
  });
});
