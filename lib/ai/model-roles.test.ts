// ============================================================================
// lib/ai/model-roles.test.ts — lock the Gemini model defaults to current,
// non-deprecated names.
//
// The Gemini 2.5 family shuts down in October 2026 (Firebase AI Logic docs),
// so a 2.x default is a latent outage: the app would keep "working" until the
// shutdown date, then every generation call returns 404. These tests pin the
// exact defaults that ship today AND forbid the deprecated family, so a model
// bump must be a deliberate, reviewed change (the pins move together) and a
// silent rollback to a shutdown model fails here.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { MODEL_ROLES, MODEL_ROLE_CONFIG, type GeminiModelRole } from './model-roles';

// The deprecated family: any gemini-2.x name is on the October 2026 shutdown.
const DEPRECATED_GEMINI_2_RE = /^gemini-2\./;

describe('lib/ai/model-roles.ts · model default currency contract', () => {
  it('pins the exact current defaults (a bump must move these pins together)', () => {
    expect(MODEL_ROLE_CONFIG.generation.defaultModel).toBe('gemini-3.7-flash');
    expect(MODEL_ROLE_CONFIG.validation.defaultModel).toBe('gemini-3.7-flash');
    expect(MODEL_ROLE_CONFIG.conversation.defaultModel).toBe('gemini-3.7-flash');
    expect(MODEL_ROLE_CONFIG.vision.defaultModel).toBe('gemini-3.7-flash');
    // Live voice keeps its own name: gemini-3.1-flash-live-preview is the
    // current Gemini Live API model for the Gemini Developer API.
    expect(MODEL_ROLE_CONFIG['live-voice'].defaultModel).toBe('gemini-3.1-flash-live-preview');
  });

  it('forbids any default in the deprecated Gemini 2.x family (shuts down October 2026)', () => {
    for (const { role, defaultModel } of MODEL_ROLES) {
      expect(
        DEPRECATED_GEMINI_2_RE.test(defaultModel),
        `role ${role} defaults to the deprecated ${defaultModel}`,
      ).toBe(false);
    }
  });

  it('keeps the role table complete: all five roles are present with the full precedence fields', () => {
    const roles = MODEL_ROLES.map((r) => r.role).sort();
    expect(roles).toEqual(['conversation', 'generation', 'live-voice', 'validation', 'vision'] as GeminiModelRole[]);
    for (const entry of MODEL_ROLES) {
      expect(entry.rcParam).toBeTruthy();
      expect(entry.envVar).toBeTruthy();
      expect(entry.defaultModel).toBeTruthy();
      // Every env-var fallback names a real env var the runtime could set.
      expect(entry.envVar).toMatch(/^[A-Z_]+$/);
    }
  });
});
