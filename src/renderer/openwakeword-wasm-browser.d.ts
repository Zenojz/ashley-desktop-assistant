declare module 'openwakeword-wasm-browser' {
  type WakeWordDetection = { keyword: string; score: number; at: number };
  type WakeWordEvent = 'ready' | 'detect' | 'speech-start' | 'speech-end' | 'error';

  export class WakeWordEngine {
    constructor(options?: {
      keywords?: string[];
      modelFiles?: Record<string, string>;
      baseAssetUrl?: string;
      ortWasmPath?: string;
      detectionThreshold?: number;
      cooldownMs?: number;
      debug?: boolean;
    });
    load(): Promise<void>;
    start(options?: { deviceId?: string; gain?: number }): Promise<void>;
    stop(): Promise<void>;
    on(event: 'detect', handler: (payload: WakeWordDetection) => void): () => void;
    on(event: 'error', handler: (error: unknown) => void): () => void;
    on(event: Exclude<WakeWordEvent, 'detect' | 'error'>, handler: () => void): () => void;
  }

  export default WakeWordEngine;
}
