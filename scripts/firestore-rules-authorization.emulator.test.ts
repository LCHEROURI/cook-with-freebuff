import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  AUTO_BOOT,
  bootEmulator,
} from './emulator-test-helper';
import {
  COOK_OWNER_UID,
  COOK_SECOND_USER_UID,
  createCookRulesHarness,
  type CookRulesHarness,
} from './firestore-rules-harness';

let emulator: { stop: () => Promise<void> } | null = null;
let bootError = '';
try {
  emulator = await bootEmulator();
} catch (error) {
  bootError = error instanceof Error ? error.message : String(error);
}

if (!emulator && AUTO_BOOT) {
  throw new Error(`RUN_EMULATOR_TESTS=1 but the Firestore emulator could not start:\n${bootError}`);
}

const keyedCollections = ['users', 'dietary_profiles'] as const;
const mutableOwnedCollections = [
  'recipes',
  'cooking_sessions',
  'timers',
  'pantry_items',
  'leftovers',
  'grocery_list',
] as const;
const appendOnlyCollections = [
  'cooking_session_events',
  'agent_tool_logs',
] as const;

describe.skipIf(!emulator)('Cook With Freebuff Firestore authorization contract', () => {
  let harness: CookRulesHarness;

  beforeAll(async () => {
    harness = await createCookRulesHarness();
  });

  beforeEach(async () => {
    await harness.clear();
  });

  afterAll(async () => {
    await harness?.cleanup();
    await emulator?.stop();
  });

  describe.each(keyedCollections)('%s keyed-owner policy', (collection) => {
    const ownerPath = `${collection}/${COOK_OWNER_UID}`;
    const secondUserPath = `${collection}/${COOK_SECOND_USER_UID}`;

    it('allows only the matching authenticated uid to create, read, update, and delete', async () => {
      const ownerDoc = harness.owner.firestore().doc(ownerPath);
      await assertSucceeds(ownerDoc.set({ value: 'owner' }));
      await assertSucceeds(ownerDoc.get());
      await assertSucceeds(ownerDoc.update({ value: 'updated' }));

      const secondUserDoc = harness.secondUser.firestore().doc(secondUserPath);
      await assertSucceeds(secondUserDoc.set({ value: 'second-user' }));
      await assertSucceeds(secondUserDoc.delete());
      await assertSucceeds(ownerDoc.delete());
    });

    it('denies second-user and unauthenticated access to the owner document', async () => {
      await harness.seed(ownerPath, { value: 'owner' });
      const secondUserDoc = harness.secondUser.firestore().doc(ownerPath);
      const unauthenticatedDoc = harness.unauthenticated.firestore().doc(ownerPath);

      await assertFails(secondUserDoc.get());
      await assertFails(secondUserDoc.set({ value: 'hijacked' }));
      await assertFails(secondUserDoc.delete());
      await assertFails(unauthenticatedDoc.get());
      await assertFails(unauthenticatedDoc.set({ value: 'anonymous' }));
      await assertFails(unauthenticatedDoc.delete());
    });
  });

  describe.each(mutableOwnedCollections)('%s owner-field policy', (collection) => {
    const ownerPath = `${collection}/owner-document`;

    it('allows owner CRUD and rejects foreign or anonymous CRUD', async () => {
      const ownerDoc = harness.owner.firestore().doc(ownerPath);
      await assertSucceeds(ownerDoc.set({ userId: COOK_OWNER_UID, value: 'owner' }));
      await assertSucceeds(ownerDoc.get());
      await assertSucceeds(ownerDoc.update({ value: 'updated' }));

      const secondUserDoc = harness.secondUser.firestore().doc(ownerPath);
      const unauthenticatedDoc = harness.unauthenticated.firestore().doc(ownerPath);
      await assertFails(secondUserDoc.get());
      await assertFails(secondUserDoc.update({ value: 'hijacked' }));
      await assertFails(secondUserDoc.delete());
      await assertFails(unauthenticatedDoc.get());
      await assertFails(unauthenticatedDoc.update({ value: 'anonymous' }));
      await assertFails(unauthenticatedDoc.delete());
      await assertSucceeds(ownerDoc.delete());
    });

    it('requires creates to stamp the authenticated uid', async () => {
      await assertFails(
        harness.owner.firestore().doc(`${collection}/wrong-owner`).set({
          userId: COOK_SECOND_USER_UID,
        }),
      );
      await assertFails(
        harness.unauthenticated.firestore().doc(`${collection}/anonymous`).set({
          userId: COOK_OWNER_UID,
        }),
      );
      await assertSucceeds(
        harness.secondUser.firestore().doc(`${collection}/second-user`).set({
          userId: COOK_SECOND_USER_UID,
        }),
      );
    });

    it('rejects ownership transfer by the current owner', async () => {
      await harness.seed(ownerPath, { userId: COOK_OWNER_UID, value: 'owner' });
      await assertFails(
        harness.owner.firestore().doc(ownerPath).update({
          userId: COOK_SECOND_USER_UID,
        }),
      );
    });
  });

  describe.each(appendOnlyCollections)('%s append-only policy', (collection) => {
    const ownerPath = `${collection}/owner-document`;

    it('allows an owner-stamped create and owner read only', async () => {
      const ownerDoc = harness.owner.firestore().doc(ownerPath);
      await assertSucceeds(ownerDoc.set({ userId: COOK_OWNER_UID, value: 'owner' }));
      await assertSucceeds(ownerDoc.get());
      await assertFails(ownerDoc.update({ value: 'rewritten' }));
      await assertFails(ownerDoc.delete());
    });

    it('denies wrong-owner creates plus cross-user and anonymous access', async () => {
      await harness.seed(ownerPath, { userId: COOK_OWNER_UID, value: 'owner' });
      await assertFails(
        harness.owner.firestore().doc(`${collection}/wrong-owner`).set({
          userId: COOK_SECOND_USER_UID,
        }),
      );
      await assertFails(harness.secondUser.firestore().doc(ownerPath).get());
      await assertFails(harness.secondUser.firestore().doc(ownerPath).delete());
      await assertFails(harness.unauthenticated.firestore().doc(ownerPath).get());
      await assertFails(
        harness.unauthenticated.firestore().doc(`${collection}/anonymous`).set({
          userId: COOK_OWNER_UID,
        }),
      );
    });
  });

  it('keeps correlation markers server-managed and inaccessible to every client', async () => {
    await harness.seed('correlation_markers/server-marker', {
      markedAt: 1_700_000_000_000,
      rawId: 'server-marker',
    });

    for (const context of [harness.owner, harness.secondUser, harness.unauthenticated]) {
      const marker = context.firestore().doc('correlation_markers/server-marker');
      await assertFails(marker.get());
      await assertFails(marker.set({ markedAt: 1_800_000_000_000 }));
      await assertFails(marker.update({ markedAt: 1_800_000_000_000 }));
      await assertFails(marker.delete());
    }
  });
});
