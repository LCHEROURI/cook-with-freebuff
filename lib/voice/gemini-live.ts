// ─────────────────────────────────────────────────────────────────────────────
// Gemini Live — realtime speech-to-speech provider (browser only)
//
// This module is a browser-only skeleton: it wires the WebSocket + audio
// plumbing against the Gemini Live API shape so K9 can finish the media
// codecs. Every method is guarded to be a safe no-op in non-browser
// environments (SSR / tests).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  RealtimeVoiceProvider,
  VoiceConnectOptions,
  VoiceConnectionStatus,
  VoiceSessionEventMap,
} from './types';

const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined';
}

export class GeminiLiveVoiceProvider implements RealtimeVoiceProvider {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private listeners = new Map<keyof VoiceSessionEventMap, Set<(p: unknown) => void>>();

  async connect(opts: VoiceConnectOptions): Promise<void> {
    if (!isBrowser()) return;
    const key = opts.apiKey ?? process.env.NEXT_PUBLIC_GOOGLE_AI_API_KEY;
    if (!key) {
      this.emit('status', 'ERROR');
      return;
    }

    this.emit('status', 'CONNECTING');
    const url = `${LIVE_WS}?key=${encodeURIComponent(key)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.emit('status', 'CONNECTED');
      // Setup audio input once connected.
      void this.setupAudio();
    };
    this.ws.onclose = () => this.emit('status', 'DISCONNECTED');
    this.ws.onerror = (e) => this.emit('error', e instanceof Error ? e : new Error('WebSocket error'));
    this.ws.onmessage = (event) => {
      // Parse provider message; transcribed text surfaces as transcript events.
      try {
        const data = JSON.parse(String(event.data));
        const text = data?.content?.parts?.map((p: { text?: string }) => p.text).filter(Boolean).join(' ');
        if (text) this.emit('agentSpeech', text);
      } catch {
        // Non-JSON frames (audio) ignored in this skeleton.
      }
    };
  }

  disconnect(): void {
    if (!isBrowser()) return;
    this.ws?.close();
    this.ws = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.emit('status', 'DISCONNECTED');
  }

  startListening(): void {
    // In the full implementation this resumes audio capture + streaming.
  }

  stopListening(): void {
    // In the full implementation this pauses audio capture.
  }

  speak(text: string): void {
    // Text-to-speech fallback — speech synthesis is wired here in K9.
    this.emit('agentSpeech', text);
  }

  on<K extends keyof VoiceSessionEventMap>(
    event: K,
    listener: (payload: VoiceSessionEventMap[K]) => void,
  ): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (p: unknown) => void);
    return () => this.listeners.get(event)?.delete(listener as (p: unknown) => void);
  }

  private emit<K extends keyof VoiceSessionEventMap>(event: K, payload: VoiceSessionEventMap[K]): void {
    this.listeners.get(event)?.forEach((l) => l(payload));
  }

  private async setupAudio(): Promise<void> {
    if (!isBrowser() || !navigator.mediaDevices?.getUserMedia) return;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // AudioWorklet / encoder wiring is filled in during K9 (voice QA).
    } catch {
      this.emit('status', 'ERROR');
    }
  }
}

/** No-op provider for non-browser environments / text-only flows. */
export class NoopVoiceProvider implements RealtimeVoiceProvider {
  async connect(): Promise<void> {}
  disconnect(): void {}
  startListening(): void {}
  stopListening(): void {}
  speak(text: string): void {}
  on(): () => void {
    return () => undefined;
  }
}