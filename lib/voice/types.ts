// ─────────────────────────────────────────────────────────────────────────────
// Realtime voice — provider interface
//
// Abstraction over WebRTC speech-to-speech streaming so the conversation
// layer never depends on a specific vendor. The Gemini Live implementation
// lives in gemini-live.ts; a stub can drive text-only flows.
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export interface VoiceConnectOptions {
  apiKey?: string;
  model?: string;
  audioSampleRate?: number;
}

export interface VoiceTranscriptEvent {
  type: 'partial' | 'final';
  text: string;
}

export interface VoiceSessionEventMap {
  status: VoiceConnectionStatus;
  transcript: VoiceTranscriptEvent;
  agentSpeech: string;
  error: Error;
}

/**
 * A realtime voice session: capture mic audio, stream to a speech-to-speech
 * provider, receive spoken responses.
 */
export interface RealtimeVoiceProvider {
  connect(opts: VoiceConnectOptions): Promise<void>;
  disconnect(): void;
  startListening(): void;
  stopListening(): void;
  /** Speak a text response locally (text-to-speech fallback). */
  speak(text: string): void;
  on<K extends keyof VoiceSessionEventMap>(
    event: K,
    listener: (payload: VoiceSessionEventMap[K]) => void,
  ): () => void;
}