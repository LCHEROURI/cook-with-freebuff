// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  GeminiLiveClient,
  LIVE_WS_URL,
  decodeFrame,
  resample,
  floatTo16BitPCM,
  pcmToBase64,
  type WebSocketLike,
} from './gemini-live';

// ============================================================================
// lib/voice/gemini-live.test.ts — the raw Live protocol, locked with a fake
// WebSocket: ephemeral-token mint → constrained-URL connect → setup → text /
// transcripts / tool calls → toolResponse → audio streaming → teardown.
// ============================================================================

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // 0 CONNECTING → 1 OPEN
  sent: string[] = [];
  closed = false;
  url: string;
  onopen: (() => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  async receive(obj: unknown) {
    const h = this.onmessage;
    if (h) await h({ data: JSON.stringify(obj) });
  }
  async receiveBlob(obj: unknown) {
    const h = this.onmessage;
    if (h) await h({ data: new Blob([JSON.stringify(obj)], { type: 'application/json' }) });
  }
}

const TOKEN = 'auth_tokens/test123';

function mintOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { token: TOKEN } }),
    }),
  );
}

// The client only constructs its WebSocket inside connect(), so the fake is
// read lazily AFTER the connect call.
function setupClient(opts: Record<string, unknown> = {}) {
  const client = new GeminiLiveClient({
    getToken: () => 'bearer-tok',
    systemInstruction: 'You are the Kitchen Agent.',
    tools: [{ name: 'get_pantry', description: 'Pantry', parameters: { type: 'OBJECT', properties: {} } }],
    deps: { createWebSocket: (url) => new FakeWebSocket(url) },
    ...opts,
  } as ConstructorParameters<typeof GeminiLiveClient>[0]);
  const getWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  return { client, getWs };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GeminiLiveClient — connect + setup', () => {
  it('mints a token, opens the CONSTRAINED socket with access_token, and sends setup', async () => {
    mintOk();
    const { client, getWs } = setupClient();
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));

    await client.connect();
    const ws = getWs();
    expect(ws.url).toBe(`${LIVE_WS_URL}?access_token=${TOKEN}`);
    expect(statuses).toContain('CONNECTING');

    ws.open();
    const setupMsg = JSON.parse(ws.sent[0]) as {
      setup: { model: string; generationConfig: { responseModalities: string[] }; systemInstruction: { parts: { text: string }[] }; tools: unknown[]; inputAudioTranscription: object; outputAudioTranscription: object };
    };
    expect(setupMsg.setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setupMsg.setup.systemInstruction.parts[0].text).toContain('Kitchen Agent');
    expect(setupMsg.setup.tools).toEqual([
      { functionDeclarations: [{ name: 'get_pantry', description: 'Pantry', parameters: { type: 'OBJECT', properties: {} } }] },
    ]);
    expect(setupMsg.setup.inputAudioTranscription).toBeDefined();
    expect(setupMsg.setup.outputAudioTranscription).toBeDefined();

    await ws.receive({ setupComplete: {} });
    expect(statuses).toContain('CONNECTED');
    client.disconnect();
  });

  it('uses the model the token endpoint returns (server-authoritative)', async () => {
    // The token route resolves the live model (Remote Config → LIVE_MODEL →
    // default) and the client must connect with what it returned, so a model
    // change needs no client redeploy.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { token: TOKEN, model: 'gemini-9.0-flash-live-preview' } }),
      }),
    );
    const { client, getWs } = setupClient();
    await client.connect();
    const ws = getWs();
    ws.open();
    const setupMsg = JSON.parse(ws.sent[0]) as { setup: { model: string } };
    expect(setupMsg.setup.model).toBe('models/gemini-9.0-flash-live-preview');
    client.disconnect();
  });

  it('sends the Bearer token from getToken to the mint endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { token: TOKEN } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, getWs } = setupClient();
    await client.connect();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/token');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer-tok');
    getWs().close();
  });

  it('fails loudly when the mint returns a non-ok response — no socket is opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ success: false }) }),
    );
    const { client } = setupClient();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    await client.connect();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('refuses to send before the socket is open', async () => {
    mintOk();
    const { client, getWs } = setupClient();
    await client.connect();
    client.sendText('hello');
    expect(getWs().sent).toHaveLength(0);
    client.disconnect();
  });

  it('records a rejected token mint in diagnostics (no socket opened)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ success: false }) }),
    );
    const { client } = setupClient();
    await client.connect();
    const diag = client.getDiagnostics();
    expect(diag.tokenHttpStatus).toBe(503);
    expect(diag.tokenError).toContain('503');
    expect(diag.lastError).toBe('Could not start a voice session.');
    expect(diag.wsOpens).toBe(0);
  });
});

