#!/usr/bin/env node
// Authenticated production Firestore smoke for Cook With Freebuff.
//
// This probe deliberately uses Firebase's client SDK for the asserted CRUD
// lifecycle so deployed Firestore rules make every allow/deny decision. The
// Admin SDK is used only to mint disposable identities and as a finally-block
// cleanup backstop. No credentials or tokens are printed.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cert, deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';
import { deleteDoc, doc, getDoc, getFirestore, setDoc, updateDoc } from 'firebase/firestore';

const EXPECTED_PROJECT_ID = 'portfolio-app-freebuff2';
const PANTRY_COLLECTION = 'pantry_items';

if (!process.argv.includes('--confirm-production')) {
  throw new Error('Refusing real-data access without --confirm-production.');
}

function loadEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // CI may provide every value directly.
  }
}

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  let parsed;
  try {
    parsed = inline ? JSON.parse(inline) : path ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    throw new Error('Firebase service-account configuration is invalid JSON.');
  }

  if (!parsed?.project_id || !parsed?.client_email || !parsed?.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH is required.');
  }
  return parsed;
}

function assertProductionIntent(projectId, serviceAccount) {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Refusing to run a production proof with emulator hosts configured.');
  }
  if (process.env.NEXT_PUBLIC_USE_FIRESTORE_EMULATOR === '1') {
    throw new Error('Refusing real-data access while NEXT_PUBLIC_USE_FIRESTORE_EMULATOR=1.');
  }
  if (projectId !== EXPECTED_PROJECT_ID || serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
    throw new Error(`Refusing unexpected Firebase project; expected ${EXPECTED_PROJECT_ID}.`);
  }
}

async function expectPermissionDenied(label, operation) {
  try {
    await operation();
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code !== 'permission-denied' && code !== 'firestore/permission-denied') {
      throw new Error(`${label} failed for an unexpected reason.`);
    }
    console.log(`  ✓ ${label} denied by Firestore rules`);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

loadEnv();

const serviceAccount = loadServiceAccount();
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

if (!apiKey || !projectId || !appId) {
  throw new Error('Firebase web configuration is incomplete.');
}
assertProductionIntent(projectId, serviceAccount);

const runId = randomUUID();
const ownerUid = `verify-real-data-owner-${runId}`;
const otherUid = `verify-real-data-other-${runId}`;
const documentId = `verify-real-data-${runId}`;

const adminApp = initializeAdminApp(
  {
    credential: cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
    }),
    projectId,
  },
  `verify-real-data-admin-${runId}`,
);
const adminAuth = getAdminAuth(adminApp);
const adminDb = getAdminFirestore(adminApp);

const clientConfig = {
  apiKey,
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  appId,
};
const ownerApp = initializeApp(clientConfig, `verify-real-data-owner-${runId}`);
const otherApp = initializeApp(clientConfig, `verify-real-data-other-${runId}`);
const ownerAuth = getAuth(ownerApp);
const otherAuth = getAuth(otherApp);
const ownerDb = getFirestore(ownerApp);
const otherDb = getFirestore(otherApp);
const ownerRef = doc(ownerDb, 'pantry_items', documentId);
const otherRef = doc(otherDb, 'pantry_items', documentId);

let cleanupPromise;
async function cleanupProbe() {
  cleanupPromise ??= (async () => {
    await Promise.allSettled([signOut(ownerAuth), signOut(otherAuth)]);
    await Promise.allSettled([deleteApp(ownerApp), deleteApp(otherApp)]);
    const userCleanupResults = await Promise.allSettled([ownerUid, otherUid].map(async (uid) => {
      try {
        await adminAuth.deleteUser(uid);
      } catch (error) {
        if (error?.code !== 'auth/user-not-found') throw error;
      }
    }));
    const cleanupResults = await Promise.allSettled([
      adminDb.collection(PANTRY_COLLECTION).doc(documentId).delete(),
    ]);
    await deleteAdminApp(adminApp);
    if ([...cleanupResults, ...userCleanupResults].some((result) => result.status === 'rejected')) {
      throw new Error('The real-data probe cleanup did not complete.');
    }
  })();
  return cleanupPromise;
}

async function exitOnSignal(signal) {
  console.error(`\n${signal} received; cleaning the isolated real-data probe.`);
  try {
    await cleanupProbe();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
}

process.once('SIGINT', () => void exitOnSignal('SIGINT'));
process.once('SIGTERM', () => void exitOnSignal('SIGTERM'));

async function main() {
  const now = Date.now();
  const pantryItem = {
    id: documentId,
    userId: ownerUid,
    name: 'Cook With Freebuff verification item',
    quantity: 1,
    unit: 'item',
    confidence: 1,
    source: 'MANUAL',
    lastConfirmedAt: now,
    notes: 'Temporary authenticated real-data verification probe',
  };

  console.log(`Authenticated real-data proof: ${projectId}`);
  console.log('No credentials or tokens are printed.');

  try {
    const ownerCustomToken = await adminAuth.createCustomToken(ownerUid);
    const otherCustomToken = await adminAuth.createCustomToken(otherUid);
    await signInWithCustomToken(ownerAuth, ownerCustomToken);
    await signInWithCustomToken(otherAuth, otherCustomToken);
    console.log('  ✓ temporary authenticated identities ready');

    await setDoc(ownerRef, pantryItem);
    console.log('  ✓ owner created pantry item');

    const created = await getDoc(ownerRef);
    if (!created.exists() || created.data().userId !== ownerUid || created.data().quantity !== 1) {
      throw new Error('Owner read did not return the created pantry item.');
    }
    console.log('  ✓ owner read pantry item');

    await updateDoc(ownerRef, { quantity: 2, lastConfirmedAt: Date.now() });
    const updated = await getDoc(ownerRef);
    if (!updated.exists() || updated.data().quantity !== 2) {
      throw new Error('Owner update was not persisted.');
    }
    console.log('  ✓ owner updated pantry item');

    await expectPermissionDenied('cross-user read', () => getDoc(otherRef));
    await expectPermissionDenied('cross-user update', () => updateDoc(otherRef, { quantity: 99 }));
    await expectPermissionDenied('cross-user delete', () => deleteDoc(otherRef));

    await deleteDoc(ownerRef);
    const removed = await getDoc(ownerRef);
    if (removed.exists()) {
      throw new Error('Owner cleanup did not remove the pantry item.');
    }
    console.log('  ✓ owner deleted pantry item and confirmed cleanup');
    console.log('RESULT: PASS');
  } finally {
    await cleanupProbe();
  }
}

main().catch((error) => {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
