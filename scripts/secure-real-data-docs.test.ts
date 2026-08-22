import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const security = readFileSync('SECURITY.md', 'utf8');
const deployment = readFileSync('DEPLOYMENT.md', 'utf8');
const testing = readFileSync('TESTING.md', 'utf8');
const agents = readFileSync('AGENTS.md', 'utf8');
const scriptAgents = readFileSync('scripts/AGENTS.md', 'utf8');
const CHECKLIST_PATH =
  'conductor/tracks/secure_real_data_20260821/release-readiness-checklist.md';
const checklist = existsSync(CHECKLIST_PATH)
  ? readFileSync(CHECKLIST_PATH, 'utf8')
  : '';

describe('secure real-data operational documentation', () => {
  it('documents write validation, ownership rules, and App Check boundaries', () => {
    expect(security).toContain('Every repository create and update validates the complete resulting document');
    expect(security).toContain('immutable identity, ownership, source, and creation fields');
    expect(security).toContain('non-Cook union sections byte-for-byte');
    expect(security).toContain('App Check runs before authentication and provider work');
    expect(security).toContain('APP_CHECK_ENFORCED=1');
  });

  it('documents the guarded production rollout and rollback sequence', () => {
    for (const variable of [
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY',
      'APP_CHECK_ENFORCED',
    ]) {
      expect(deployment).toContain(variable);
    }
    expect(deployment).toContain('npm run verify:live -- --require-app-check-enforced');
    expect(deployment).toContain('npm run verify:real-data');
    expect(deployment).toContain('/api/build-info');
    expect(deployment).toContain('403 `APP_CHECK_FAILED`');
    expect(deployment).toContain('Do not run either write-capable production probe against a stale revision');
  });

  it('documents all local and production verification layers', () => {
    expect(testing).toContain('npm run check');
    expect(testing).toContain('npm run test:rules');
    expect(testing).toContain('npm run test:emulator');
    expect(testing).toContain('npm run verify:real-data');
    expect(testing).toContain('two unique temporary Auth users');
    expect(testing).toContain('never prints credentials or tokens');
  });

  it('pins agent rules for App Check ordering and production probe safety', () => {
    expect(agents).toContain('App Check before authentication, parsing, or quota/provider work');
    expect(agents).toContain('preserve non-Cook union rules byte-for-byte');
    expect(scriptAgents).toContain('`verify-real-data.mjs`');
    expect(scriptAgents).toContain('npm run verify:real-data');
    expect(scriptAgents).toContain('Admin SDK is cleanup-only for the asserted document lifecycle');
    expect(scriptAgents).toContain('Never run write-capable production probes until `/api/build-info`');
  });

  it('separates proven compatibility from external release prerequisites', () => {
    expect(checklist).toContain('No destructive data migration is required');
    expect(checklist).toContain('Existing representative document shapes');
    expect(checklist).toContain('Rollback App Check with a reviewed redeploy');
    expect(checklist).toContain('previous complete synchronized union ruleset');
    expect(checklist).toContain('Do not access or modify the sibling application');
    expect(checklist).toContain('byte-identical');
    expect(checklist).toContain('Live build SHA matches the guarded revision');
    expect(checklist).toContain('Unattested request returns 403 `APP_CHECK_FAILED`');
    expect(checklist).toContain('Authenticated real-data smoke returns `RESULT: PASS`');
    expect(checklist).toContain('Release status: BLOCKED');
  });
});
