// ─────────────────────────────────────────────────────────────────────────────
// Firebase client (browser-safe)
//
// Only NEXT_PUBLIC_* values live here — never server-only secrets.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export function getClientConfig(): FirebaseClientConfig | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket: storageBucket ?? '',
    messagingSenderId: messagingSenderId ?? '',
    appId,
  };
}

// Local emulator wiring: when NEXT_PUBLIC_USE_FIRESTORE_EMULATOR=1, the client
// points Auth and Firestore at the local emulators instead of the production
// project, so development never touches real data. The flag is a build-time
// NEXT_PUBLIC_* value, so it is inlined into both client and server bundles.
const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_FIRESTORE_EMULATOR === '1';
const AUTH_EMULATOR_URL = 'http://localhost:9099';
const FIRESTORE_EMULATOR_HOST = 'localhost';
const FIRESTORE_EMULATOR_PORT = 8080;

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  const config = getClientConfig();
  if (!config) return null;
  if (cachedApp) return cachedApp;
  const existing = getApps();
  cachedApp = existing[0] ?? initializeApp(config);
  return cachedApp;
}

export function getClientAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  const app = getFirebaseApp();
  if (!app) return null;
  cachedAuth = getAuth(app);
  if (USE_EMULATOR) connectAuthEmulator(cachedAuth, AUTH_EMULATOR_URL);
  return cachedAuth;
}

export function getClientDb(): Firestore | null {
  if (cachedDb) return cachedDb;
  const app = getFirebaseApp();
  if (!app) return null;
  cachedDb = getFirestore(app);
  if (USE_EMULATOR) connectFirestoreEmulator(cachedDb, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT);
  return cachedDb;
}