declare module 'openwakeword-wasm-browser' {
  type WakeWordDetection = { keyword: string; score: number; at: number };
  type WakeWordEvent = 'ready' | 'detect' | 'speech-start' | 'speech-end' | 'error';
  type WakeWordEmbeddingSnapshot = {
    history: Float32Array[];
    accumulatedEmbeddings: number;
    requiredEmbeddings: number;
    complete: boolean;
  };

  export class WakeWordEngine {
    constructor(options?: {
      keywords?: string[];
      modelFiles?: Record<string, string>;
      baseAssetUrl?: string;
      ortWasmPath?: string;
      detectionThreshold?: number;
      detectionThresholds?: Record<string, number>;
      detectionGroups?: Record<string, string>;
      cooldownMs?: number;
      debug?: boolean;
    });
    load(): Promise<void>;
    start(options?: { deviceId?: string; gain?: number }): Promise<void>;
    stop(): Promise<void>;
    getKeywordEmbeddingSnapshot(keyword: string): WakeWordEmbeddingSnapshot | null;
    on(event: 'detect', handler: (payload: WakeWordDetection) => void): () => void;
    on(event: 'error', handler: (error: unknown) => void): () => void;
    on(event: Exclude<WakeWordEvent, 'detect' | 'error'>, handler: () => void): () => void;
  }

  export default WakeWordEngine;
}
