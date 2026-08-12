import { describe, it, expect } from 'vitest';
import {
  runWithContext,
  getCorrelationId,
  hasRequestContext,
  generateCorrelationId,
} from './requestContext';

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
