import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/audit-a11y.test.ts — lock the axe audit driver's shape. The audit
// is the repeatable accessibility gate over the deployed app (/, /cook,
// /kitchen, light + dark). If a future edit drops the axe injection, the
// route set, the owner-session injection, or the fail-on-violation exit, the
// audit silently stops protecting the app — this test exists to prevent that.
// ============================================================================

const SRC = readFileSync('scripts/audit-a11y.mjs', 'utf8');

describe('scripts/audit-a11y.mjs · audit driver contract', () => {
  it('audits all three routes with the owner session injected (auth-gated surfaces signed in)', () => {
    expect(SRC).toContain("const ROUTES = ['/', '/cook', '/kitchen'];");
    expect(SRC).toContain("const EXPECT = { '/': 'Start cooking', '/cook': 'Cook With Me', '/kitchen': 'My Kitchen' };");
    expect(SRC).toContain('signInWithCustomToken');
    expect(SRC).toContain('firebaseLocalStorageDb');
  });

  it('injects axe-core from node_modules into each loaded document and verifies it took', () => {
    expect(SRC).toContain("node_modules/axe-core/axe.min.js");
    expect(SRC).toContain('await evaluate(AXE_SOURCE);');
    expect(SRC).toContain("const axeType = await evaluate('typeof axe');");
    expect(SRC).toContain('axe failed to load');
  });

  it('runs axe with violations + incomplete and fails the run on any violation', () => {
    expect(SRC).toContain("axe.run(document, { resultTypes: ['violations', 'incomplete'] })");
    expect(SRC).toContain('exit(1)');
    expect(SRC).toContain('AUDIT RESULT:');
  });

  it('supports the --dark palette via CDP media emulation', () => {
    expect(SRC).toContain("const DARK = args.includes('--dark');");
    expect(SRC).toContain("'Emulation.setEmulatedMedia'");
    expect(SRC).toContain("{ name: 'prefers-color-scheme', value: 'dark' }");
  });
});
