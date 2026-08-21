import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe.skipIf(!emulator)('Cook With Freebuff Firestore rules harness', () => {
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

  it('provides deterministic owner, second-user, and unauthenticated clients', async () => {
    expect(COOK_OWNER_UID).not.toBe(COOK_SECOND_USER_UID);
    await harness.seed('recipes/owner-recipe', {
      id: 'owner-recipe',
      userId: COOK_OWNER_UID,
      title: 'Harness recipe',
    });

    await assertSucceeds(
      harness.owner.firestore().doc('recipes/owner-recipe').get(),
    );
    await assertFails(
      harness.secondUser.firestore().doc('recipes/owner-recipe').get(),
    );
    await assertFails(
      harness.unauthenticated.firestore().doc('recipes/owner-recipe').get(),
    );
  });
});
