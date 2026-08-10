// ─────────────────────────────────────────────────────────────────────────────
// Voice-status state machine (pure)
//
// LISTENING → THINKING → SPEAKING → LISTENING, plus OFFLINE / ERROR states.
// The UI hook is a thin wrapper over this — the transitions are testable here.
// ─────────────────────────────────────────────────────────────────────────────

import type { VoiceStatus, VoiceEvent } from './types';

export function nextVoiceStatus(current: VoiceStatus, event: VoiceEvent): VoiceStatus {
  switch (event) {
    case 'USER_SPEAKING':
      return 'LISTENING';
    case 'UTTERANCE_SENT':
      return 'THINKING';
    case 'AGENT_RESPONSE':
      return 'SPEAKING';
    case 'AGENT_FINISHED':
      return 'LISTENING';
    case 'ERROR':
      return 'ERROR';
    case 'DISCONNECTED':
      return 'OFFLINE';
    case 'RECONNECTED':
      return 'LISTENING';
    default:
      return current;
  }
}

/** The full happy-path cycle. */
export function fullTurnCycle(): VoiceStatus[] {
  return ['LISTENING', 'THINKING', 'SPEAKING', 'LISTENING'];
}