describe('GeminiLiveClient — transcripts, tool calls, responses', () => {
  it('emits final transcripts from inputTranscription and agentSpeech from outputTranscription', async () => {
    mintOk();
    const { client, getWs } = setupClient();
    const transcripts: string[] = [];
    const speeches: string[] = [];
    client.on('transcript', (t) => transcripts.push(`${t.type}:${t.text}`));
    client.on('agentSpeech', (s) => speeches.push(s));
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });

    await ws.receive({
      serverContent: { inputTranscription: { text: 'what is in my pantry' } },
    });
    await ws.receive({
      serverContent: { outputTranscription: { text: 'You have olive oil.' } },
    });
    expect(transcripts).toEqual(['final:what is in my pantry']);
    expect(speeches).toEqual(['You have olive oil.']);
    client.disconnect();
  });

  it('emits toolcall with normalized function calls and streams toolResponse back', async () => {
    mintOk();
    const { client, getWs } = setupClient();
    const calls: unknown[] = [];
    client.on('toolcall', (e) => calls.push(e.functionCalls));
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });

    await ws.receive({
      toolCall: {
        functionCalls: [{ id: 'fc_1', name: 'get_pantry', args: { name: 'oil' } }],
      },
    });
    expect(calls).toEqual([[{ id: 'fc_1', name: 'get_pantry', args: { name: 'oil' } }]]);

    client.sendToolResponse([
      { id: 'fc_1', name: 'get_pantry', response: { success: true, data: { items: ['olive oil'] } } },
    ]);
    const last = JSON.parse(ws.sent[ws.sent.length - 1]) as {
      toolResponse: { functionResponses: { id: string; name: string }[] };
    };
    expect(last.toolResponse.functionResponses[0].id).toBe('fc_1');
    client.disconnect();
  });

  it('emits turn end on turnComplete and handles Blob frames', async () => {
    mintOk();
    const { client, getWs } = setupClient();
    const turns: string[] = [];
    client.on('turn', (t) => turns.push(t.kind));
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receiveBlob({ setupComplete: {} });

    await ws.receiveBlob({ serverContent: { turnComplete: true } });
    expect(turns).toContain('end');
    client.disconnect();
  });
});

