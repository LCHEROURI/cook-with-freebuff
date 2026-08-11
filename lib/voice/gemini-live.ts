// ─────────────────────────────────────────────────────────────────────────────
// Gemini Live — realtime speech client (browser only)
//
// First-party voice: the browser streams mic audio straight to Gemini over a
// WebSocket, and Gemini replies with audio + text transcriptions. NO vendor
// hand-off of audio (unlike the Web Speech fallback).
//
// Auth: the browser NEVER holds GOOGLE_AI_API_KEY. The server mints a
// short-lived, single-use ephemeral token at /api/voice/token; this client
// connects to BidiGenerateContentConstrained with ?access_token=<token>.
//
// Tool use: the model proposes functionCalls (same declarations as /api/agent,
// from lib/ai/tool-declarations). The hook executes them through /api/tools
// (authenticated) and returns results via sendToolResponse — the browser never
// touches application state directly.
//
// All methods are no-op safe in non-browser environments (SSR / tests).
// ─────────────────────────────────────────────────────────────────────────────

export const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const DEFAULT_TOKEN_URL = '/api/voice/token';

/** Live input format: raw 16-bit PCM, mono, 16 kHz. Output is 24 kHz. */
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

export type GeminiLiveStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export interface GeminiLiveFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiLiveFunctionResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiLiveEventMap {
  status: GeminiLiveStatus;
  transcript: { type: 'partial' | 'final'; text: string };
  agentSpeech: string;
  turn: { kind: 'start' | 'end' };
  toolcall: { functionCalls: GeminiLiveFunctionCall[] };
  error: Error;
}

/** Minimal structural WebSocket — lets tests inject a fake. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface GeminiLiveDeps {
  createWebSocket?: (url: string) => WebSocketLike;
  getUserMedia?: () => Promise<MediaStream>;
  createAudioContext?: () => AudioContextLike;
}

/** Minimal AudioContext surface used by the client (jsdom-safe). */
export interface AudioContextLike {
  sampleRate: number;
  createMediaStreamSource(stream: MediaStream): AudioNodeLike;
  createScriptProcessor(bufferSize: number, inCh: number, outCh: number): ScriptProcessorLike;
  createGain(): { gain: { value: number }; connect(n: AudioNodeLike): void };
  createBufferSource(): BufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  destination: AudioNodeLike;
  close(): Promise<void>;
}

export interface AudioNodeLike {
  connect(node: AudioNodeLike): void;
  disconnect?(): void;
}

export interface ScriptProcessorLike extends AudioNodeLike {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface GeminiLiveOptions {
  tokenUrl?: string;
  getToken?: () => Promise<string | null> | string | null;
  model?: string;
  systemInstruction?: string;
  /** Gemini function declarations (lib/ai/tool-declarations). */
  tools?: readonly unknown[];
  deps?: GeminiLiveDeps;
}

export class GeminiLiveClient {
  private ws: WebSocketLike | null = null;
  private status: GeminiLiveStatus = 'DISCONNECTED';
  private listeners = new Map<keyof GeminiLiveEventMap, Set<(p: never) => void>>();

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContextLike | null = null;
  private processor: ScriptProcessorLike | null = null;

  private playbackQueue: ArrayBuffer[] = [];
  private playing = false;
  private currentSource: BufferSourceLike | null = null;
  private playbackCtx: AudioContextLike | null = null;

