import type {
  VoiceProvider,
  VoiceProviderAudioInput,
  VoiceProviderAudioTransportStats,
  VoiceProviderEvent,
  VoiceProviderListener,
  VoiceProviderOutputAudioListener,
  VoiceProviderSessionConfig,
  VoiceProviderToolCall,
  VoiceResponseRequest
} from './voice-provider';

type OpenAIFunctionCall = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type OpenAIResponseItem = OpenAIFunctionCall & {
  role?: string;
  content?: Array<{ type?: string; text?: string; transcript?: string }>;
};

type OpenAIRealtimeEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  error?: { message?: string };
  response?: {
    id?: string;
    output?: OpenAIResponseItem[];
    status?: string;
    status_details?: {
      type?: string;
      reason?: string;
      error?: { type?: string; code?: string; message?: string };
    };
    usage?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
};

type ReceiverWithPlayoutDelayHint = RTCRtpReceiver & {
  playoutDelayHint?: number;
};

type OpenAIVoiceProviderOptions = {
  connectRealtime: (sdp: string) => Promise<string>;
  outputPlayoutDelaySeconds: number;
  log: (message: string) => void;
};

function readNumericStat(stats: Record<string, unknown>, key: string) {
  const value = stats[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class OpenAIVoiceProvider implements VoiceProvider {
  readonly name = 'openai' as const;

  private readonly listeners = new Set<VoiceProviderListener>();
  private readonly outputAudioListeners = new Set<VoiceProviderOutputAudioListener>();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private inputAudio: MediaStream | null = null;

  constructor(private readonly options: OpenAIVoiceProviderOptions) {}

  subscribe(listener: VoiceProviderListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receiveAudio(listener: VoiceProviderOutputAudioListener) {
    this.outputAudioListeners.add(listener);
    return () => this.outputAudioListeners.delete(listener);
  }

  async sendAudio(input: VoiceProviderAudioInput) {
    if (!(input instanceof MediaStream)) {
      throw new Error('OpenAI Realtime requires a live MediaStream input.');
    }
    if (this.peer) throw new Error('OpenAI Realtime input cannot change after session setup.');
    this.inputAudio = input;
  }

  async establishSession(_config: VoiceProviderSessionConfig) {
    // OpenAI receives the same config through main.ts together with the SDP.
    // The argument remains part of the provider contract for transports that
    // must send their own session.create/session.update event.
    if (this.peer) return;
    const microphone = this.inputAudio;
    if (!microphone) throw new Error('OpenAI Realtime requires microphone audio before connecting.');
    const microphoneTrack = microphone.getAudioTracks()[0];
    if (!microphoneTrack) throw new Error('Microphone did not provide an audio track.');

    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel('oai-events');
    this.peer = peer;
    this.channel = channel;

    peer.ontrack = (event) => {
      this.configureAudioPlayout(event.receiver);
      const stream = event.streams[0];
      if (stream) {
        for (const listener of this.outputAudioListeners) {
          listener({ kind: 'stream', stream });
        }
      }
    };
    peer.onconnectionstatechange = () => {
      switch (peer.connectionState) {
        case 'connected':
          this.emit({ type: 'transport.connected' });
          break;
        case 'disconnected':
          this.emit({ type: 'transport.disconnected' });
          break;
        case 'failed':
          this.emit({ type: 'transport.failed' });
          break;
        case 'closed':
          this.emit({ type: 'transport.closed' });
          break;
      }
    };
    channel.onopen = () => this.emit({ type: 'session.ready' });
    channel.onmessage = (message) => {
      try {
        this.handleWireEvent(JSON.parse(message.data) as OpenAIRealtimeEvent);
      } catch (error) {
        console.error('[Jarvis] Unable to parse Realtime event.', error);
      }
    };
    channel.onerror = (error) => console.error('[Jarvis] Realtime data channel error.', error);

    peer.addTrack(microphoneTrack, microphone);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!offer.sdp) throw new Error('WebRTC did not produce an SDP offer.');
    const answerSdp = await this.options.connectRealtime(offer.sdp);
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    if (channel.readyState !== 'open') await this.waitForDataChannel(channel);
  }

  interrupt(options: { clearOutputAudio?: boolean } = {}) {
    const cancelled = this.sendWireEvent({ type: 'response.cancel' });
    if (options.clearOutputAudio) this.sendWireEvent({ type: 'output_audio_buffer.clear' });
    return cancelled;
  }

  submitToolResult(callId: string, output: string) {
    return this.sendWireEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output
      }
    });
  }

  requestResponse(request: VoiceResponseRequest = {}) {
    return this.sendWireEvent({
      type: 'response.create',
      response: {
        instructions: request.instructions,
        ...(request.disableTools ? { tool_choice: 'none' } : {})
      }
    });
  }

  async readOutputAudioTransportStats() {
    const peer = this.peer;
    if (!peer) return null;
    const reports = await peer.getStats();
    let inboundAudioStats: VoiceProviderAudioTransportStats | null = null;
    reports.forEach((report) => {
      if (inboundAudioStats) return;
      const stats = report as unknown as Record<string, unknown>;
      const kind = stats.kind ?? stats.mediaType;
      if (stats.type !== 'inbound-rtp' || kind !== 'audio') return;
      inboundAudioStats = {
        packetsReceived: readNumericStat(stats, 'packetsReceived') ?? 0,
        packetsLost: readNumericStat(stats, 'packetsLost') ?? 0,
        jitterSeconds: readNumericStat(stats, 'jitter'),
        jitterBufferDelaySeconds: readNumericStat(stats, 'jitterBufferDelay'),
        jitterBufferEmittedCount: readNumericStat(stats, 'jitterBufferEmittedCount'),
        concealedSamples: readNumericStat(stats, 'concealedSamples') ?? 0,
        concealmentEvents: readNumericStat(stats, 'concealmentEvents') ?? 0
      } satisfies VoiceProviderAudioTransportStats;
    });
    return inboundAudioStats;
  }

  async closeSession() {
    const channel = this.channel;
    const peer = this.peer;
    this.channel = null;
    this.peer = null;
    this.inputAudio = null;
    channel?.close();
    peer?.close();
  }

  private emit(event: VoiceProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private sendWireEvent(event: unknown) {
    const channel = this.channel;
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(event));
    return true;
  }

  private async waitForDataChannel(channel: RTCDataChannel) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Realtime data channel did not open within 10 seconds.'));
      }, 10_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        channel.removeEventListener('open', handleOpen);
        channel.removeEventListener('error', handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('Realtime data channel failed while opening.'));
      };
      channel.addEventListener('open', handleOpen, { once: true });
      channel.addEventListener('error', handleError, { once: true });
    });
  }

  private configureAudioPlayout(receiver: RTCRtpReceiver) {
    const delayedReceiver = receiver as ReceiverWithPlayoutDelayHint;
    try {
      delayedReceiver.playoutDelayHint = this.options.outputPlayoutDelaySeconds;
      const applied = delayedReceiver.playoutDelayHint;
      this.options.log(
        `Realtime audio recovery buffer requested: ${Math.round(this.options.outputPlayoutDelaySeconds * 1_000)}ms` +
        (typeof applied === 'number' ? ` (reported ${Math.round(applied * 1_000)}ms).` : '.')
      );
    } catch (error) {
      this.options.log(
        `Realtime audio recovery buffer unavailable: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
  }

  private handleWireEvent(event: OpenAIRealtimeEvent) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this.emit({ type: 'session.ready' });
        break;
      case 'input_audio_buffer.speech_started':
        this.emit({ type: 'user.speech.started' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit({ type: 'user.speech.ended' });
        break;
      case 'conversation.item.input_audio_transcription.delta':
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
          text: event.transcript ?? '',
          final: true
        });
        break;
      case 'response.created':
        this.emit({ type: 'assistant.response.started', responseId: event.response?.id });
        break;
      case 'response.output_text.delta':
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
      case 'output_audio_buffer.started':
        this.emit({ type: 'assistant.audio.started' });
        break;
      case 'response.output_audio_transcript.delta':
        this.emit({
          type: 'transcription',
          speaker: 'assistant',
          source: 'audio',
          text: event.delta ?? '',
          final: false
        });
        break;
      case 'response.output_audio_transcript.done':
        this.emit({
          type: 'transcription',
          speaker: 'assistant',
          source: 'audio',
          text: event.transcript ?? '',
          final: true
        });
        break;
      case 'response.done': {
        const response = event.response;
        this.emit({
          type: 'assistant.response.ended',
          responseId: response?.id,
          status: response?.status,
          reason: response?.status_details?.reason
            ?? response?.status_details?.type
            ?? response?.status_details?.error?.code,
          outputTokens: response?.usage?.output_tokens
        });
        const calls = (response?.output ?? []).filter((item) => item.type === 'function_call');
        for (const call of calls) {
          const toolCall = this.toToolCall(call);
          if (toolCall) this.emit({ type: 'tool.call', call: toolCall });
        }
        break;
      }
      case 'output_audio_buffer.stopped':
        this.emit({ type: 'assistant.audio.ended' });
        break;
      case 'error':
        this.emit({ type: 'error', message: event.error?.message ?? 'unknown error' });
        break;
      default:
        if (event.type) this.emit({ type: 'unhandled', providerEventType: event.type });
        break;
    }
  }

  private toToolCall(call: OpenAIFunctionCall): VoiceProviderToolCall | null {
    if (!call.call_id) return null;
    return {
      id: call.call_id,
      name: call.name,
      arguments: call.arguments
    };
  }
}
