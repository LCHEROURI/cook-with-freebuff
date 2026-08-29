import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RUNBOOK = readFileSync(
  'conductor/tracks/secure_real_data_20260821/app-check-rollout-runbook.md',
  'utf8',
);
const README = readFileSync('README.md', 'utf8');

describe('App Check production rollout documentation', () => {
  it('covers every required rollout and recovery stage', () => {
    for (const heading of [
      '## Prerequisites',
      '## Monitor observation',
      '## Activation',
      '## Rollback',
      '## Failure diagnosis',
    ]) {
      expect(RUNBOOK).toContain(heading);
    }
  });

  it('pins fail-closed verification and non-security rollback boundaries', () => {
    expect(RUNBOOK).toContain('--require-app-check-enforced');
    expect(RUNBOOK).toContain('APP_CHECK_ENFORCED=0');
    expect(RUNBOOK).toContain('must not weaken authentication, Firestore rules, write validation, or audit logging');
    expect(RUNBOOK).toContain('NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY');
    expect(RUNBOOK).toContain('NEXT_PUBLIC_FIREBASE_APP_ID');
  });

  it('links the operational runbook from the main App Check documentation', () => {
    expect(README).toContain('app-check-rollout-runbook.md');
  });
});