  constructor(private readonly opts: GeminiLiveOptions = {}) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  on<K extends keyof GeminiLiveEventMap>(
    event: K,
    listener: (payload: GeminiLiveEventMap[K]) => void,
  ): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (p: never) => void);
    return () => this.listeners.get(event)?.delete(listener as (p: never) => void);
  }

  private emit<K extends keyof GeminiLiveEventMap>(event: K, payload: GeminiLiveEventMap[K]): void {
    this.status = event === 'status' ? (payload as GeminiLiveStatus) : this.status;
    this.listeners.get(event)?.forEach((l) => l(payload as never));
  }

  /**
   * Mint an ephemeral token, open the constrained WebSocket, and send the
   * session setup (model, audio-only modality, system instruction, tools,
   * transcriptions). Resolves once the socket is open; CONNECTED fires when
   * the server acks with setupComplete.
   */
  async connect(): Promise<void> {
    this.emit('status', 'CONNECTING');
    const token = await this.mintToken();
    if (!token) return;

    // The ephemeral token is server-issued (letters/digits/slash/dash) and is
    // consumed verbatim as the access_token query param — verified working
    // against the live endpoint without percent-encoding.
    const model = this.opts.model ?? DEFAULT_LIVE_MODEL;
    const url = `${LIVE_WS_URL}?access_token=${token}`;
    let ws: WebSocketLike;
    try {
      ws = this.opts.deps?.createWebSocket
        ? this.opts.deps.createWebSocket(url)
        : (new WebSocket(url) as unknown as WebSocketLike);
    } catch {
      this.fail('Could not open the voice connection.');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ['AUDIO'] },
          ...(this.opts.systemInstruction
            ? { systemInstruction: { parts: [{ text: this.opts.systemInstruction }] } }
            : {}),
          ...(this.opts.tools && this.opts.tools.length > 0
            ? { tools: [{ functionDeclarations: [...this.opts.tools] }] }
            : {}),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.teardownMic();
        this.ws = null;
        this.emit('status', 'DISCONNECTED');
      }
    };
    ws.onerror = () => {
      // The close event follows with the real reason; surface a plain error
      // in case it never arrives.
      this.emit('error', new Error('The voice connection dropped.'));
    };
    ws.onmessage = (e) => this.handleMessage(e.data);
  }

  /** Send a text utterance into the live session (replaces speaking). */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.connected) return;
    this.send({ realtimeInput: { text: trimmed } });
  }

  /** Return tool results so the model can synthesize its spoken reply. */
  sendToolResponse(responses: GeminiLiveFunctionResponse[]): void {
    if (!this.connected || responses.length === 0) return;
    this.send({ toolResponse: { functionResponses: responses } });
  }

  /** Begin mic capture and stream 16 kHz PCM to the session. */
  async startListening(): Promise<void> {
    if (!this.connected) return;
    const deps = this.opts.deps ?? {};
    const getUserMedia = deps.getUserMedia ?? (async () => navigator.mediaDevices.getUserMedia({ audio: true }));
    const createCtx =
      deps.createAudioContext ??
      (() => {
        const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) throw new Error('Web Audio unavailable');
        return new Ctor();
      });

    try {
      const stream = await getUserMedia();
      const ctx = createCtx();
      this.mediaStream = stream;
      this.audioContext = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      this.processor = processor;
      const inputRate = ctx.sampleRate;

      processor.onaudioprocess = (e) => {
        const channel = e.inputBuffer.getChannelData(0);
        const chunk = resample(channel, inputRate, INPUT_RATE);
        if (chunk.length === 0) return;
        const pcm = floatTo16BitPCM(chunk);
        this.send({
          realtimeInput: { audio: { data: pcmToBase64(pcm), mimeType: 'audio/pcm;rate=16000' } },
        });
      };

      // ScriptProcessor only fires while wired into the destination graph; a
      // zero-gain node keeps it alive without audible self-monitoring.
      const zero = ctx.createGain();
      zero.gain.value = 0;
      source.connect(processor);
      processor.connect(zero);
      zero.connect(ctx.destination);
    } catch {
      this.teardownMic();
      this.fail('Microphone unavailable — check your browser permission.');
    }
  }

  /** Pause mic capture (audioStreamEnd flushes cached audio server-side). */
  stopListening(): void {
    if (this.connected) this.send({ realtimeInput: { audioStreamEnd: true } });
    this.teardownMic();
  }

  disconnect(): void {
    this.stopPlayback();
    this.teardownMic();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.emit('status', 'DISCONNECTED');
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async mintToken(): Promise<string | null> {
    const tokenUrl = this.opts.tokenUrl ?? DEFAULT_TOKEN_URL;
    const getToken = this.opts.getToken ?? (() => null);
    try {
      const bearer = await getToken();
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      });
      const body = (await res.json()) as {
        success?: boolean;
        data?: { token?: unknown };
      };
      if (!res.ok || !body.success || typeof body.data?.token !== 'string' || body.data.token.length === 0) {
        this.fail('Could not start a voice session.');
        return null;
      }
      return body.data.token;
    } catch {
      this.fail('Could not reach the voice service.');
      return null;
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.connected) return;
    try {
      this.ws!.send(JSON.stringify(obj));
    } catch {
      this.fail('The voice connection failed.');
    }
  }

  private fail(message: string): void {
    this.emit('error', new Error(message));
    this.emit('status', 'ERROR');
  }

  private async handleMessage(data: unknown): Promise<void> {
    const raw = await decodeFrame(data);
    if (!raw || !raw.startsWith('{')) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.setupComplete !== undefined) {
      this.emit('status', 'CONNECTED');
      return;
    }

    const sc = msg.serverContent as
      | {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          interrupted?: boolean;
          turnComplete?: boolean;
          modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
        }
      | undefined;
    if (sc) {
      if (sc.inputTranscription?.text) {
        this.emit('transcript', { type: 'final', text: sc.inputTranscription.text });
        this.emit('turn', { kind: 'start' });
      }
      if (sc.outputTranscription?.text) {
        this.emit('agentSpeech', sc.outputTranscription.text);
      }
      if (sc.interrupted) {
        this.stopPlayback();
      }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.queuePlayback(part.inlineData.data);
      }
      if (sc.turnComplete) {
        this.emit('turn', { kind: 'end' });
      }
    }

    const toolCall = msg.toolCall as
      | { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] }
      | undefined;
    if (toolCall?.functionCalls?.length) {
      this.emit('toolcall', {
        functionCalls: toolCall.functionCalls
          .filter((fc) => typeof fc.id === 'string' && typeof fc.name === 'string')
          .map((fc) => ({
            id: fc.id as string,
            name: fc.name as string,
            args: fc.args ?? {},
          })),
      });
    }
  }

  // ── Mic teardown ───────────────────────────────────────────────────────────

  private teardownMic(): void {
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    try {
      void this.audioContext?.close();
    } catch {
      // already closed
    }
    this.audioContext = null;
    this.processor = null;
  }

  // ── Audio playback (24 kHz PCM16 → AudioContext) ───────────────────────────

  private queuePlayback(base64: string): void {
    try {
      const bin = atob(base64);
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      this.playbackQueue.push(buf);
      void this.drainPlayback();
    } catch {
      // Malformed audio frame — skip rather than kill the session.
    }
  }

  private async drainPlayback(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.playbackQueue.length > 0) {
        const chunk = this.playbackQueue.shift()!;
        const ctx = this.getPlaybackContext();
        if (!ctx) break;
        let audio: AudioBuffer;
        try {
          audio = await ctx.decodeAudioData(chunk);
        } catch {
          // Raw 24 kHz PCM16 — decodeAudioData rejects containerless frames,
          // so we decode the PCM directly.
          audio = decodePcmToAudioBuffer(ctx, chunk, OUTPUT_RATE) as unknown as AudioBuffer;
        }
        await playBuffer(ctx, audio, (src) => (this.currentSource = src));
      }
    } finally {
      this.playing = false;
    }
  }

  private getPlaybackContext(): AudioContextLike | null {
    if (this.playbackCtx) return this.playbackCtx;
    const createCtx = this.opts.deps?.createAudioContext;
    if (!createCtx) {
      const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return null;
      this.playbackCtx = new Ctor();
    } else {
      this.playbackCtx = createCtx();
    }
    return this.playbackCtx;
  }

  private stopPlayback(): void {
    try {
      this.currentSource?.stop();
    } catch {
      // not started
    }
    this.currentSource = null;
    this.playbackQueue = [];
  }
}

