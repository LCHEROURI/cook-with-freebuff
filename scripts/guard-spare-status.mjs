import {
  SPARED_LIVE_REASON,
  SPARED_LIVE_SESSION_SIGNATURE,
} from './verify-live-classify.mjs';

/**
 * Decide whether the live status record is consistent with the failures from
 * the exact verify:live job the spare drill inspected.
 *
 * A pure spare run must carry SPARED_LIVE_REASON. A mixed run intentionally
 * leaves reason unset so the spare-path condition cannot hide the unrelated
 * regression. The caller still surfaces that non-spare failure from the same
 * job log; it simply does not misdiagnose the null reason as a propagation bug.
 * Everything else is invalid for this drill.
 */
export function assessSpareStatusReason(reason, failureMessages) {
  const spareFailures = failureMessages.filter((message) =>
    message.includes(SPARED_LIVE_SESSION_SIGNATURE),
  );
  const otherFailures = failureMessages.filter((message) =>
    !message.includes(SPARED_LIVE_SESSION_SIGNATURE),
  );

  if (
    reason === SPARED_LIVE_REASON &&
    spareFailures.length > 0 &&
    otherFailures.length === 0
  ) {
    return { kind: 'spare-only', spareFailures, otherFailures };
  }

  if (reason == null && spareFailures.length > 0 && otherFailures.length > 0) {
    return { kind: 'mixed', spareFailures, otherFailures };
  }

  return { kind: 'invalid', spareFailures, otherFailures };
}
