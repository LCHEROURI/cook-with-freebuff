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
/** Hard-fail deadline for connect() — see GeminiLiveOptions.connectTimeoutMs. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

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
  /** Live speech energy: true while the user is actually speaking (RMS above
   *  the speech threshold), false after a short silence gap. Lets the UI show
   *  a "hearing you" recording bar that differs from the waiting pulse. */
  hearing: boolean;
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

/**
 * Session state snapshot for diagnosing a dropped/never-starting mic. Returned
 * by GeminiLiveClient.getDiagnostics() and surfaced to the user via the
 * "copy voice details" affordance in the mic UI.
 */
export interface VoiceSessionDiagnostics {
  tokenHttpStatus: number | null;
  tokenError: string | null;
  wsOpens: number;
  wsCloses: number;
  wsLastCloseCode: number | null;
  wsErrors: number;
  transcripts: number;
  agentSpeech: number;
  turnCompletes: number;
  flushesSent: number;
  framesSent: number;
  playbackStalls: number;
  /** The effective connect deadline in use (see connectTimeoutMs). */
  connectTimeoutMs: number;
  micStarted: boolean;
  micError: string | null;
  lastError: string | null;
  hearing: boolean;
  connected: boolean;
  playing: boolean;
  playbackQueueLength: number;
}

export interface GeminiLiveOptions {
  tokenUrl?: string;
  getToken?: () => Promise<string | null> | string | null;
  model?: string;
  systemInstruction?: string;
  /** Gemini function declarations (lib/ai/tool-declarations). */
  tools?: readonly unknown[];
  /** Reply modality. Default ['AUDIO'] (spoken replies); dictation uses ['TEXT']. */
  responseModalities?: Array<'AUDIO' | 'TEXT'>;
  /**
   * End-of-utterance flush: after this much trailing silence (ms), the client
   * sends `audioStreamEnd` once so the server emits the pending FINAL input
   * transcription. The Live server holds the utterance until the stream ends.
   * Default 1200; 0 disables the auto-flush (stopListening/disconnect still
   * flush).
   */
  flushOnSilenceMs?: number;
  /**
   * Hard-fail deadline for connect(): if the session has not reached
   * CONNECTED (token mint + socket open + setup ack) within this many ms,
   * the client fails with a clear reason instead of hanging on a silent
   * drop (missing key, blocked WebSocket, unresponsive server). Default
   * DEFAULT_CONNECT_TIMEOUT_MS (5000).
   */
  connectTimeoutMs?: number;
  deps?: GeminiLiveDeps;
}

export class GeminiLiveClient {
  private ws: WebSocketLike | null = null;
  private status: GeminiLiveStatus = 'DISCONNECTED';
  private listeners = new Map<keyof GeminiLiveEventMap, Set<(p: never) => void>>();

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContextLike | null = null;
  private processor: ScriptProcessorLike | null = null;

  // End-of-utterance flush state (see startListening): the Live server holds
  // the current utterance's audio and only emits the FINAL input transcription
  // once the stream ends (`audioStreamEnd`), so after each trailing silence the
  // client sends one flush. The state re-arms on turnComplete/interrupted — a
  // fresh utterance gets its OWN flush, so a continuous conversation never
  // dies after the first burst (seen live: one-shot flush = second utterance
  // never transcribed). 0 in flushLastSpeechMs means "no speech since the last
  // re-arm" — a flush must never fire on silence alone.
  private flushLastSpeechMs = 0;
  private flushSent = false;

  private playbackQueue: ArrayBuffer[] = [];
  private playing = false;
  private currentSource: BufferSourceLike | null = null;
  private playbackCtx: AudioContextLike | null = null;

  // Live speech-energy state (see the hearing event): the timestamp of the
  // last frame with real signal, so "hearing you" stays true across the short
  // pauses inside a sentence and only drops after a real silence gap.
  private lastSpeechAt = 0;
  private hearing = false;

  // Connect hard-fail watchdog (see connectTimeoutMs): fires if the session
  // never reaches CONNECTED in time, so a missing key or blocked WebSocket
  // becomes a visible error instead of an endless "Listening…".
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  // Playback-stall watchdog: the mic is muted while the model's reply plays,
  // so a reply whose audio never finishes (browser blocked playback, a stuck
  // source) would leave the mic muted forever — the reported "first burst
  // transcribed, then the mic goes dead" signature. If playback has been
  // "playing" longer than this without draining, force it down.
  private playbackStartedAt = 0;
  private readonly PLAYBACK_STALL_MS = 15000;

