import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// lib/auth/pages-auth-wiring.test.ts — lock the anonymous-auth wiring in the
// two voice-first pages.
//
// The API routes (api/cook, api/agent, api/tools) reject with 401
// "Authentication required" unless the request carries a valid Bearer ID
// token. The pages therefore MUST wire useAuthSession().getToken into every
// data hook — if a future edit drops the wiring (or a new hook is added
// without it), the deployed /cook screen silently regresses to the broken
// "Authentication required" empty state this test exists to prevent.
// ============================================================================

const COOK = readFileSync('app/cook/page.tsx', 'utf8');
const HOME = readFileSync('app/page.tsx', 'utf8');

describe('app/cook/page.tsx · auth wiring', () => {
  it('creates the anonymous session and wires getToken into BOTH data hooks', () => {
    expect(COOK).toContain('const auth = useAuthSession();');
    expect(COOK).toContain('useCookingSession({ getToken: auth.getToken });');
    expect(COOK).toContain('useVoiceSession({ getToken: auth.getToken });');
  });

  it('waits for the auth settle before showing the session state', () => {
    // Without the gate, the initial status call 401s before the anonymous
    // session exists and the screen flashes the misleading error.
    expect(COOK).toContain("if (auth.state === 'loading') {");
  });

  it('surfaces the auth error before the API 401 message', () => {
    // When the Anonymous provider is disabled, the actionable enable-guidance
    // must win over the API's generic "Authentication required".
    expect(COOK).toContain('auth.error ??\n              cook.error');
  });

  it('offers a Retry sign-in when auth failed', () => {
    expect(COOK).toContain('auth.retry');
    expect(COOK).toContain('↻ Retry sign-in');
  });
});

describe('app/page.tsx · auth wiring', () => {
  it('wires getToken into the home voice session', () => {
    expect(HOME).toContain('const auth = useAuthSession();');
    expect(HOME).toContain('useVoiceSession({ getToken: auth.getToken });');
  });
});
