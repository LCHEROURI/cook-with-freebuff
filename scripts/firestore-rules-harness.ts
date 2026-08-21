import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  EMULATOR_PORT,
} from './emulator-test-helper';

export const COOK_RULES_PROJECT = 'demo-cook-with-freebuff-rules';
export const COOK_OWNER_UID = 'cook-owner';
export const COOK_SECOND_USER_UID = 'cook-second-user';

const RULES_PATH = fileURLToPath(new URL('../firestore.rules', import.meta.url));

export interface CookRulesHarness {
  environment: RulesTestEnvironment;
  owner: RulesTestContext;
  secondUser: RulesTestContext;
  unauthenticated: RulesTestContext;
  seed(path: string, data: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Build isolated client contexts against the real union ruleset. Seed writes
 * bypass rules intentionally; every operation under test must use one of the
 * three exposed client contexts.
 */
export async function createCookRulesHarness(): Promise<CookRulesHarness> {
  const rules = await readFile(RULES_PATH, 'utf8');
  const environment = await initializeTestEnvironment({
    projectId: COOK_RULES_PROJECT,
    firestore: {
      host: '127.0.0.1',
      port: EMULATOR_PORT,
      rules,
    },
  });

  const owner = environment.authenticatedContext(COOK_OWNER_UID);
  const secondUser = environment.authenticatedContext(COOK_SECOND_USER_UID);
  const unauthenticated = environment.unauthenticatedContext();

  return {
    environment,
    owner,
    secondUser,
    unauthenticated,
    seed: async (path, data) => {
      await environment.withSecurityRulesDisabled(async (context) => {
        await context.firestore().doc(path).set(data);
      });
    },
    clear: () => environment.clearFirestore(),
    cleanup: () => environment.cleanup(),
  };
}