describe('GeminiLiveClient — mic capture + playback plumbing', () => {
  it('streams resampled 16 kHz PCM audio from the mic as realtimeInput', async () => {
    mintOk();
    let onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null = null;
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const fakeCtx = {
      sampleRate: 48000,
      createMediaStreamSource: () => ({ connect: () => undefined }),
      createScriptProcessor: () => ({
        connect: () => undefined,
        get onaudioprocess() {
          return procHolder.fn;
        },
        set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
          procHolder.fn = fn;
        },
      }),
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
      createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
      decodeAudioData: async () => {
        throw new Error('raw');
      },
      destination: {},
      close: async () => undefined,
    };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => stream as unknown as MediaStream,
        createAudioContext: () => fakeCtx as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });

    await client.startListening();
    procHolder.fn?.({
      inputBuffer: {
        getChannelData: () => new Float32Array([0, 0.25, -0.5, 0, 1, -1, 0, 0]),
      },
    });

    const audioMsg = ws.sent.find((s) => s.includes('realtimeInput') && s.includes('audio'));
    expect(audioMsg).toBeDefined();
    const parsed = JSON.parse(audioMsg!) as {
      realtimeInput: { audio: { mimeType: string; data: string } };
    };
    expect(parsed.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(parsed.realtimeInput.audio.data.length).toBeGreaterThan(0);

    client.stopListening();
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(true);
    client.disconnect();
  });

  it('stopListening sends audioStreamEnd and disconnecting tears the mic down', async () => {
    mintOk();
    const stopTrack = vi.fn();
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({ connect: () => undefined }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();
    client.disconnect();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('mutes the mic while the model reply plays and resumes after it drains (no echo leak)', async () => {
    // The mic must not stream while the model's audio reply is playing back:
    // the reply coming out of the speakers IS speech to the mic, and the
    // server's VAD would transcribe it as a phantom user turn. Capture
    // resumes the moment the playback queue drains.
    mintOk();
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const createdSources: { src: { onended: (() => void) | null; start: () => void; stop: () => void } | null } = { src: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => {
              const src = {
                buffer: null,
                onended: null as (() => void) | null,
                start: () => undefined,
                stop: () => undefined,
                connect: () => undefined,
              };
              createdSources.src = src;
              return src;
            },
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    const audioFrameCount = () => ws.sent.filter((s) => s.includes('realtimeInput') && s.includes('"audio"')).length;

    // Mic live before any reply: a speech frame streams.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    // The model starts replying: audio arrives and is queued for playback.
    await ws.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa('not really pcm') } }] } },
    });
    // Playback has started (drainPlayback consumed the queue). While it plays,
    // a speech frame must NOT be streamed — that would be the reply's echo.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    // Playback finishes: capture resumes.
    createdSources.src?.onended?.();
    // Allow the drain promise to settle and flip playing=false.
    await new Promise((r) => setTimeout(r, 0));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(2);

    client.disconnect();
  });

  it('emits the playback (mic-paused) event on enqueue and back to false when the queue drains', async () => {
    // The playback event is the client-side signal the UI needs to stop
    // inviting speech into a muted mic — it must fire true the moment a reply
    // frame arrives and false once the reply has finished draining.
    mintOk();
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const createdSources: { src: { onended: (() => void) | null; start: () => void; stop: () => void } | null } = { src: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => {
              const src = {
                buffer: null,
                onended: null as (() => void) | null,
                start: () => undefined,
                stop: () => undefined,
                connect: () => undefined,
              };
              createdSources.src = src;
              return src;
            },
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    const playbackEvents: boolean[] = [];
    client.on('playback', (p) => playbackEvents.push(p));
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    // Reply audio arrives: mic-paused must fire true immediately.
    await ws.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa('not really pcm') } }] } },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(playbackEvents).toContain(true);

    // Reply finishes draining: mic-paused fires false.
    createdSources.src?.onended?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(playbackEvents[playbackEvents.length - 1]).toBe(false);

    client.disconnect();
  });

  it('a broken playback chunk does not leave the mic muted — the queue drains and capture resumes', async () => {
    // If a chunk cannot be scheduled (a broken AudioContext where
    // createBufferSource throws, so playBuffer rejects), the drain must drop
    // it and continue rather than exit mid-queue with the mic muted forever —
    // the captured "playing=false, queue=1, mic paused" stuck state.
    mintOk();
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => {
              throw new Error('broken context');
            },
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    const playbackEvents: boolean[] = [];
    client.on('playback', (p) => playbackEvents.push(p));
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    const audioFrameCount = () => ws.sent.filter((s) => s.includes('realtimeInput') && s.includes('"audio"')).length;
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    // Reply audio arrives — the chunk cannot be scheduled, but the drain must
    // recover instead of leaving the mic muted.
    await ws.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa('not really pcm') } }] } },
    });
    await new Promise((r) => setTimeout(r, 0));
    // Mic-paused fired true on enqueue, then false once the drain recovered.
    expect(playbackEvents).toContain(true);
    expect(playbackEvents[playbackEvents.length - 1]).toBe(false);

    // Capture resumed: a later speech frame streams again.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(2);

    client.disconnect();
  });

  it('forces the mic back on when reply playback stalls and never drains', async () => {
    // If the model's audio reply never finishes (browser blocked the
    // playback, a source that never ends), the mute-during-playback guard
    // would hold the mic hostage forever — the "first burst transcribed,
    // then the mic goes dead" signature. The stall watchdog must force the
    // playback down so capture resumes.
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const createdSources: { src: { onended: (() => void) | null; start: () => void; stop: () => void } | null } = { src: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => {
              const src = {
                buffer: null,
                onended: null as (() => void) | null,
                start: () => undefined,
                stop: () => undefined,
                connect: () => undefined,
              };
              createdSources.src = src;
              return src;
            },
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    const audioFrameCount = () => ws.sent.filter((s) => s.includes('realtimeInput') && s.includes('"audio"')).length;

    // Mic live before any reply.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    // The model replies; the source NEVER ends, so playback stays "playing"
    // and the mic stays muted.
    await ws.receive({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa('not really pcm') } }] } },
    });
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    // 16s later — past the 15s stall threshold — the watchdog fires: the
    // muted frame triggers the force-down (playbackStalls recorded), and the
    // NEXT frame streams again.
    vi.setSystemTime(new Date('2026-01-01T00:00:16Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(client.getDiagnostics().playbackStalls).toBe(1);
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('the watchdog also forces the mic back on when the queue is stuck IDLE (playing=false)', async () => {
    // Second line of defense: the drain re-arm normally clears a stuck queue,
    // but a throttled tab can starve the 100ms timer, leaving playback idle
    // with chunks queued and the mic muted forever. The stall watchdog must
    // catch this state too — it runs per audio frame, not on timers.
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({
              buffer: null,
              onended: null,
              start: () => undefined,
              stop: () => undefined,
              connect: () => undefined,
            }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    const audioFrameCount = () => ws.sent.filter((s) => s.includes('realtimeInput') && s.includes('"audio"')).length;
    // The stuck state is built directly: each public receive would be drained
    // by the re-arm, so construct the exact captured signature — playback
    // idle with chunks still queued.
    const inner = client as unknown as {
      playing: boolean;
      playbackQueue: ArrayBuffer[];
    };

    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);

    inner.playing = false;
    inner.playbackQueue.push(new ArrayBuffer(8), new ArrayBuffer(8));
    // A muted frame starts the stuck timer; capture stays suppressed. The
    // diagnostics blob must expose the stuck state (stuckQueueSince non-zero)
    // so the exact "first burst then dead" signature is visible in a pasted
    // copy-voice-details blob without any console access.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(1);
    expect(client.getDiagnostics().stuckQueueSince).toBeGreaterThan(0);

    // The derived duration is exposed too: 10s into the stuck state the blob
    // shows stuckQueueMs ≈ 10000 — the paste reads "stuck for 10s" with no
    // epoch math, still under the 15s watchdog threshold.
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    expect(client.getDiagnostics().stuckQueueMs).toBe(10000);

    // A drain that restarts (playing=true) has resumed playback, so the
    // leftover stuck timestamp must NOT be reported — a blob copied during a
    // successful retry reads 0/0, never a false "stuck" (Codex P2, PR #3).
    inner.playing = true;
    expect(client.getDiagnostics().stuckQueueSince).toBe(0);
    expect(client.getDiagnostics().stuckQueueMs).toBe(0);
    inner.playing = false;

    // 16s later — past the 15s threshold — the stuck-queue branch fires.
    vi.setSystemTime(new Date('2026-01-01T00:00:16Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(client.getDiagnostics().playbackStalls).toBe(1);
    // The queue is force-cleared and the mic unmuted: the next frame streams,
    // and the blob's stuck markers reset to 0 (not stuck anymore).
    expect(inner.playbackQueue.length).toBe(0);
    expect(client.getDiagnostics().stuckQueueSince).toBe(0);
    expect(client.getDiagnostics().stuckQueueMs).toBe(0);
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(audioFrameCount()).toBe(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('auto-flushes audioStreamEnd after trailing silence so the FINAL input transcription is emitted', async () => {
    // Seen live: the Live server only emits the final input transcription once
    // the audio stream ends — without the flush the dictation hook waits
    // forever (147 audio frames streamed, 0 inputTranscriptions). The client
    // must send audioStreamEnd once, ~flushOnSilenceMs after the last frame
    // with real signal.
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      flushOnSilenceMs: 1200,
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    // Speech first — the flush timer must start AFTER the speech ends.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(false);
    // 1.1s of silence: still under the 1.2s threshold — no flush yet.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.100Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(false);
    // Cross the threshold: the flush goes out — once.
    vi.setSystemTime(new Date('2026-01-01T00:00:01.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    const ends = ws.sent.filter((s) => s.includes('audioStreamEnd'));
    expect(ends.length).toBe(1);
    // More silence after the flush: no duplicate.
    vi.setSystemTime(new Date('2026-01-01T00:00:02.500Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    client.disconnect();
    vi.useRealTimers();
  });

  it('accumulates session diagnostics across a live exchange (drop diagnosis)', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      flushOnSilenceMs: 1200,
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });

    let diag = client.getDiagnostics();
    expect(diag.tokenHttpStatus).toBe(200);
    expect(diag.wsOpens).toBe(1);
    expect(diag.connected).toBe(true);

    await client.startListening();
    // Speech then silence crosses the flush threshold.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    await ws.receive({ serverContent: { inputTranscription: { text: 'add salt' }, turnComplete: true } });

    diag = client.getDiagnostics();
    expect(diag.micStarted).toBe(true);
    expect(diag.framesSent).toBe(2);
    expect(diag.flushesSent).toBe(1);
    expect(diag.transcripts).toBe(1);
    expect(diag.turnCompletes).toBe(1);
    expect(diag.lastError).toBeNull();

    // A hard close records the close code — the first thing to check when a
    // live mic "drops" mid-conversation.
    ws.onclose?.({ code: 1006, reason: 'abnormal closure' });
    diag = client.getDiagnostics();
    expect(diag.wsCloses).toBe(1);
    expect(diag.wsLastCloseCode).toBe(1006);
    expect(diag.connected).toBe(false);

    vi.useRealTimers();
  });

  it('exposes drop-classification counters: frame liveness, capture heartbeat, close reason, drain progress', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    try {
      await runCountersTest(procHolder);
    } finally {
      // Never leak fake timers into later tests, even on a failed assertion.
      vi.useRealTimers();
    }
  });

  // The body lives in its own helper so the test above can guarantee timer
  // cleanup on ANY exit path (a failing assertion skips the tail otherwise).
  async function runCountersTest(procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null }): Promise<void> {
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            // start() fires onended so playBuffer resolves (decodeAudioData
            // throws 'raw' → the PCM fallback path runs).
            createBufferSource: () => ({
              buffer: null,
              onended: null,
              start: function () {
                (this as { onended: (() => void) | null }).onended?.();
              },
              stop: () => undefined,
              connect: () => undefined,
            }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });

    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();
    const t0 = Date.parse('2026-01-01T00:00:00Z');

    // Audio-graph heartbeat: every processor tick counts (even while muted).
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    let diag = client.getDiagnostics();
    expect(diag.captureRuns).toBe(1);
    expect(diag.lastCaptureAt).toBe(t0);
    expect(diag.framesSent).toBe(1);
    expect(diag.lastFrameSentAt).toBe(t0);

    // Frame liveness: a received server frame increments framesReceived.
    await ws.receive({ serverContent: { inputTranscription: { text: 'add salt' }, turnComplete: true } });
    diag = client.getDiagnostics();
    expect(diag.framesReceived).toBe(2); // setupComplete + this frame
    expect(diag.lastFrameReceivedAt).toBe(t0);

    // Queue + drain progress: a model audio frame queues, then the drain
    // plays it (raw-PCM fallback → playBuffer resolves on onended). The
    // payload must be an EVEN byte count — an odd buffer makes the Int16Array
    // decode throw RangeError and the drain would drop the chunk.
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    await ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa('\x00\x00') } }] } } });
    await vi.advanceTimersByTimeAsync(10);
    diag = client.getDiagnostics();
    expect(diag.playbackChunksPlayed).toBe(1);
    expect(diag.lastQueueChangeAt).toBe(Date.parse('2026-01-01T00:00:01Z'));

    // Close reason: a hard close records why the socket went down. The fake
    // clock has moved to 00:00:01.010 (the 10ms advance), so the close
    // timestamp must match the clock AT close time — assert against Date.now()
    // rather than hard-coding, so this stays robust to future timer tweaks.
    const tClose = Date.now();
    ws.onclose?.({ code: 1006, reason: 'abnormal closure' });
    diag = client.getDiagnostics();
    expect(diag.wsCloses).toBe(1);
    expect(diag.wsLastCloseReason).toBe('abnormal closure');
    expect(diag.wsLastCloseAt).toBe(tClose);

    client.disconnect();
  }

  it('emits hearing while speech is present and drops it after a silence gap (waiting vs hearing)', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    const heard: boolean[] = [];
    client.on('hearing', (h) => heard.push(h));

    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();
    expect(heard).toHaveLength(0);

    // Real speech → hearing fires immediately.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(heard).toEqual([true]);
    // A short in-sentence pause (< 300 ms gap) keeps hearing true.
    vi.setSystemTime(new Date('2026-01-01T00:00:00.200Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(heard).toEqual([true]);
    // Silence past the gap drops it back to "waiting".
    vi.setSystemTime(new Date('2026-01-01T00:00:00.600Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(heard).toEqual([true, false]);
    expect(client.getDiagnostics().hearing).toBe(false);
    // Speaking again re-arms it.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    expect(heard).toEqual([true, false, true]);
    expect(client.getDiagnostics().hearing).toBe(true);

    client.disconnect();
    expect(client.getDiagnostics().hearing).toBe(false);
    vi.useRealTimers();
  });

  it('hard-fails after the 5s default when the voice socket never opens (blocked WebSocket)', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { client, getWs } = setupClient(); // no explicit option — the 5s default applies
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    expect(client.getDiagnostics().connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    await client.connect();
    expect(getWs()).toBeDefined(); // socket created but never opens
    // Under the 5s default: still connecting at 4s, fails just past 5s.
    vi.setSystemTime(new Date('2026-01-01T00:00:04Z'));
    await vi.advanceTimersByTimeAsync(4500);
    expect(errors.length).toBe(0);
    vi.setSystemTime(new Date('2026-01-01T00:00:05.100Z'));
    await vi.advanceTimersByTimeAsync(600);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/could not open the voice connection/);
    expect(client.getDiagnostics().lastError).toMatch(/could not open the voice connection/);
    vi.useRealTimers();
  });

  it('honors a custom connectTimeoutMs and reports it in diagnostics (tunable)', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { client } = setupClient({ connectTimeoutMs: 3000 });
    expect(client.getDiagnostics().connectTimeoutMs).toBe(3000);
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    await client.connect();
    vi.setSystemTime(new Date('2026-01-01T00:00:03.100Z'));
    await vi.advanceTimersByTimeAsync(3500);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/could not open the voice connection/);
    vi.useRealTimers();
  });

  it('hard-fails when the socket opens but the server never acks setup', async () => {
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { client, getWs } = setupClient({ connectTimeoutMs: 8000 });
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    await client.connect();
    getWs().open(); // socket opens, but no setupComplete ever arrives
    vi.setSystemTime(new Date('2026-01-01T00:00:08.100Z'));
    await vi.advanceTimersByTimeAsync(8500);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/did not respond/);
    vi.useRealTimers();
  });

  it('re-arms the flush on turnComplete so a SECOND utterance gets its own audioStreamEnd (continuous mic)', async () => {
    // The reported bug: the mic transcribed the FIRST burst then went dead —
    // the flush was one-shot (`flushed` never reset), so after the first
    // audioStreamEnd the server never emitted another final transcription.
    // Live-API probe proof: the server accepts and transcribes a 2nd utterance
    // only when it gets its OWN audioStreamEnd. turnComplete must re-arm the
    // flush, and silence alone must never flush (no speech since re-arm).
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      flushOnSilenceMs: 1200,
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    // Utterance 1: speech, then 1.3s silence → first flush.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    // The server finishes the exchange → turnComplete re-arms the flush.
    await ws.receive({ serverContent: { turnComplete: true } });

    // Long silence with NO new speech: must NOT flush (nothing to flush).
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    // Utterance 2: fresh speech, then 1.3s silence → the SECOND flush.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:06.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    const ends = ws.sent.filter((s) => s.includes('audioStreamEnd'));
    expect(ends.length).toBe(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('re-arms the flush on a FINAL input transcription so a second burst in a pure input session gets its own audioStreamEnd', async () => {
    // The continuous-voice bug (drive-live-voice.mjs PHASE C): in a session
    // with no model turn in flight the server never sends turnComplete or
    // interrupted, so the one-shot flush stayed latched and the SECOND spoken
    // burst was never transcribed (seen live: exactly 1 transcription across
    // two bursts). The FINAL input transcription only arrives after the
    // client's audioStreamEnd flush, so its arrival must re-arm the flush for
    // the next utterance.
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      flushOnSilenceMs: 1200,
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    // Utterance 1: speech, then 1.3s silence → first flush.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    // The server answers with the FINAL input transcription (no turnComplete
    // in a pure input session) — this must re-arm the flush.
    await ws.receive({ serverContent: { inputTranscription: { text: 'first burst', final: true } } });

    // Long silence with NO new speech: must NOT flush (nothing to flush).
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    // Utterance 2: fresh speech, then 1.3s silence → the SECOND flush.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:06.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    const ends = ws.sent.filter((s) => s.includes('audioStreamEnd'));
    expect(ends.length).toBe(2);

    client.disconnect();
    vi.useRealTimers();
  });

  it('does NOT re-arm the flush on a provisional (final: false) input transcription', async () => {
    // A provisional frame mid-utterance must never allow a second flush for
    // the SAME utterance — the re-arm is guarded by final !== false.
    mintOk();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      flushOnSilenceMs: 1200,
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();

    // Utterance 1: speech, then 1.3s silence → flush #1 (latched).
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:01.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    // A provisional transcription of the SAME utterance arrives — it must NOT
    // re-arm (final === false), so more speech cannot double-flush.
    await ws.receive({ serverContent: { inputTranscription: { text: 'first', final: false } } });
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } });
    vi.setSystemTime(new Date('2026-01-01T00:00:02.300Z'));
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
    expect(ws.sent.filter((s) => s.includes('audioStreamEnd')).length).toBe(1);

    client.disconnect();
    vi.useRealTimers();
  });

  it('disconnect() flushes an un-flushed utterance before closing (dictation quiet-timeout path)', async () => {
    // The dictation deadlock: the quiet-timeout called disconnect() directly
    // (never stopListening), the socket closed WITHOUT audioStreamEnd, and the
    // server never emitted the pending final transcription. disconnect() must
    // flush.
    mintOk();
    const procHolder: { fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null } = { fn: null };
    const { client, getWs } = setupClient({
      deps: {
        createWebSocket: (url: string) => new FakeWebSocket(url),
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            createMediaStreamSource: () => ({ connect: () => undefined }),
            createScriptProcessor: () => ({
              connect: () => undefined,
              get onaudioprocess() {
                return procHolder.fn;
              },
              set onaudioprocess(fn: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null) {
                procHolder.fn = fn;
              },
            }),
            createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
            createBufferSource: () => ({ buffer: null, onended: null, start: () => undefined, stop: () => undefined, connect: () => undefined }),
            decodeAudioData: async () => {
              throw new Error('raw');
            },
            destination: {},
            close: async () => undefined,
          }) as never,
      },
    });
    await client.connect();
    const ws = getWs();
    ws.open();
    await ws.receive({ setupComplete: {} });
    await client.startListening();
    // One speech frame, then disconnect immediately (no silence elapsed, no
    // auto-flush) — the close must still flush the utterance.
    procHolder.fn?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) } });
    client.disconnect();
    expect(ws.sent.some((s) => s.includes('audioStreamEnd'))).toBe(true);
  });
});

describe('audio helpers', () => {
  it('resample converts 48 kHz to 16 kHz linearly', () => {
    const input = new Float32Array(48);
    for (let i = 0; i < 48; i++) input[i] = i / 47;
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(0);
    expect(out[out.length - 1]).toBeCloseTo(1, 1);
  });

  it('floatTo16BitPCM + pcmToBase64 round-trips', () => {
    const pcm = floatTo16BitPCM(new Float32Array([0, 0.5, -1, 1, -0.25]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBeGreaterThan(0);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(32767);
    const b64 = pcmToBase64(pcm);
    const bin = atob(b64);
    expect(bin.length).toBe(pcm.length * 2);
  });

  it('decodeFrame handles string, ArrayBuffer and Blob', async () => {
    expect(await decodeFrame('{"a":1}')).toBe('{"a":1}');
    const bytes = new TextEncoder().encode('{"b":2}');
    expect(await decodeFrame(bytes)).toBe('{"b":2}');
    expect(await decodeFrame(new Blob(['{"c":3}']))).toBe('{"c":3}');
    expect(await decodeFrame(null)).toBeNull();
  });
});