// ── Frame / audio helpers (exported for unit tests) ──────────────────────────

export async function decodeFrame(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return data;
  // Duck-typed Blob check — browsers expose text(); jsdom's older Blob does
  // not, so fall back to FileReader for the same shape.
  if (data && typeof data === 'object') {
    const blob = data as Blob;
    if (typeof blob.text === 'function') return blob.text();
    if (typeof blob.arrayBuffer === 'function') {
      const buf = await blob.arrayBuffer();
      return new TextDecoder().decode(new Uint8Array(buf));
    }
    if (typeof blob.size === 'number' && typeof FileReader !== 'undefined') {
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result ?? ''));
        fr.onerror = () => reject(new Error('Frame read failed'));
        fr.readAsText(blob);
      });
    }
  }
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

/** Linear-interpolation resample — fine for voice-bandwidth audio. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = input[Math.min(idx + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcmToBase64(pcm: Int16Array): string {
  let binary = '';
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    binary += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
  }
  return btoa(binary);
}

export function decodePcmToAudioBuffer(
  ctx: AudioContextLike,
  chunk: ArrayBuffer,
  rate: number,
): Pick<AudioBuffer, 'getChannelData' | 'duration' | 'sampleRate' | 'numberOfChannels' | 'length'> {
  const int16 = new Int16Array(chunk);
  const float = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;
  return {
    sampleRate: rate,
    get duration() {
      return float.length / rate;
    },
    get length() {
      return float.length;
    },
    get numberOfChannels() {
      return 1;
    },
    getChannelData(_c: number) {
      return float;
    },
  };
}

function playBuffer(
  ctx: AudioContextLike,
  audio: AudioBuffer,
  setSource: (src: BufferSourceLike) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.onended = () => resolve();
    src.connect(ctx.destination);
    setSource(src);
    try {
      src.start();
    } catch {
      resolve();
    }
  });
}
