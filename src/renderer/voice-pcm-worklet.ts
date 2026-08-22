declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

const DEFAULT_TARGET_RATE = 16_000;
const DEFAULT_FRAME_BYTES = 640;

class JarvisPcm16Resampler extends AudioWorkletProcessor {
  private readonly targetRate: number;
  private readonly sourceSamplesPerOutputSample: number;
  private readonly frame: Uint8Array;
  private frameOffset = 0;
  private previousSample = 0;
  private hasPreviousSample = false;
  // Position in a logical block whose index 0 is the previous block's final
  // sample and whose index 1 is the current block's first sample.
  private sourcePosition = 1;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const processorOptions = options?.processorOptions as
      | { targetRate?: number; frameBytes?: number }
      | undefined;
    this.targetRate = processorOptions?.targetRate ?? DEFAULT_TARGET_RATE;
    const frameBytes = processorOptions?.frameBytes ?? DEFAULT_FRAME_BYTES;
    this.sourceSamplesPerOutputSample = sampleRate / this.targetRate;
    this.frame = new Uint8Array(frameBytes);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const channels = inputs[0];
    if (channels?.[0]?.length) this.consume(channels);
    return true;
  }

  private consume(channels: Float32Array[]) {
    const inputLength = channels[0]?.length ?? 0;
    if (inputLength === 0) return;
    if (!this.hasPreviousSample) {
      this.previousSample = this.readMonoSample(channels, 0);
      this.hasPreviousSample = true;
      this.sourcePosition = 1;
    }

    while (this.sourcePosition < inputLength) {
      const leftIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - leftIndex;
      const left = leftIndex === 0
        ? this.previousSample
        : this.readMonoSample(channels, leftIndex - 1);
      const right = this.readMonoSample(channels, leftIndex);
      this.writeSample(left + (right - left) * fraction);
      this.sourcePosition += this.sourceSamplesPerOutputSample;
    }
    this.previousSample = this.readMonoSample(channels, inputLength - 1);
    this.sourcePosition -= inputLength;
  }

  private readMonoSample(channels: Float32Array[], index: number) {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    return sum / channels.length;
  }

  private writeSample(sample: number) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const integer = clamped < 0
      ? Math.round(clamped * 32_768)
      : Math.round(clamped * 32_767);
    this.frame[this.frameOffset] = integer & 0xff;
    this.frame[this.frameOffset + 1] = (integer >> 8) & 0xff;
    this.frameOffset += 2;

    if (this.frameOffset !== this.frame.length) return;
    const completeFrame = this.frame.slice();
    this.port.postMessage(completeFrame.buffer, [completeFrame.buffer]);
    this.frameOffset = 0;
  }
}

registerProcessor('jarvis-pcm16-resampler', JarvisPcm16Resampler);
