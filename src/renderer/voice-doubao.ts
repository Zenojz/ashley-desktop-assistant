import type {
  VoiceProvider,
  VoiceProviderAudioInput,
  VoiceProviderEvent,
  VoiceProviderListener,
  VoiceProviderOutputAudioListener,
  VoiceProviderSessionConfig,
  VoiceProviderToolDefinition,
  VoiceResponseRequest
} from './voice-provider';

const DOUBAO_MODEL = '1.2.6.1';
const INPUT_SAMPLE_RATE = 16_000;
const INPUT_FRAME_BYTES = 640;
const OUTPUT_SAMPLE_RATE = 24_000;
const WORKLET_NAME = 'jarvis-pcm16-resampler';
const SESSION_EVENT_TIMEOUT_MS = 10_000;

type DoubaoToolDefinition = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type DoubaoFunctionCallItem = {
  call_id?: string;
  name?: string;
  arguments?: string;
};

type DoubaoWireEvent = {
  type?: string;
  event_id?: string;
  response_id?: string;
  item_id?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  status_code?: number;
  error?: { message?: string; code?: string } | string;
  response?: {
    id?: string;
    status?: string;
    status_details?: { reason?: string; type?: string };
    usage?: { output_tokens?: number };
  };
  items?: DoubaoFunctionCallItem[];
};

type DoubaoTransportState =
  | { type: 'disconnected'; code: number; reason: string }
  | { type: 'failed'; message: string };

type DoubaoVoiceProviderOptions = {
  connect: () => Promise<{ durationMs: number }>;
  send: (payload: string) => void;
  close: () => void;
  onMessage: (listener: (payload: string) => void) => () => void;
  onState: (listener: (state: DoubaoTransportState) => void) => () => void;
  log: (message: string) => void;
};

type SessionWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
};

type ToolBatch = {
  calls: Array<{ id: string; name?: string; arguments?: string }>;
  outputs: Map<string, string>;
};

type WorkletPipeline = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  silentGain: GainNode;
};

export function convertToolsToDoubao(
  tools: readonly VoiceProviderToolDefinition[]
): DoubaoToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters
  }));
}

function buildSession(
  config: VoiceProviderSessionConfig,
  tools: DoubaoToolDefinition[]
) {
  return {
    id: crypto.randomUUID(),
    model: DOUBAO_MODEL,
    instructions: config.instructions,
    audio: {
      input: {
        format: { type: 'pcm', rate: INPUT_SAMPLE_RATE }
      },
      output: {
        format: { type: 'pcm_s16le', rate: OUTPUT_SAMPLE_RATE },
        voice: config.voice
      }
    },
    tools
  };
}

function buildExtension(config: VoiceProviderSessionConfig) {
  return {
    asr: {
      extra: {
        language: config.language,
        // Seeduplex otherwise decides the endpoint entirely on its own. One
        // live session kept several short commands open for 67 seconds and
        // returned them as one transcript. The official range starts at
        // 500ms; 600ms keeps short commands responsive without cutting at the
        // first natural micro-pause.
        end_smooth_window_ms: 600
      }
    },
    tts: {
      // Keep this explicit even though audio.output above already requests PCM.
      // It prevents the service default (OGG Opus) from adding a decoder and
      // an extra buffering stage to the first audible response.
      audio_config: {
        channel: 1,
        format: 'pcm_s16le',
        sample_rate: OUTPUT_SAMPLE_RATE
      },
      extra: {}
    },
    dialog: {
      extra: {
        enable_loudness_norm: true,
        enable_music: false
      }
    }
  };
}

export class DoubaoVoiceProvider implements VoiceProvider {
  readonly name = 'doubao' as const;

  private readonly listeners = new Set<VoiceProviderListener>();
  private readonly outputAudioListeners = new Set<VoiceProviderOutputAudioListener>();
  private readonly sessionWaiters = new Map<string, SessionWaiter>();
  private readonly toolBatches: ToolBatch[] = [];
  private inputAudio: MediaStream | null = null;
  private workletPipeline: WorkletPipeline | null = null;
  private removeMessageListener: (() => void) | null = null;
  private removeStateListener: (() => void) | null = null;
  private connected = false;
  private closing = false;
  private eventId = 0;
  private sessionId = '';
  private outputFormat = 'pcm_s16le';
  private outputSampleRate = OUTPUT_SAMPLE_RATE;
  private userSpeechOpen = false;
  private assistantResponseOpen = false;
  private firstAudioChunkSeen = false;
  private responseStartedAt = 0;
  private toolCallsThisTurn = 0;

  constructor(private readonly options: DoubaoVoiceProviderOptions) {}

