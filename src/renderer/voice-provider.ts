import { OpenAIVoiceProvider } from './voice-openai';
import { DoubaoVoiceProvider } from './voice-doubao';

/**
 * Doubao protocol invariants for every future provider implementation:
 *
 * - Only use wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue.
 *   The legacy /api/v3/realtime/dialogue endpoint has no tool calling and must
 *   never be used.
 * - The full-duplex Seeduplex 3.0 model is fixed at 1.2.6.1. The legacy
 *   1.2.1.1 (O2.0) and 2.2.0.0 (SC2.0) models have no tool calling.
 * - Full-duplex authentication uses X-Api-Key, not the legacy four headers.
 *
 * Provider implementations own their wire protocol. Everything exported from
 * this file describes vendor-neutral voice and conversation semantics only.
 */

export type VoiceProviderName = 'openai' | 'doubao';

export type VoiceProviderToolCall = {
  id: string;
  name?: string;
  arguments?: string;
};

export type VoiceProviderAudioTransportStats = {
  packetsReceived: number;
  packetsLost: number;
  jitterSeconds: number | null;
  jitterBufferDelaySeconds: number | null;
  jitterBufferEmittedCount: number | null;
  concealedSamples: number;
  concealmentEvents: number;
};

export type VoiceProviderToolDefinition = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type VoiceProviderAudioConfig = {
  format: string;
  sampleRate: number;
  channels: number;
};

export type VoiceProviderSessionConfig = {
  tools: VoiceProviderToolDefinition[];
  instructions: string;
  voice: string;
  language: string;
  inputAudio: VoiceProviderAudioConfig;
  outputAudio: VoiceProviderAudioConfig;
};

export type VoiceProviderEvent =
  | { type: 'session.ready' }
  | { type: 'transport.connected' }
  | { type: 'transport.disconnected' }
  | { type: 'transport.failed' }
  | { type: 'transport.closed' }
  | { type: 'user.speech.started' }
  | { type: 'user.speech.ended' }
  | {
      type: 'transcription';
      speaker: 'user' | 'assistant';
      source: 'audio' | 'text';
      text: string;
      final: boolean;
    }
  | { type: 'assistant.response.started'; responseId?: string }
  | {
      type: 'assistant.response.ended';
      responseId?: string;
      status?: string;
      reason?: string;
      outputTokens?: number;
    }
  | { type: 'assistant.audio.started' }
  | { type: 'assistant.audio.ended' }
  | { type: 'tool.call'; call: VoiceProviderToolCall }
  | { type: 'diagnostic'; message: string }
  | { type: 'error'; message: string }
  | { type: 'unhandled'; providerEventType: string };

export type VoiceProviderListener = (event: VoiceProviderEvent) => void;
export type VoiceProviderOutputAudio =
  | { kind: 'stream'; stream: MediaStream }
  | { kind: 'chunk'; data: Uint8Array; sampleRate: number; format: string };
export type VoiceProviderOutputAudioListener = (audio: VoiceProviderOutputAudio) => void;

export type VoiceProviderAudioInput = MediaStream | Uint8Array;

export type VoiceResponseRequest = {
  instructions?: string;
  disableTools?: boolean;
};

export interface VoiceProvider {
  readonly name: VoiceProviderName;

  establishSession(config: VoiceProviderSessionConfig): Promise<void>;
  sendAudio(input: VoiceProviderAudioInput): Promise<void>;
  receiveAudio(listener: VoiceProviderOutputAudioListener): () => void;
  subscribe(listener: VoiceProviderListener): () => void;
  interrupt(options?: { clearOutputAudio?: boolean }): boolean;
  submitToolResult(callId: string, output: string): boolean;
  requestResponse(request?: VoiceResponseRequest): boolean;
  readOutputAudioTransportStats(): Promise<VoiceProviderAudioTransportStats | null>;
  closeSession(): Promise<void>;
}

export function createVoiceProvider(options: {
  configuredName: string;
  outputPlayoutDelaySeconds: number;
  log: (message: string) => void;
}): VoiceProvider {
  switch (options.configuredName) {
    case '':
    case 'openai':
      return new OpenAIVoiceProvider({
        connectRealtime: (sdp) => window.jarvis.connectRealtime(sdp),
        outputPlayoutDelaySeconds: options.outputPlayoutDelaySeconds,
        log: options.log
      });
    case 'doubao':
      return new DoubaoVoiceProvider({
        connect: () => window.jarvis.connectDoubaoVoice(),
        send: (payload) => window.jarvis.sendDoubaoVoice(payload),
        close: () => window.jarvis.closeDoubaoVoice(),
        onMessage: (listener) => window.jarvis.onDoubaoVoiceMessage(listener),
        onState: (listener) => window.jarvis.onDoubaoVoiceState(listener),
        log: options.log
      });
    default:
      throw new Error(`Unsupported JARVIS_VOICE_PROVIDER: ${options.configuredName}`);
  }
}
