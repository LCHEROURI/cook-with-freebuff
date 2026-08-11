import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/drive-ui-skin.test.ts — lock the capture driver's dark-mode
// capability. The skin driver screenshots the three screens of the deployed
// app in the universal UI palette; the --dark flag must keep forcing the
// app's OWN dark palette via CDP media emulation (never the browser's
// auto-darkening) so the dark captures stay byte-meaningful. If a future
// edit drops the emulation, the dark captures silently regress to light —
// this test exists to prevent that.
// ============================================================================

const SRC = readFileSync('scripts/drive-ui-skin.mjs', 'utf8');

describe('scripts/drive-ui-skin.mjs · --dark capture', () => {
  it('parses the --dark flag and defaults the out dir to the dark capture folder', () => {
    expect(SRC).toContain("const DARK = args.includes('--dark');");
    expect(SRC).toContain("flag('--out', DARK ? '/tmp/cook-ui-skin-dark' : '/tmp/cook-ui-skin')");
    // Light and dark captures must never silently overwrite each other.
    expect(SRC).toContain('/tmp/cook-ui-skin-dark');
  });

  it('forces prefers-color-scheme: dark via CDP media emulation BEFORE navigation', () => {
    // The emulation must be the app's own dark palette — Emulation.setEmulatedMedia
    // with the prefers-color-scheme feature, placed before any Page.navigate so
    // every captured route renders dark. A --force-dark-mode launch flag would be
    // the browser's auto-darkening and must not appear.
    expect(SRC).toContain("'Emulation.setEmulatedMedia'");
    expect(SRC).toContain("{ name: 'prefers-color-scheme', value: 'dark' }");
    const emuIndex = SRC.indexOf("'Emulation.setEmulatedMedia'");
    const navIndex = SRC.indexOf('Page.navigate');
    expect(emuIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeGreaterThan(emuIndex);
    expect(SRC).not.toContain('--force-dark-mode');
  });

  it('verifies the emulation actually applied via matchMedia', () => {
    expect(SRC).toContain("matchMedia('(prefers-color-scheme: dark)').matches");
    expect(SRC).toContain('dark emulation did not apply');
  });

  it('documents the flag in the usage header', () => {
    expect(SRC).toContain('[--dark]');
    expect(SRC).toContain('--dark: force prefers-color-scheme: dark');
  });
});