  // Session diagnostics — populated at every lifecycle point so a dropped mic
  // can be diagnosed from the client alone (see getDiagnostics).
  private diag: VoiceSessionDiagnostics = {
    tokenHttpStatus: null,
    tokenError: null,
    wsOpens: 0,
    wsCloses: 0,
    wsLastCloseCode: null,
    wsErrors: 0,
    transcripts: 0,
    agentSpeech: 0,
    turnCompletes: 0,
    flushesSent: 0,
    framesSent: 0,
    playbackStalls: 0,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    micStarted: false,
    micError: null,
    lastError: null,
    hearing: false,
    connected: false,
    playing: false,
    playbackQueueLength: 0,
  };

  constructor(private readonly opts: GeminiLiveOptions = {}) {}

  getDiagnostics(): VoiceSessionDiagnostics {
    return {
      ...this.diag,
      connectTimeoutMs: this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      hearing: this.hearing,
      connected: this.connected,
      playing: this.playing,
      playbackQueueLength: this.playbackQueue.length,
    };
  }

  private setHearing(value: boolean): void {
    if (this.hearing === value) return;
    this.hearing = value;
    this.emit('hearing', value);
  }

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
    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.connectTimer = setTimeout(() => {
      if (this.status === 'CONNECTED' || this.status === 'ERROR') return;
      const socketOpened = this.ws !== null && this.ws.readyState === 1;
      this.fail(
        socketOpened
          ? 'Gemini Live did not respond — the voice service may be blocked.'
          : 'Gemini Live could not open the voice connection — a firewall or network may be blocking it.',
      );
    }, timeoutMs);
    const token = await this.mintToken();
    // A failure (including the connect timeout firing while the token fetch
    // hung) has already emitted ERROR — do not keep building the session.
    if (!token || this.status === 'ERROR') return;

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
    this.ws = ws;    ws.onclose = (e: { code?: number; reason?: string }) => {
      this.clearConnectTimer();
      this.diag.wsCloses += 1;
      this.diag.wsLastCloseCode = e.code ?? null;
      // A live session ending on a non-clean close is the first thing to
      // check when the mic "stops working" mid-conversation.
      if (e.code !== undefined && e.code !== 1000 && e.code !== 1001) {
        console.error(`[voice] WebSocket closed with code ${e.code} (${e.reason ?? 'no reason'})`);
      }
      if (this.ws === ws) {
        this.teardownMic();
        this.ws = null;
        this.emit('status', 'DISCONNECTED');
      }
    };
    ws.onopen = () => {
      this.diag.wsOpens += 1;
      this.send({
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: this.opts.responseModalities ?? ['AUDIO'] },
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
    ws.onerror = () => {
      this.diag.wsErrors += 1;
      // The close event follows with the real reason; surface a plain error
      // in case it never arrives.
      console.error('[voice] WebSocket error — the voice connection dropped.');
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
      this.diag.micStarted = true;
      this.diag.micError = null;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      this.processor = processor;
      const inputRate = ctx.sampleRate;

      // End-of-utterance flush: the Live server holds the current utterance's
      // audio in a buffer and only emits the FINAL input transcription once
      // the stream ends (`audioStreamEnd`). Without a flush the dictation
      // hook would wait forever for a transcript that never comes (seen live:
      // 147 audio frames streamed, 0 inputTranscriptions, then the quiet
      // timeout bailed). Track the last frame with real signal and, after a
      // short trailing silence (default 1.2s), send `audioStreamEnd` once so
      // the transcription lands ~1-2s after the user stops speaking. The
      // state is instance-level so turnComplete/interrupted can re-arm it
      // (handleMessage) — every utterance, not just the first, gets flushed.
      const flushSilenceMs = this.opts.flushOnSilenceMs ?? 1200;
      // Same speech threshold drives the flush and the "hearing you" state.
      const SPEECH_RMS = 0.012;
      const HEARING_GAP_MS = 300;
      this.flushLastSpeechMs = 0;
      this.flushSent = false;

      processor.onaudioprocess = (e) => {
        // While the model's reply is playing back, don't stream the mic at
        // all: the speaker's echo would otherwise reach the server's VAD as a
        // phantom user turn (the reply playing from the speakers IS "speech"
        // to the mic). Capture resumes the moment playback drains.
        if (this.playing || this.playbackQueue.length > 0) {
          // Stall watchdog: if the reply's audio never finishes (browser
          // blocked the playback, the source never ended), the mute above
          // would hold the mic hostage forever. Force the playback down so
          // capture resumes and the user can speak again.
          if (
            this.playing &&
            this.playbackStartedAt > 0 &&
            Date.now() - this.playbackStartedAt > this.PLAYBACK_STALL_MS
          ) {
            this.diag.playbackStalls += 1;
            console.error('[voice] reply playback stalled — forcing the mic back on');
            this.stopPlayback();
            this.playing = false;
            this.playbackStartedAt = 0;
            this.flushLastSpeechMs = 0;
            this.setHearing(false);
          }
          return;
        }
        const channel = e.inputBuffer.getChannelData(0);
        let rms = 0;
        for (let i = 0; i < channel.length; i++) rms += channel[i] * channel[i];
        rms = Math.sqrt(rms / channel.length);
        if (rms > SPEECH_RMS) {
          this.flushLastSpeechMs = Date.now();
          this.lastSpeechAt = Date.now();
          this.setHearing(true);
        } else if (this.hearing && Date.now() - this.lastSpeechAt > HEARING_GAP_MS) {
          this.setHearing(false);
        }
        const chunk = resample(channel, inputRate, INPUT_RATE);
        if (chunk.length === 0) return;      const pcm = floatTo16BitPCM(chunk);
        this.send({
          realtimeInput: { audio: { data: pcmToBase64(pcm), mimeType: 'audio/pcm;rate=16000' } },
        });
        this.diag.framesSent += 1;
        // Only flush when real speech was heard since the last re-arm — a
        // flush on empty silence would consume the one-shot before the user
        // ever spoke and kill the first real utterance.
        if (
          !this.flushSent &&
          this.flushLastSpeechMs > 0 &&
          flushSilenceMs > 0 &&
          Date.now() - this.flushLastSpeechMs >= flushSilenceMs
        ) {
          this.flushSent = true;
          this.diag.flushesSent += 1;
          this.send({ realtimeInput: { audioStreamEnd: true } });
        }
      };

      // ScriptProcessor only fires while wired into the destination graph; a
      // zero-gain node keeps it alive without audible self-monitoring.
      const zero = ctx.createGain();
      zero.gain.value = 0;
      source.connect(processor);
      processor.connect(zero);
      zero.connect(ctx.destination);
    } catch (e) {
      this.diag.micError = e instanceof Error ? e.message : 'mic capture threw';
      console.error(`[voice] mic capture failed: ${this.diag.micError}`);
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
    this.clearConnectTimer();
    this.stopPlayback();
    // Flush any un-flushed utterance before closing — otherwise the server
    // never emits the pending final input transcription (dictation deadlock
    // seen live: the quiet-timeout path called disconnect() and the spoken
    // prompt never landed in the input).
    if (this.connected && this.processor) this.send({ realtimeInput: { audioStreamEnd: true } });
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
      this.diag.tokenHttpStatus = res.status;
      const body = (await res.json()) as {
        success?: boolean;
        data?: { token?: unknown };
      };
      if (!res.ok || !body.success || typeof body.data?.token !== 'string' || body.data.token.length === 0) {
        this.diag.tokenError = `token endpoint rejected (HTTP ${res.status})`;
        console.error(`[voice] token endpoint rejected (HTTP ${res.status})`);
        this.fail('Could not start a voice session.');
        return null;
      }
      return body.data.token;
    } catch (e) {
      this.diag.tokenError = e instanceof Error ? e.message : 'token fetch threw';
      console.error(`[voice] token endpoint unreachable: ${this.diag.tokenError}`);
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
    this.clearConnectTimer();
    this.diag.lastError = message;
    this.emit('error', new Error(message));
    this.emit('status', 'ERROR');
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Allow the end-of-utterance flush to fire again for the next utterance. */
  private rearmFlush(): void {
    this.flushLastSpeechMs = 0;
    this.flushSent = false;
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
      this.clearConnectTimer();
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
        this.diag.transcripts += 1;
        this.emit('transcript', { type: 'final', text: sc.inputTranscription.text });
        this.emit('turn', { kind: 'start' });
      }
      if (sc.outputTranscription?.text) {
        this.diag.agentSpeech += 1;
        this.emit('agentSpeech', sc.outputTranscription.text);
      }
      if (sc.interrupted) {
        this.stopPlayback();
      }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.queuePlayback(part.inlineData.data);
      }
      if (sc.turnComplete) {
        this.diag.turnCompletes += 1;
        // The turn is over — the user may speak again. Re-arm the flush so
        // the NEXT utterance gets its own audioStreamEnd instead of the
        // one-shot flush leaving every later burst untranscribed.
        this.rearmFlush();
        this.emit('turn', { kind: 'end' });
      }
      // A barge-in cuts the current exchange — the next utterance is a fresh
      // turn and needs its own flush too.
      if (sc.interrupted) this.rearmFlush();
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
    this.setHearing(false);
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
    // Playback mutes the mic (see onaudioprocess) — the model's reply is not
    // "the user hearing", so drop the hearing state the moment it starts.
    if (this.playbackQueue.length === 0) this.setHearing(false);
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
    this.playbackStartedAt = Date.now();
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
      // The model's reply just finished — forget any echo of it the mic
      // picked up, so the next flush timer only starts from the user's own
      // next speech, never from the tail of the reply.
      if (this.playbackQueue.length === 0) this.flushLastSpeechMs = 0;
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
