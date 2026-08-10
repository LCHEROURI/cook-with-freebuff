'use client';

import type { VoiceStatus } from '@/lib/agent';

const LABELS: Record<VoiceStatus, string> = {
  LISTENING: 'Listening…',
  THINKING: 'Thinking…',
  SPEAKING: 'Speaking…',
  OFFLINE: 'Offline',
  ERROR: 'Error',
};

export function VoiceIndicator({ status }: { status: VoiceStatus }) {
  return (
    <div className="voice-indicator" data-status={status} role="status" aria-live="polite">
      <span className="voice-dot" aria-hidden="true" />
      <span className="voice-label">{LABELS[status]}</span>
    </div>
  );
}