  subscribe(listener: VoiceProviderListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receiveAudio(listener: VoiceProviderOutputAudioListener) {
    this.outputAudioListeners.add(listener);
    return () => this.outputAudioListeners.delete(listener);
  }

  async sendAudio(input: VoiceProviderAudioInput) {
    if (input instanceof MediaStream) {
      if (this.workletPipeline) {
        throw new Error('豆包语音会话建立后不能更换麦克风输入。');
      }
      this.inputAudio = input;
      return;
    }
    this.sendCompletePcmFrames(input);
  }

  async establishSession(config: VoiceProviderSessionConfig) {
    if (this.connected) return;
    const microphone = this.inputAudio;
    if (!microphone?.getAudioTracks()[0]) {
      throw new Error('豆包语音会话需要与本地打断分析器共用的麦克风 MediaStream。');
    }
    if (
      config.inputAudio.channels !== 1 ||
      config.inputAudio.sampleRate !== INPUT_SAMPLE_RATE ||
      config.outputAudio.channels !== 1 ||
      config.outputAudio.sampleRate !== OUTPUT_SAMPLE_RATE
    ) {
      throw new Error('豆包语音格式必须是 16kHz 单声道上行和 24kHz 单声道下行。');
    }

    this.closing = false;
    this.removeMessageListener = this.options.onMessage((payload) => this.handleMessage(payload));
    this.removeStateListener = this.options.onState((state) => this.handleTransportState(state));

    try {
      const connection = await this.options.connect();
      this.connected = true;
      this.emit({ type: 'transport.connected' });
      this.emitDiagnostic(`Doubao connection duration: ${connection.durationMs}ms.`);

      this.outputFormat = 'pcm_s16le';
      this.outputSampleRate = OUTPUT_SAMPLE_RATE;
      const tools = convertToolsToDoubao(config.tools);
      const baseSession = buildSession(config, []);
      this.sessionId = baseSession.id;
      const created = this.waitForSessionEvent('session.created');
      this.sendWireEvent({
        type: 'session.create',
        event_id: this.nextEventId(),
        session: baseSession,
        extension: buildExtension(config)
      });
      await created;

      const updated = this.waitForSessionEvent('session.updated');
      this.sendWireEvent({
        type: 'session.update',
        event_id: this.nextEventId(),
        session: {
          ...buildSession(config, tools),
          id: this.sessionId
        },
        extension: buildExtension(config)
      });
      await updated;

      await this.startAudioWorklet(microphone);
      this.emit({ type: 'session.ready' });
    } catch (error) {
      await this.closeSession();
      throw error;
    }
  }

  interrupt() {
    // Seeduplex is natively full duplex. Its ASR-start event is the server's
    // cancellation signal; voice.ts clears the local PCM queue immediately.
    // The current protocol does not document a client-side response.cancel.
    return this.connected;
  }

  submitToolResult(callId: string, output: string) {
    const batch = this.toolBatches.find((candidate) =>
      candidate.calls.some((call) => call.id === callId)
    );
    if (!batch) return this.sendToolResultItems([{ id: callId, output }]);

    batch.outputs.set(callId, output);
    if (batch.calls.some((call) => !batch.outputs.has(call.id))) return true;
    const sent = this.sendToolResultItems(
      batch.calls.map((call) => ({ id: call.id, output: batch.outputs.get(call.id) ?? '' }))
    );
    this.toolBatches.splice(this.toolBatches.indexOf(batch), 1);
    return sent;
  }

  requestResponse(_request: VoiceResponseRequest = {}) {
    // The duplex service resumes automatically after conversation.item.create.
    // There is no documented response.create client event in this protocol.
    return this.connected;
  }

  async readOutputAudioTransportStats() {
    return null;
  }

  async closeSession() {
    if (this.closing) return;
    this.closing = true;
    if (this.connected) {
      this.sendWireEvent({ type: 'session.close', event_id: this.nextEventId() });
    }
    this.connected = false;
    this.rejectSessionWaiters(new Error('豆包语音会话已关闭。'));
    this.toolBatches.length = 0;
    this.finishTurnDiagnostics();
    await this.stopAudioWorklet();
    this.removeMessageListener?.();
    this.removeStateListener?.();
    this.removeMessageListener = null;
    this.removeStateListener = null;
    this.options.close();
    this.inputAudio = null;
    this.closing = false;
  }

  private async startAudioWorklet(microphone: MediaStream) {
    const context = new AudioContext({ latencyHint: 'interactive' });
    try {
      const moduleUrl = new URL('./voice-pcm-worklet.js', window.location.href).href;
      await context.audioWorklet.addModule(moduleUrl);
      const source = context.createMediaStreamSource(microphone);
      const node = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetRate: INPUT_SAMPLE_RATE,
          frameBytes: INPUT_FRAME_BYTES
        }
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(node);
      node.connect(silentGain);
      silentGain.connect(context.destination);
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const frame = new Uint8Array(event.data);
        if (frame.byteLength !== INPUT_FRAME_BYTES) {
          this.emit({
            type: 'error',
            message: `豆包上行音频帧长度错误：${frame.byteLength} 字节。`
          });
          return;
        }
        this.sendPcmFrame(frame);
      };
      this.workletPipeline = { context, source, node, silentGain };
      await context.resume();
      this.options.log(
        `Doubao AudioWorklet active: ${context.sampleRate}Hz float32 -> 16000Hz PCM16, 640-byte frames.`
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  private async stopAudioWorklet() {
    const pipeline = this.workletPipeline;
    this.workletPipeline = null;
    if (!pipeline) return;
    pipeline.node.port.onmessage = null;
    pipeline.source.disconnect();
    pipeline.node.disconnect();
    pipeline.silentGain.disconnect();
    if (pipeline.context.state !== 'closed') await pipeline.context.close();
  }

  private sendCompletePcmFrames(bytes: Uint8Array) {
    if (bytes.byteLength % INPUT_FRAME_BYTES !== 0) {
      throw new Error(`豆包上行 PCM 必须由完整的 ${INPUT_FRAME_BYTES} 字节帧组成。`);
    }
    for (let offset = 0; offset < bytes.byteLength; offset += INPUT_FRAME_BYTES) {
      this.sendPcmFrame(bytes.subarray(offset, offset + INPUT_FRAME_BYTES));
    }
  }

  private sendPcmFrame(frame: Uint8Array) {
    if (!this.connected) return false;
    return this.sendWireEvent({
      type: 'input_audio_buffer.append',
      audio: bytesToBase64(frame)
    });
  }

  private sendToolResultItems(items: Array<{ id: string; output: string }>) {
    return this.sendWireEvent({
      type: 'conversation.item.create',
      event_id: this.nextEventId(),
      items: items.map((item) => ({
        type: 'message',
        role: 'tool',
        call_id: item.id,
        content: [{ type: 'input_text', text: item.output }]
      }))
    });
  }

  private handleMessage(payload: string) {
    let event: DoubaoWireEvent;
    try {
      event = JSON.parse(payload) as DoubaoWireEvent;
    } catch (error) {
      this.emit({
        type: 'error',
        message: `豆包事件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }
    const type = event.type ?? '';
    if (type === 'session.created' || type === 'session.updated') {
      this.resolveSessionWaiter(type);
      return;
    }
    switch (type) {
      case 'session.closed':
        if (!this.closing) this.emit({ type: 'transport.closed' });
        break;
      case 'conversation.item.input_audio_transcription.started':
      case 'ASRInfo':
        this.beginUserSpeech();
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) this.beginUserSpeech();
        this.emit({
          type: 'transcription',
          speaker: 'user',
          source: 'audio',
          text: event.delta ?? '',
          final: false
        });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emit({
          type: 'transcription',
          speaker: 'user',
          source: 'audio',
          text: event.transcript ?? event.text ?? '',
          final: true
        });
        if (this.userSpeechOpen) {
          this.userSpeechOpen = false;
          this.emit({ type: 'user.speech.ended' });
        }
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.userSpeechOpen = false;
        this.emit({ type: 'error', message: errorMessage(event) });
        break;
      case 'response.output_text.delta':
        this.ensureAssistantResponse(event.response_id);
        this.emit({
          type: 'transcription',
          speaker: 'assistant',
          source: 'text',
          text: event.delta ?? '',
          final: false
        });
        break;
      case 'response.output_text.done':
        this.emit({
          type: 'transcription',
          speaker: 'assistant',
          source: 'text',
          text: event.text ?? '',
          final: true
        });
        break;
      case 'response.output_audio.started':
        this.ensureAssistantResponse(event.response_id);
        this.emit({ type: 'assistant.audio.started' });
        break;
      case 'response.output_audio.delta': {
        this.ensureAssistantResponse(event.response_id);
        if (!this.firstAudioChunkSeen) {
          this.firstAudioChunkSeen = true;
          const durationMs = Math.round(performance.now() - this.responseStartedAt);
          this.emitDiagnostic(`Doubao first output audio chunk: ${durationMs}ms after response start.`);
        }
        const data = base64ToBytes(event.delta ?? '');
        if (data.length > 0) {
          for (const listener of this.outputAudioListeners) {
            listener({
              kind: 'chunk',
              data,
              sampleRate: this.outputSampleRate,
              format: this.outputFormat
            });
          }
        }
        break;
      }
      case 'response.output_audio.done':
        // Doubao does not send a separate response.done: the audio finishing is
        // the turn finishing. Without closing the response here every turn stays
        // open forever, they pile up, later turns queue behind them — observed
        // as an 87 second silence before a reply arrived — and new turns start
        // on top of an unfinished one, which is what makes the model produce
        // fluent audio that is not language.
        //
        // Close the response *before* announcing that audio ended. Listeners
        // check whether a response is still open when audio stops, so the other
        // order made every healthy turn look like a stuck one.
        this.finishAssistantResponse(event.response_id, 'completed');
        this.emit({ type: 'assistant.audio.ended' });
        this.finishTurnDiagnostics();
        break;
      case 'response.function_call_arguments.done':
        this.handleToolCalls(event.items ?? []);
        break;
      case 'response.canceled':
        this.finishAssistantResponse(event.response_id, 'cancelled');
        break;
      case 'response.done':
        this.finishAssistantResponse(
          event.response?.id ?? event.response_id,
          event.response?.status ?? 'completed',
          event.response?.status_details?.reason ?? event.response?.status_details?.type,
          event.response?.usage?.output_tokens
        );
        break;
      case 'error': {
        const error = new Error(errorMessage(event));
        this.rejectSessionWaiters(error);
        this.emit({ type: 'error', message: error.message });
        break;
      }
      default:
        if (type) this.emit({ type: 'unhandled', providerEventType: type });
        break;
    }
  }

  private beginUserSpeech() {
    if (this.userSpeechOpen) return;
    this.finishTurnDiagnostics();
    this.userSpeechOpen = true;
    this.emit({ type: 'user.speech.started' });
  }

  private ensureAssistantResponse(responseId?: string) {
    if (this.assistantResponseOpen) return;
    this.assistantResponseOpen = true;
    this.firstAudioChunkSeen = false;
    this.responseStartedAt = performance.now();
    this.emit({ type: 'assistant.response.started', responseId });
  }

  private finishAssistantResponse(
    responseId: string | undefined,
    status: string,
    reason?: string,
    outputTokens?: number
  ) {
    // Called from both the audio-done path and the response.done path, so that
    // whichever arrives first closes the turn and the other is a no-op.
    if (!this.assistantResponseOpen) return;
    this.assistantResponseOpen = false;
    this.emit({
      type: 'assistant.response.ended',
      responseId,
      status,
      reason,
      outputTokens
    });
  }

  private handleToolCalls(items: DoubaoFunctionCallItem[]) {
    const calls = items
      .filter((item): item is DoubaoFunctionCallItem & { call_id: string } => Boolean(item.call_id))
      .map((item) => ({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments
      }));
    if (calls.length === 0) return;
    this.toolCallsThisTurn += calls.length;
    this.toolBatches.push({ calls, outputs: new Map() });
    for (const call of calls) this.emit({ type: 'tool.call', call });
  }

  private finishTurnDiagnostics() {
    if (this.toolCallsThisTurn === 0) return;
    this.emitDiagnostic(`Doubao tool calls this turn: ${this.toolCallsThisTurn}.`);
    this.toolCallsThisTurn = 0;
  }

  private handleTransportState(state: DoubaoTransportState) {
    if (this.closing) return;
    if (state.type === 'failed') {
      this.emit({ type: 'error', message: `豆包语音传输失败：${state.message}` });
      this.emit({ type: 'transport.failed' });
      return;
    }
    this.connected = false;
    this.emit({ type: 'transport.disconnected' });
  }

  private waitForSessionEvent(type: string) {
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.sessionWaiters.delete(type);
        reject(new Error(`等待豆包事件 ${type} 超时。`));
      }, SESSION_EVENT_TIMEOUT_MS);
      this.sessionWaiters.set(type, { resolve, reject, timeout });
    });
  }

  private resolveSessionWaiter(type: string) {
    const waiter = this.sessionWaiters.get(type);
    if (!waiter) return;
    window.clearTimeout(waiter.timeout);
    this.sessionWaiters.delete(type);
    waiter.resolve();
  }

  private rejectSessionWaiters(error: Error) {
    for (const waiter of this.sessionWaiters.values()) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.sessionWaiters.clear();
  }

  private nextEventId() {
    this.eventId += 1;
    return `event_${this.eventId}`;
  }

  private sendWireEvent(event: unknown) {
    if (!this.connected) return false;
    this.options.send(JSON.stringify(event));
    return true;
  }

  private emit(event: VoiceProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private emitDiagnostic(message: string) {
    this.emit({ type: 'diagnostic', message });
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string) {
  if (!encoded) return new Uint8Array(0);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function errorMessage(event: DoubaoWireEvent) {
  if (typeof event.error === 'string') return event.error;
  return event.error?.message ?? event.error?.code ?? `豆包语音事件失败（${event.type ?? 'unknown'}）。`;
}
