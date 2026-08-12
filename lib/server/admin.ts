// ─────────────────────────────────────────────────────────────────────────────
// Firebase Admin (server-only)
//
// Initialized from a service-account. Never imported from client components.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface AdminCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/**
 * Resolve admin credentials from the environment. Supports either a service
 * account JSON file path (local dev) or inline JSON (deployed).
 */
export function getAdminCredentials(): AdminCredentials | null {
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (path) {
    try {
      const sa = require(path) as {
        project_id: string;
        client_email: string;
        private_key: string;
      };
      return {
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: sa.private_key,
      };
    } catch {
      return null;
    }
  }

  if (inline) {
    try {
      const parsed = JSON.parse(inline) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;

export function getAdminApp(): App | null {
  if (cachedApp) return cachedApp;
  const existing = getApps();
  if (existing[0]) {
    cachedApp = existing[0];
    return cachedApp;
  }

  // Local emulator mode: the Firestore + Auth emulators do not need real
  // credentials. When FIRESTORE_EMULATOR_HOST is set, initialize with a
  // demo project id — firebase-admin auto-routes Firestore (and Auth via
  // FIREBASE_AUTH_EMULATOR_HOST) to the local emulators instead of the
  // production project, so development never touches real data.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    cachedApp = initializeApp({ projectId: 'demo-cook-with-freebuff' });
    return cachedApp;
  }

  const creds = getAdminCredentials();
  if (!creds) return null;
  cachedApp = initializeApp({
    credential: cert({
      projectId: creds.projectId,
      clientEmail: creds.clientEmail,
      privateKey: creds.privateKey.replace(/\\n/g, '\n'),
    }),
  });
  return cachedApp;
}

export function getAdminAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  const app = getAdminApp();
  if (!app) return null;
  cachedAuth = getAuth(app);
  return cachedAuth;
}

// settings() may only be called ONCE per Firestore instance. When this module
// is evaluated more than once (dev HMR, or duplicate import specifiers in a
// server bundle), each copy keeps its own cachedDb but getFirestore(app)
// returns the SAME underlying instance — a second settings() call throws
// "Firestore has already been initialized" and breaks every API route that
// touches the db (seen live in dev). swallow the idempotent re-apply: the
// flag is already on, so a duplicate module copy calling settings() again is
// a no-op in intent, not a real conflict.
export function getAdminDb(): Firestore | null {
  if (cachedDb) return cachedDb;
  const app = getAdminApp();
  if (!app) return null;
  // Optional fields (e.g. correlationId) are passed through as `undefined` in
  // write payloads — Firestore rejects undefined values unless this flag is on.
  const db = getFirestore(app);
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch (e) {
    // settings() may only be called once per instance; a duplicate module copy
    // already applied it (the flag is on) — this is not a real conflict.
    if (!(e instanceof Error) || !e.message.includes('already been initialized')) throw e;
  }
  cachedDb = db;
  return cachedDb;
}

/**
 * Resolve the authenticated user id from a Bearer ID token.
 * Returns null when the token is missing or invalid.
 */
export async function resolveUserId(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const auth = getAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}