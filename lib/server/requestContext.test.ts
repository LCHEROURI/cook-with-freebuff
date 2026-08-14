import { describe, it, expect } from 'vitest';
import {
  runWithContext,
  getCorrelationId,
  hasRequestContext,
  generateCorrelationId,
  validateClientCorrelationId,
} from './requestContext';
import { correlationIdSchema } from '../domain/schemas';

describe('generateCorrelationId', () => {
  it('produces a non-empty string with the req_ prefix', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^req_[A-Za-z0-9]+_[a-z0-9]+$/);
  });

  it('produces unique ids on consecutive calls', () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).not.toBe(b);
  });
});

describe('runWithContext + getCorrelationId', () => {
  it('returns the correlationId inside the context', () => {
    let observed = '';
    runWithContext('req_test_123', () => {
      observed = getCorrelationId();
    });
    expect(observed).toBe('req_test_123');
  });

  it('returns the fallback when no context is active', () => {
    expect(getCorrelationId()).toBe('no-correlation-id');
  });

  it('returns a custom fallback when no context is active', () => {
    expect(getCorrelationId('custom-fallback')).toBe('custom-fallback');
  });

  it('preserves the context across nested async calls', async () => {
    let deep = '';
    await runWithContext('req_nested', async () => {
      await new Promise((r) => setTimeout(r, 1));
      deep = getCorrelationId();
    });
    expect(deep).toBe('req_nested');
  });

  it('does not leak context to the outer scope', () => {
    runWithContext('req_leak_test', () => {
      expect(getCorrelationId()).toBe('req_leak_test');
    });
    // After runWithContext returns, no context exists
    expect(getCorrelationId('fallback')).toBe('fallback');
  });
});

describe('hasRequestContext', () => {
  it('is true inside a context', () => {
    runWithContext('req_has', () => {
      expect(hasRequestContext()).toBe(true);
    });
  });

  it('is false outside a context', () => {
    expect(hasRequestContext()).toBe(false);
  });
});

describe('validateClientCorrelationId (API boundary)', () => {
  it('treats an absent id as valid-but-undefined (caller generates)', () => {
    expect(validateClientCorrelationId(undefined)).toEqual({ valid: true, id: undefined });
    expect(validateClientCorrelationId(null)).toEqual({ valid: true, id: undefined });
  });

  it('accepts every shape the app actually produces', () => {
    const ids = [
      'req_AbC123_zz', // server-generated
      'route-resume-53',
      'step1-done',
      'a.b_c-d',
      'X', // single char
      'a'.repeat(128), // exactly the max length
    ];
    for (const id of ids) {
      expect(validateClientCorrelationId(id)).toEqual({ valid: true, id });
    }
  });

  it('server-generated ids always clear the boundary schema', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateCorrelationId();
      expect(correlationIdSchema.safeParse(id).success).toBe(true);
      expect(validateClientCorrelationId(id).valid).toBe(true);
    }
  });

  it('rejects a path separator and other forbidden characters', () => {
    for (const bad of ['a/b', 'a b', 'a:b', 'a>b', 'a\n', 'héllo', 'résumé→עברית']) {
      expect(validateClientCorrelationId(bad), `should reject ${bad}`).toEqual({ valid: false });
    }
  });

  it('rejects empty and over-length ids', () => {
    expect(validateClientCorrelationId('')).toEqual({ valid: false });
    expect(validateClientCorrelationId('a'.repeat(129))).toEqual({ valid: false });
  });

  it('rejects non-strings', () => {
    expect(validateClientCorrelationId(123)).toEqual({ valid: false });
    expect(validateClientCorrelationId({})).toEqual({ valid: false });
    expect(validateClientCorrelationId(['x'])).toEqual({ valid: false });
  });

  it('rejects the server-only constructed variants (they never cross the boundary)', () => {
    // These are built server-side (rollback re-pause, idle fast-forward) and
    // must NOT be accepted from a client — a client could otherwise squat on
    // a reserved namespace.
    expect(validateClientCorrelationId('resume-rollback:req_x:abcdefghij1234567890')).toEqual({ valid: false });
    expect(validateClientCorrelationId('idle->req_x')).toEqual({ valid: false });
  });
});
