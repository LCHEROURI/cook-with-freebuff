import { describe, expect, it } from 'vitest';
import { assessSpareStatusReason } from './guard-spare-status.mjs';
import {
  SPARED_LIVE_REASON,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';

const spareFailure =
  `owner still has 1 ${SPARED_LIVE_SESSION_SIGNATURE}: drill-live-session… ` +
  '(COLLECTING_INGREDIENTS, chicken_rice_onion_001, 16s idle)';
const voiceFailure = 'live voice driver → exit 1: WebSocket closed before setup completed';

describe('guard spare status decision', () => {
  it('accepts the exported reason for a pure spare failure', () => {
    expect(assessSpareStatusReason(SPARED_LIVE_REASON, [spareFailure])).toEqual({
      kind: 'spare-only',
      spareFailures: [spareFailure],
      otherFailures: [],
    });
  });

  it('accepts a null reason only when the same job also has a non-spare failure', () => {
    expect(assessSpareStatusReason(null, [spareFailure, voiceFailure])).toEqual({
      kind: 'mixed',
      spareFailures: [spareFailure],
      otherFailures: [voiceFailure],
    });
  });

  it('rejects a missing reason for a pure spare failure', () => {
    expect(assessSpareStatusReason(null, [spareFailure]).kind).toBe('invalid');
  });

  it('rejects a spare reason when an unrelated regression is also present', () => {
    expect(
      assessSpareStatusReason(SPARED_LIVE_REASON, [spareFailure, voiceFailure]).kind,
    ).toBe('invalid');
  });
});
