import { describe, it, expect } from 'vitest';
import { nextVoiceStatus } from './voice-status';

describe('nextVoiceStatus', () => {
  it('runs the full happy-path cycle', () => {
    let s = nextVoiceStatus('OFFLINE', 'RECONNECTED');
    expect(s).toBe('LISTENING');
    s = nextVoiceStatus(s, 'USER_SPEAKING');
    expect(s).toBe('LISTENING');
    s = nextVoiceStatus(s, 'UTTERANCE_SENT');
    expect(s).toBe('THINKING');
    s = nextVoiceStatus(s, 'AGENT_RESPONSE');
    expect(s).toBe('SPEAKING');
    s = nextVoiceStatus(s, 'AGENT_FINISHED');
    expect(s).toBe('LISTENING');
  });

  it('enters ERROR on failure', () => {
    expect(nextVoiceStatus('THINKING', 'ERROR')).toBe('ERROR');
  });

  it('enters OFFLINE on disconnect and recovers', () => {
    expect(nextVoiceStatus('SPEAKING', 'DISCONNECTED')).toBe('OFFLINE');
    expect(nextVoiceStatus('OFFLINE', 'RECONNECTED')).toBe('LISTENING');
  });
});