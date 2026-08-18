import { describe, expect, it } from 'vitest';
import {
  extractBatchFlakeSignatures,
  extractFlakeSignature,
  flakeEscalationVerdict,
  weekKeyOf,
} from './mic-flake-escalate.mjs';

// ============================================================================
// scripts/mic-flake-escalate.test.ts — lock the "same flake 3 weeks running"
// escalation that stops a persistent infra flake from being forgiven forever.
//
// The weekly batch forgives a transient flake (e.g. launch 503) up to the
// flake budget, so a single infra hiccup never opens a false-positive issue.
// But the SAME flake within budget every week is a persistent outage, not a
// transient — the escalation must fire when one signature appears in the
// current week AND in each of the two most recent prior weeks, even though no
// single week exceeded budget. The signature normalization (HTTP route →
// status, excluding the volatile JSON body) is what makes the week-to-week
// match stable.
// ============================================================================

describe('extractFlakeSignature · stable week-over-week keys', () => {
  it('collapses an HTTP route failure to `name → status`, dropping the volatile body', () => {
    expect(extractFlakeSignature('✗ FAIL: launch → 503 {"error":"boom","sessionId":"abc123"}')).toBe('launch → 503');
  });

  it('keeps a space-containing route intact', () => {
    expect(extractFlakeSignature('✗ FAIL: vision scan → 503 {"error":"x"}')).toBe('vision scan → 503');
  });

  it('falls back to a collapsed, bounded message for non-HTTP flakes', () => {
    expect(extractFlakeSignature('✗ FAIL:   starter   not   shown. Page text: lots of page text here')).toBe(
      'starter not shown. Page text: lots of page text here',
    );
  });

  it('bounds the fallback so a long volatile tail cannot fragment the match', () => {
    const sig = extractFlakeSignature(`✗ FAIL: ${'x'.repeat(300)}`);
    expect(sig).toHaveLength(120);
  });

  it('uses the FIRST ✗ FAIL: line as the root (not a downstream cascade)', () => {
    const log = '✗ FAIL: launch → 503 {"a":1}\n✗ FAIL: mic not found (cascade)\n';
    expect(extractFlakeSignature(log)).toBe('launch → 503');
  });

  it('returns null when the log has no failure line', () => {
    expect(extractFlakeSignature('all clean\nRESULT: PASS\n')).toBeNull();
  });
});

describe('extractBatchFlakeSignatures · a week is a union of its flaked runs', () => {
  const seg = (body: string) => `--- run 1/6 ---\n${body}`;

  it('collects flake signatures but never a hard two-burst failure', () => {
    const log = [
      seg('RESULT: PASS'),
      seg('✗ FAIL: launch → 503 {"x":1}'),
      seg('✗ FAIL: passing run but the blob reports a stuck queue — drop class queue'),
    ].join('\n');
    expect(extractBatchFlakeSignatures(log)).toEqual(['launch → 503']);
  });

  it('dedupes the same flake across several runs in one week', () => {
    const log = [
      seg('✗ FAIL: launch → 503 {"x":1}'),
      seg('✗ FAIL: launch → 503 {"x":2}'),
    ].join('\n');
    expect(extractBatchFlakeSignatures(log)).toEqual(['launch → 503']);
  });

  it('returns an empty list for an all-green week', () => {
    expect(extractBatchFlakeSignatures(seg('RESULT: PASS'))).toEqual([]);
  });
});

describe('flakeEscalationVerdict · the 3-week streak', () => {
  const wk = (date: string, signatures: string[]) => ({ date, signatures });

  it('escalates when one signature appears in the current + 2 prior weeks', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(true);
    expect(v.signature).toBe('launch → 503');
    expect(v.dates).toEqual(['2026-08-03', '2026-08-10', '2026-08-17']);
  });

  it('does not escalate with fewer than two prior weeks of history', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(false);
  });

  it('does not escalate when the streak broke (a clean week in between)', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', [])],
    });
    expect(v.escalate).toBe(false);
  });

  it('does not escalate a DIFFERENT flake each week', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 503']),
      previous: [wk('2026-08-03', ['mic not found']), wk('2026-08-10', ['launch → 500'])],
    });
    expect(v.escalate).toBe(false);
  });

  it('escalates on the first signature that actually appears in the prior weeks', () => {
    const v = flakeEscalationVerdict({
      current: wk('2026-08-17', ['launch → 502', 'launch → 503']),
      previous: [wk('2026-08-03', ['launch → 503']), wk('2026-08-10', ['launch → 503'])],
    });
    expect(v.escalate).toBe(true);
    expect(v.signature).toBe('launch → 503');
  });
});

describe('weekKeyOf · Monday anchors the streak week', () => {
  it('maps a Monday to itself', () => {
    expect(weekKeyOf('2026-08-17T06:00:00Z')).toBe('2026-08-17'); // Mon
  });

  it('rolls a Sunday back to the Monday of that week', () => {
    expect(weekKeyOf('2026-08-16T23:59:00Z')).toBe('2026-08-10'); // Sun → Mon
  });

  it('returns null for an unparseable timestamp', () => {
    expect(weekKeyOf('not-a-date')).toBeNull();
  });
});
