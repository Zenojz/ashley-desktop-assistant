import { inferSpokenHideRequest } from './spoken-hide';
import { inferSpokenMusicRequest } from './spoken-music';
import WakeWordEngine from 'openwakeword-wasm-browser';
import { voiceConfig } from './voice-config';
import {
  isPersonalWakeModel,
  scorePersonalWake,
  trainPersonalWakeModel,
  type PersonalWakeModel
} from './personal-wake';
import { createVoiceProvider } from './voice-provider';
import type {
  VoiceProvider,
  VoiceProviderAudioTransportStats,
  VoiceProviderEvent,
  VoiceProviderOutputAudio,
  VoiceProviderToolCall
} from './voice-provider';

type ChunkAudioPlayback = {
  context: AudioContext;
  analyser: AnalyserNode;
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  nextStartTime: number;
  generation: number;
  pendingDecodes: number;
  pendingPcmByte: number | null;
  decodeChain: Promise<void>;
  finishWhenDrained: boolean;
};

type VoiceSession = {
  provider: VoiceProvider;
  unsubscribeProvider: () => void;
  unsubscribeOutputAudio: () => void;
  microphone: MediaStream;
  audio: HTMLAudioElement;
  analyserContext: AudioContext | null;
  analyser: AnalyserNode | null;
  analyserData: Uint8Array<ArrayBuffer> | null;
  chunkPlayback: ChunkAudioPlayback | null;
  levelFrame: number | null;
  audioStatsTimer: number | null;
  lastInboundAudioStats: InboundAudioTransportStats | null;
  outputAudioQuality: OutputAudioQuality | null;
  // Microphone-side analysis, used only to notice that the user has started
  // speaking so playback can be silenced locally without waiting for the server.
  inputContext: AudioContext | null;
  inputAnalyser: AnalyserNode | null;
  inputData: Uint8Array<ArrayBuffer> | null;
  inputFrame: number | null;
  loudInputFrames: number;
};

type InboundAudioTransportStats = VoiceProviderAudioTransportStats;

type OutputAudioQuality = {
  samples: number;
  packetsReceived: number;
  packetsLost: number;
  concealedSamples: number;
  concealmentEvents: number;
  maxJitterSeconds: number | null;
  maxJitterBufferDelaySeconds: number | null;
};

const wakeModelUrl = new URL('../assets/wake-word/models', window.location.href).href;
const ortWasmUrl = new URL('../assets/wake-word/ort/', window.location.href).href;
const wakeEngine = new WakeWordEngine({
  keywords: [voiceConfig.wakeKeyword],
  modelFiles: {
    [voiceConfig.wakeKeyword]: voiceConfig.wakeModelFile
  },
  baseAssetUrl: wakeModelUrl,
  ortWasmPath: ortWasmUrl,
  detectionThreshold: voiceConfig.wakeThreshold,
  // Long enough not to re-count the same ~1.4s rolling audio window, but
  // short enough that a natural repeated summon can confirm a weak score.
  cooldownMs: 1800
});

let wakeLoaded = false;
let wakeRunning = false;
let wakeTransition = false;
// OpenWakeWord is a streaming model: it keeps a rolling window of roughly 1.4s
// of audio features across inferences. The library exposes start() and stop()
// but no way to flush that window, so the first inferences after a restart can
// run over audio captured before the engine was stopped — including the user's
// own earlier "Hey Jarvis". Discard detections until the window has refilled
// with genuinely new audio.
let wakeWarmupUntil = 0;
// Strong detections can wake immediately. Borderline detections must occur
// twice; this keeps recognition usable for a softly spoken real summon while
// preventing one-off room speech from opening Jarvis.
let pendingWakeCandidateAt = 0;
let pendingWakeCandidateScore = 0;
let pendingPersonalWakeCandidateAt = 0;
let pendingPersonalWakeCandidateScore = 0;
// Set when the provider starts a response and cleared when it ends. A non-null
// value when audio stops means the provider never closed the turn.
let openResponseId: string | null = null;
let openResponseStartedAt = 0;
let activeSession: VoiceSession | null = null;
let disconnectTimer: number | null = null;
let microphoneUnmuteTimer: number | null = null;
let assemblySoundMutedUntil = 0;
let outputTranscript = '';
let completedOutputTranscript = '';
let realtimeTextTranscript = '';
let outputAudioPlaying = false;
let nativeAudioTailUntil = 0;
let stoppingSession = false;
let shuttingDown = false;
let sleepRequested = false;
let sleepConfirmationPending = false;
let sleepConfirmationPlaying = false;
let sleepFallbackTimer: number | null = null;
let wakeResumeNotBefore = 0;
// A fully specified local music request must not expose Seeduplex's interim
// planning (for example, reading "application equals kugou" aloud). Keep the
// provider audible only after the real app action has returned a verified
// success or failure result.
let musicCommandPlaybackSuppressed = false;
const completedToolCalls = new Set<string>();
// A four-second holdoff still let nearby dictation wake Jarvis again while the
// user was describing the just-finished interaction. Keep the wake engine off
// long enough for that sentence to pass; this is deliberately scoped to a
// voice-requested sleep and does not change normal wake sensitivity.
const wakeResumeHoldoffMs = 10_000;
const doubaoFarewellFallbackMs = 3_000;
// Measured, not guessed. Spurious detections replaying the buffered "Hey
// Jarvis" arrive 1.3–1.55s after the engine restarts, always scoring 0.990 —
// the same audio being re-read. A 1.5s window caught one at 1.344s and missed
// an identical one at 1.536s, so the margin has to be much wider than the
// nominal ~1.4s feature buffer.
const wakeWarmupMs = 2_500;
// Scores from different community-model revisions are not calibrated alike.
// Verified summons in the current room scored 0.504 and 0.477. Requiring 0.60
// forced both through a second-hit path and made several real summons appear
// ignored. Scores below 0.48 still retain the six-second two-hit safeguard;
// stale-buffer detections remain handled separately by the warm-up guard.
const immediateWakeScore = 0.48;
// The detector itself has a three-second cooldown. Allow enough time for a
// natural second summon after the user notices the first one was borderline.
const wakeCandidateConfirmationMs = 6_000;
// The current Wi-Fi route has repeatedly shown 12–22% burst loss.  Leave
// enough time for Opus/NACK recovery so the final words are not discarded;
// 420ms remains conversationally responsive while being materially more
// reliable than Chromium's ~30–110ms adaptive default.
const realtimeAudioPlayoutDelaySeconds = 0.42;

function createConfiguredVoiceProvider(): VoiceProvider {
  const selection = window.jarvis.getVoiceProviderSelection();
  recordVoiceEvent(
    `Voice provider selected: requested=${selection.requestedName}, selected=${selection.selectedName}.`
  );
  if (selection.fallbackReason) recordVoiceEvent(selection.fallbackReason);
  return createVoiceProvider({
    configuredName: selection.selectedName,
    outputPlayoutDelaySeconds: realtimeAudioPlayoutDelaySeconds,
    log
  });
}

type WakeEngineWithMediaStream = WakeWordEngine & { _mediaStream?: MediaStream };
type WakeEngineInternals = WakeEngineWithMediaStream & {
  _audioContext?: AudioContext | null;
  _workletNode?: AudioWorkletNode | null;
  _keywordModels?: Record<string, {
    history: Float32Array[];
    scores: number[];
    windowSize: number;
  }>;
};

type WakeEnrollment = {
  awaitingSample: boolean;
  samples: number[][];
};

const personalWakeEnrollmentSamples = 12;
// Enrollment happens under one room/distance condition, while later summons
// can land a few thousandths lower. Preserve the trained threshold on disk and
// apply only a small runtime tolerance; ordinary speech remains materially
// below this boundary.
const personalWakeRuntimeTolerance = 0.015;
const personalWakeSingleHitBoost = 0.02;
const personalWakeConfirmationMs = 4_000;
let personalWakeModel: PersonalWakeModel | null = null;
let wakeEnrollment: WakeEnrollment | null = null;

function snapshotWakeFeatures() {
  const keyword = (wakeEngine as WakeEngineInternals)._keywordModels?.[voiceConfig.wakeKeyword];
  if (!keyword?.history?.length || keyword.history.some((embedding) => embedding.length !== 96)) return null;
  const flattened = new Array<number>(keyword.history.length * 96);
  let offset = 0;
  let energy = 0;
  for (const embedding of keyword.history) {
    for (const value of embedding) {
      const numeric = Number(value);
      flattened[offset] = numeric;
      energy += numeric * numeric;
      offset += 1;
    }
  }
  return energy > 1e-8 ? flattened : null;
}

function reportWakeEnrollment(
  state: 'idle' | 'ready' | 'listening' | 'captured' | 'complete' | 'error',
  message: string
) {
  window.jarvis.reportWakeEnrollmentUpdate({
    state,
    captured: wakeEnrollment?.samples.length ?? personalWakeEnrollmentSamples,
    required: personalWakeEnrollmentSamples,
    message
  });
}

async function captureWakeEnrollmentSample() {
  const enrollment = wakeEnrollment;
  if (!enrollment?.awaitingSample) return;
  enrollment.awaitingSample = false;
  // speech-end is emitted just before the engine finishes the final inference
  // for that 80ms block. Let that inference publish its last embedding before
  // taking the snapshot; no second microphone or recording path is opened.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
  if (wakeEnrollment !== enrollment) return;
  const sample = snapshotWakeFeatures();
  if (!sample) {
    reportWakeEnrollment('error', '这次没有得到完整特征，请靠近一点再录一次。');
    return;
  }
  enrollment.samples.push(sample);
  if (enrollment.samples.length < personalWakeEnrollmentSamples) {
    reportWakeEnrollment('captured', '已录入。换一个自然的距离或语气，再录下一次。');
    return;
  }

  try {
    const model = {
      ...trainPersonalWakeModel('ashley', enrollment.samples),
      mode: 'active' as const,
      rescueMode: 'active' as const
    };
    await window.jarvis.savePersonalWakeModel(model);
    personalWakeModel = model;
    recordVoiceEvent(
      `Personal wake enrollment complete: samples=${model.enrollment.sampleCount}, `
      + `threshold=${model.threshold.toFixed(3)}, mode=active.`
    );
    reportWakeEnrollment(
      'complete',
      `录入完成，Ashley 独立召唤已经启用。个人匹配阈值为 ${model.threshold.toFixed(3)}。`
    );
  } catch (error) {
    reportWakeEnrollment('error', `模型建立失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectPersonalWakeAtSpeechEnd() {
  const model = personalWakeModel;
  if (
    wakeEnrollment
    || !model
    || model.mode === 'off'
    || (model.rescueMode ?? 'off') === 'off'
    || !wakeRunning
    || wakeTransition
    || activeSession
    || performance.now() < wakeWarmupUntil
    || performance.now() < wakeResumeNotBefore
  ) return;

  // The engine emits speech-end immediately before publishing the last 80ms
  // inference. Wait for that feature update, then let the personal templates
  // inspect the complete utterance even when the borrowed keyword model did
  // not emit a candidate at all. This is initially shadow-only because it also
  // sees ordinary speech; activation requires real-world score separation.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
  if (
    personalWakeModel !== model
    || !wakeRunning
    || wakeTransition
    || activeSession
  ) return;
  const features = snapshotWakeFeatures();
  if (!features) return;
  try {
    const startedAt = performance.now();
    const personalScore = scorePersonalWake(model, features);
    const latencyMs = performance.now() - startedAt;
    const configuredRescueThreshold = model.rescueThreshold ?? model.threshold;
    const rescueThreshold = Math.max(0.45, configuredRescueThreshold - personalWakeRuntimeTolerance);
    const nearThreshold = rescueThreshold - 0.12;
    if (personalScore >= nearThreshold) {
      recordVoiceEvent(
        `Personal wake rescue ${model.rescueMode}: score=${personalScore.toFixed(3)}, `
        + `threshold=${rescueThreshold.toFixed(3)} `
        + `(configured=${configuredRescueThreshold.toFixed(3)}), `
        + `latency=${latencyMs.toFixed(1)}ms.`
      );
    }
    if (model.rescueMode === 'active' && personalScore >= rescueThreshold) {
      const now = performance.now();
      const strongSingleHit = personalScore >= Math.min(
        0.98,
        configuredRescueThreshold + personalWakeSingleHitBoost
      );
      const repeatedCandidate = pendingPersonalWakeCandidateAt > 0
        && now - pendingPersonalWakeCandidateAt <= personalWakeConfirmationMs;
      if (strongSingleHit || repeatedCandidate) {
        recordVoiceEvent(
          `Personal wake rescue accepted an utterance missed by the community model `
          + `(score=${personalScore.toFixed(3)}, `
          + `confirmation=${strongSingleHit
            ? 'strong-single'
            : `repeated:${pendingPersonalWakeCandidateScore.toFixed(3)},${personalScore.toFixed(3)}`}).`
        );
        pendingPersonalWakeCandidateAt = 0;
        pendingPersonalWakeCandidateScore = 0;
        await handleWakeDetection(1, features);
      } else {
        pendingPersonalWakeCandidateAt = now;
        pendingPersonalWakeCandidateScore = personalScore;
        recordVoiceEvent(
          `Personal wake rescue candidate requires a second match `
          + `(score=${personalScore.toFixed(3)}).`
        );
      }
    }
  } catch (error) {
    recordVoiceEvent(
      `Personal wake rescue bypassed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function handleWakeSpeechEnd() {
  if (wakeEnrollment) {
    await captureWakeEnrollmentSample();
    return;
  }
  await inspectPersonalWakeAtSpeechEnd();
}

function handleWakeEnrollmentCommand(command: 'start' | 'capture' | 'cancel') {
  if (command === 'cancel') {
    wakeEnrollment = null;
    return;
  }
  if (command === 'start') {
    wakeEnrollment = { awaitingSample: false, samples: [] };
    if (wakeRunning) {
      reportWakeEnrollment('ready', '准备好了。点击按钮后，自然说一遍 “Ashley”。');
      return;
    }
    reportWakeEnrollment('idle', '正在等待现有唤醒麦克风就绪…');
    const enrollment = wakeEnrollment;
    const waitUntilReady = (attempt: number) => {
      if (wakeEnrollment !== enrollment) return;
      if (wakeRunning) {
        reportWakeEnrollment('ready', '准备好了。点击按钮后，自然说一遍 “Ashley”。');
        return;
      }
      if (attempt >= 40) {
        reportWakeEnrollment('error', '唤醒麦克风仍未就绪，请关闭窗口后检查 Jarvis。');
        return;
      }
      window.setTimeout(() => waitUntilReady(attempt + 1), 250);
    };
    window.setTimeout(() => waitUntilReady(1), 250);
    return;
  }
  if (!wakeEnrollment || !wakeRunning || activeSession) {
    reportWakeEnrollment('error', '请先让 Ashley 退下并等待本地唤醒恢复，再继续录入。');
    return;
  }
  wakeEnrollment.awaitingSample = true;
  reportWakeEnrollment('listening', '请现在自然说一遍 “Ashley”。');
}

let wakeEngineStartedAt = 0;
let wakeHealthTimer: number | null = null;
let wakeHealthRecoveryRunning = false;
// Initial startup can legitimately wait on macOS microphone authorisation.
// The health timer must not interpret that pending start as a dead listener and
// open a second stream; two concurrent wakeEngine.start() calls race for the
// same AudioContext and have produced DOMException plus minute-long delays.
let wakeStartInProgress = false;
// Long-idle failures showed a live microphone/VAD but no keyword candidates
// after roughly an hour. Refreshing well before that clears the VAD recurrent
// state, embedding history and AudioWorklet without changing sensitivity.
const wakeEngineHardRefreshMs = 12 * 60_000;
const wakeHealthCheckMs = 10_000;

function log(message: string) {
  console.log(`[Jarvis] ${message}`);
}

function recordVoiceEvent(message: string) {
  log(message);
  window.jarvis.reportVoiceEvent(message);
}

function createOutputAudioQuality(): OutputAudioQuality {
  return {
    samples: 0,
    packetsReceived: 0,
    packetsLost: 0,
    concealedSamples: 0,
    concealmentEvents: 0,
    maxJitterSeconds: null,
    maxJitterBufferDelaySeconds: null
  };
}

function describeMillis(seconds: number | null) {
  return seconds === null ? 'n/a' : `${Math.round(seconds * 1_000)}ms`;
}

function captureOutputAudioStats(
  quality: OutputAudioQuality,
  previous: InboundAudioTransportStats,
  current: InboundAudioTransportStats
) {
  const received = Math.max(0, current.packetsReceived - previous.packetsReceived);
  const lost = Math.max(0, current.packetsLost - previous.packetsLost);
  const concealedSamples = Math.max(0, current.concealedSamples - previous.concealedSamples);
  const concealmentEvents = Math.max(0, current.concealmentEvents - previous.concealmentEvents);
  quality.samples += 1;
  quality.packetsReceived += received;
  quality.packetsLost += lost;
  quality.concealedSamples += concealedSamples;
  quality.concealmentEvents += concealmentEvents;
  if (current.jitterSeconds !== null) {
    quality.maxJitterSeconds = Math.max(quality.maxJitterSeconds ?? 0, current.jitterSeconds);
  }
  if (
    current.jitterBufferDelaySeconds !== null &&
    current.jitterBufferEmittedCount !== null &&
    current.jitterBufferEmittedCount > 0
  ) {
    const bufferDelay = current.jitterBufferDelaySeconds / current.jitterBufferEmittedCount;
    quality.maxJitterBufferDelaySeconds = Math.max(
      quality.maxJitterBufferDelaySeconds ?? 0,
      bufferDelay
    );
  }
}

async function sampleRealtimeAudioStats(
  session: VoiceSession,
  outputQuality: OutputAudioQuality | null = null
) {
  try {
    const current = await session.provider.readOutputAudioTransportStats();
    if (!current) return;
    const previous = session.lastInboundAudioStats;
    session.lastInboundAudioStats = current;
    if (previous && outputQuality) captureOutputAudioStats(outputQuality, previous, current);
  } catch (error) {
    // A provider can close while an asynchronous stats read is in flight.
    if (activeSession === session) {
      console.warn('[Jarvis] Unable to read Realtime audio transport stats.', error);
    }
  }
}

function logOutputAudioQuality(quality: OutputAudioQuality) {
  if (quality.samples === 0) {
    const summary = 'Realtime audio diagnostic: no inbound audio transport samples were available.';
    log(summary);
    window.jarvis.reportAudioDiagnostic(summary);
    return;
  }
  const totalPackets = quality.packetsReceived + quality.packetsLost;
  const lossRate = totalPackets > 0 ? (quality.packetsLost / totalPackets) * 100 : 0;
  const warning =
    lossRate >= 1 ||
    (quality.maxJitterSeconds ?? 0) >= 0.035 ||
    quality.concealmentEvents > 0;
  const summary =
    `Realtime audio ${warning ? 'warning' : 'diagnostic'}: ` +
      `loss=${quality.packetsLost}/${totalPackets} (${lossRate.toFixed(2)}%), ` +
      `jitter=${describeMillis(quality.maxJitterSeconds)}, ` +
      `buffer=${describeMillis(quality.maxJitterBufferDelaySeconds)}, ` +
      `concealment=${quality.concealedSamples} samples/${quality.concealmentEvents} events.`;
  log(summary);
  window.jarvis.reportAudioDiagnostic(summary);
}

function startRealtimeAudioDiagnostics(session: VoiceSession) {
  if (session.audioStatsTimer !== null) return;
  void sampleRealtimeAudioStats(session);
  session.audioStatsTimer = window.setInterval(() => {
    void sampleRealtimeAudioStats(session, outputAudioPlaying ? session.outputAudioQuality : null);
  }, 1_000);
}

function stopRealtimeAudioDiagnostics(session: VoiceSession) {
  if (session.audioStatsTimer !== null) window.clearInterval(session.audioStatsTimer);
  session.audioStatsTimer = null;
  session.lastInboundAudioStats = null;
  session.outputAudioQuality = null;
}

function reportState(state: JarvisState) {
  window.jarvis.reportState(state);
}

async function enableWakeMicrophoneSpeechProcessing() {
  const track = (wakeEngine as WakeEngineWithMediaStream)._mediaStream?.getAudioTracks()[0];
  if (!track) return;

  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints: MediaTrackConstraints = {};
  if (supported.echoCancellation) constraints.echoCancellation = true;
  if (supported.noiseSuppression) constraints.noiseSuppression = true;
  if (supported.autoGainControl) constraints.autoGainControl = true;
  if (supported.channelCount) constraints.channelCount = { ideal: 1 };

  track.contentHint = 'speech';
  try {
    await track.applyConstraints(constraints);
    const settings = track.getSettings();
    log(
      `Wake speech processing: noiseSuppression=${settings.noiseSuppression ?? 'unsupported'}, ` +
        `echoCancellation=${settings.echoCancellation ?? 'unsupported'}, ` +
        `autoGainControl=${settings.autoGainControl ?? 'unsupported'}.`
    );
  } catch (error) {
    console.warn('[Jarvis] Unable to enable every wake-microphone speech constraint.', error);
  }
}

async function startWakeWord() {
  if (wakeRunning || wakeStartInProgress || wakeTransition || activeSession) return;
  wakeStartInProgress = true;
  try {
    if (!wakeLoaded) {
      log('Loading local OpenWakeWord models.');
      await wakeEngine.load();
      wakeLoaded = true;
      log('Local OpenWakeWord model ready.');
    }
    // Arm the warm-up window *before* the engine opens the microphone. The
    // engine can emit a detection on its very first inference, and the awaits
    // below take tens of milliseconds — long enough that setting this
    // afterwards left the guard holding an expired value from the previous
    // start, so every detection in exactly the window that needed guarding
    // sailed straight through.
    wakeWarmupUntil = performance.now() + wakeWarmupMs;
    pendingWakeCandidateAt = 0;
    pendingWakeCandidateScore = 0;
    pendingPersonalWakeCandidateAt = 0;
    pendingPersonalWakeCandidateScore = 0;
    await wakeEngine.start({ gain: voiceConfig.wakeGain });
    await enableWakeMicrophoneSpeechProcessing();
    wakeRunning = true;
    wakeEngineStartedAt = performance.now();
    // Re-arm from the moment the engine is actually considered live, so the full
    // warm-up applies no matter how long startup took.
    wakeWarmupUntil = performance.now() + wakeWarmupMs;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const defaultMicrophone = devices.find(
      (device) => device.kind === 'audioinput' && device.deviceId === 'default'
    );
    log(`Wake microphone: ${defaultMicrophone?.label || 'system default input'}.`);
    recordVoiceEvent('Listening locally for “Hey Jarvis”.');
  } catch (error) {
    console.error('[Jarvis] Unable to start local wake-word detection.', error);
  } finally {
    wakeStartInProgress = false;
  }
}

async function stopWakeWord() {
  if (!wakeRunning) return;
  wakeRunning = false;
  wakeEngineStartedAt = 0;
  pendingWakeCandidateAt = 0;
  pendingWakeCandidateScore = 0;
  pendingPersonalWakeCandidateAt = 0;
  pendingPersonalWakeCandidateScore = 0;
  await wakeEngine.stop();
}

async function recoverWakeWord(reason: string) {
  if (
    wakeHealthRecoveryRunning ||
    wakeStartInProgress ||
    activeSession ||
    wakeTransition ||
    shuttingDown ||
    performance.now() < wakeResumeNotBefore
  ) return;

  wakeHealthRecoveryRunning = true;
  recordVoiceEvent(`Wake-word self-recovery: ${reason}.`);
  try {
    await stopWakeWord();
    await startWakeWord();
    if (wakeRunning) recordVoiceEvent('Wake-word self-recovery completed.');
  } catch (error) {
    console.error('[Jarvis] Wake-word self-recovery failed.', error);
  } finally {
    wakeHealthRecoveryRunning = false;
  }
}

async function maintainWakeWordHealth() {
  if (
    activeSession ||
    wakeStartInProgress ||
    wakeTransition ||
    shuttingDown ||
    performance.now() < wakeResumeNotBefore
  ) return;
  if (!wakeRunning) {
    await recoverWakeWord('listener was no longer running');
    return;
  }

  const internals = wakeEngine as WakeEngineInternals;
  const context = internals._audioContext;
  const track = internals._mediaStream?.getAudioTracks()[0];
  const contextState = context?.state as string | undefined;

  if (context && contextState === 'suspended') {
    try {
      await context.resume();
      if (context.state === 'running') {
        recordVoiceEvent('Wake-word AudioContext resumed after idle suspension.');
        return;
      }
    } catch {
      // Reopening the complete stream below is more reliable than repeatedly
      // calling resume() on a context macOS has already invalidated.
    }
  }

  if (!context || !internals._workletNode || !track) {
    await recoverWakeWord('audio pipeline disappeared while idle');
    return;
  }
  if (contextState === 'closed' || contextState === 'interrupted') {
    await recoverWakeWord(`AudioContext became ${contextState}`);
    return;
  }
  if (track.readyState !== 'live' || !track.enabled || track.muted) {
    await recoverWakeWord(
      `microphone track unhealthy (state=${track.readyState}, enabled=${track.enabled}, muted=${track.muted})`
    );
    return;
  }
  if (wakeEngineStartedAt > 0 && performance.now() - wakeEngineStartedAt >= wakeEngineHardRefreshMs) {
    await recoverWakeWord('scheduled long-idle state refresh');
  }
}

function clearSessionTimers() {
  if (disconnectTimer !== null) window.clearTimeout(disconnectTimer);
  if (microphoneUnmuteTimer !== null) window.clearTimeout(microphoneUnmuteTimer);
  disconnectTimer = null;
  microphoneUnmuteTimer = null;
}

function muteRealtimeMicrophoneUntil(
  microphone: MediaStream,
  microphoneTrack: MediaStreamTrack,
  deadline: number
) {
  const delay = Math.max(0, deadline - performance.now());
  if (microphoneUnmuteTimer !== null) window.clearTimeout(microphoneUnmuteTimer);
  microphoneUnmuteTimer = null;
  if (delay <= 0) {
    microphoneTrack.enabled = true;
    return;
  }
  microphoneTrack.enabled = false;
  microphoneUnmuteTimer = window.setTimeout(() => {
    microphoneUnmuteTimer = null;
    if (activeSession?.microphone === microphone) {
      microphoneTrack.enabled = true;
      log('Realtime microphone enabled after assembly sound completed.');
    }
  }, delay);
}

function interruptAssistantSpeechForUser() {
  // The server has confirmed real speech, so the provisional local mute becomes
  // a real interruption. Clear the pending timer first: nothing should resume
  // playback after this point.
  if (localBargeInTimer !== null) window.clearTimeout(localBargeInTimer);
  localBargeInTimer = null;
  localBargeInMuted = false;

  if (providerHandlesInterruptionNatively()) {
    // Seeduplex decides for itself whether this counts as an interruption, and
    // telling it to cancel corrupts its generation state. But its audio arrives
    // as chunks that WE queue locally — when the server stops generating, the
    // seconds already sitting in that queue keep playing. That was heard as
    // "cannot interrupt at all" and as tool calls (like exiting) appearing to
    // fire tens of seconds late: they fired on time, behind stale audio.
    //
    // So: flush our local buffer, leave the model's turn alone.
    if (outputAudioPlaying) {
      recordVoiceEvent('User speech: flushed locally queued provider audio.');
      clearChunkAudioQueue(activeSession);
      outputAudioPlaying = false;
      nativeAudioTailUntil = performance.now() + 120;
      if (activeSession) activeSession.outputAudioQuality = null;
      window.jarvis.reportLevel(0);
    }
    return;
  }

  if (outputAudioPlaying) {
    recordVoiceEvent('User speech interrupted Realtime narration.');
    interruptProviderOutput({ clearOutputAudio: outputAudioPlaying });
    if (outputAudioPlaying) {
      // A cleared provider output buffer does not always emit a matching
      // audio-ended event. Reset the local playback state
      // immediately so later commands are not treated as interruptions of an
      // answer that no longer exists.
      outputAudioPlaying = false;
      nativeAudioTailUntil = performance.now() + 120;
      if (activeSession) activeSession.outputAudioQuality = null;
      window.jarvis.reportLevel(0);
    }
  }
}

// Deterministic exit fallback.
//
// Logged evidence: the ASR heard "拜拜。" perfectly, the model replied "好的拜拜"
// out loud, and no tool call happened — on the first exchange of a session,
// consistently. The model treats a farewell right after waking as small talk to
// answer rather than an instruction to act on, and the instructions already say
// otherwise as plainly as they can.
//
// The user cannot recover from this by talking, because talking is the thing
// that failed. So exit stops being a matter of model obedience: if the user's
// utterance IS a farewell, verbatim, and the model has not called
// end_conversation shortly after, the client calls it. The transcript must
// match a whole farewell phrase exactly — a 拜拜 buried in a longer sentence
// never triggers it.
// Which utterances get a safety net, and which tool they fall back to.
//
// Both entries here are commands the user cannot retry their way out of if the
// model ignores them: saying goodbye when the assistant will not leave, and
// calling it back when it stays hidden behind another window. Everything else
// is left entirely to the model, because a wrong guess there is worse than a
// missed call.
//
// Matching is on the WHOLE utterance after punctuation is stripped. "拜拜"
// inside a longer sentence never fires this.
type SpokenCommandFallback = {
  tool: string;
  delayMs: number;
  arguments?: (rawText: string) => Record<string, unknown>;
  matches?: (rawText: string) => boolean;
  // Whole-utterance match, for phrases short and stable enough to enumerate.
  phrases?: Set<string>;
  // Keyword match, only within an utterance shorter than maxLength.
  keywords?: string[];
  excludeKeywords?: string[];
  maxLength?: number;
};

function inferSpokenGuanlanOpenRequest(rawText: string): Record<string, unknown> | null {
  const compact = rawText.replace(/[，。！？!?,.\s]/g, '');
  return compact.includes('观澜')
    && /(打开|启动|显示|调出来|切到最前|切到前台|放到最前|放到前台)/u.test(compact)
    ? { application: '观澜' }
    : null;
}

function inferSpokenGuanlanCloseRequest(rawText: string): Record<string, unknown> | null {
  const compact = rawText.replace(/[，。！？!?,.\s]/g, '');
  return compact.includes('观澜')
    && /(关闭|关掉|关了|退出|结束|停止)/u.test(compact)
    && !/(播报|汇报|查询|分析|声音|语音)/u.test(compact)
    ? { application: '观澜' }
    : null;
}

const spokenCommandFallbacks: SpokenCommandFallback[] = [
  {
    // Placed first on purpose. "隐藏" has no obvious tool for the model to
    // reach for, and the nearest thing in the whole list is end_conversation —
    // so the failure mode this guards against is not silence, it is the session
    // ending in the middle of the work the user was asking to see.
    //
    // Only the visual window is hidden: the microphone, provider session and
    // conversation all carry on.
    tool: 'send_jarvis_back',
    delayMs: 900,
    matches: (rawText) => inferSpokenHideRequest(rawText),
    arguments: () => ({})
  },
  {
    // "打开观澜" was answered verbally without any tool call, and the
    // follow-up "切到最前面" was incorrectly routed to the data-query tool.
    // Opening or foregrounding this known local app is reversible, so do not
    // leave it to provider tool-selection alone.
    tool: 'open_application',
    delayMs: 900,
    matches: (rawText) => inferSpokenGuanlanOpenRequest(rawText) !== null,
    arguments: (rawText) => inferSpokenGuanlanOpenRequest(rawText) ?? {}
  },
  {
    // Closing Guanlan is a request about that app, never a request to quit
    // Jarvis. Keep this deterministic because a mistaken quit_jarvis call
    // would remove the user's only voice path for correcting it.
    tool: 'close_application',
    delayMs: 900,
    matches: (rawText) => inferSpokenGuanlanCloseRequest(rawText) !== null,
    arguments: (rawText) => inferSpokenGuanlanCloseRequest(rawText) ?? {}
  },
  {
    // A real AI-review question was followed by an interrupted tool result;
    // the provider then answered the repeated question from its own context
    // and invented a review that the database explicitly said did not exist.
    // Always refresh this high-stakes, read-only fact from Guanlan.
    tool: 'query_guanlan',
    delayMs: 900,
    keywords: ['会审'],
    maxLength: 50,
    arguments: (rawText) => ({ question: rawText })
  },
  {
    // Seeduplex answered an explicit "用酷狗播放周杰伦的稻香" as if the
    // request had already been completed, then routed the follow-up to the
    // play/pause control. A named player plus a named song is deterministic
    // and reversible, so make the actual search/play independent of model
    // obedience.
    tool: 'play_music',
    // Real Seeduplex play_music calls in captured sessions arrived 1.003–
    // 1.045s after final ASR. The old 1.000s fallback therefore raced them and
    // ran the same request twice. Leave a small margin before taking over.
    delayMs: 1_450,
    matches: (rawText) => inferSpokenMusicRequest(rawText) !== null,
    arguments: (rawText) => inferSpokenMusicRequest(rawText) ?? {}
  },
  {
    // Enumerating whole farewells failed the same way enumerating summons did.
    // The list had 退下 and 结束 but not 退出, so "退出。" — one character off —
    // fell through and the user had to say it twice. There are too many ways to
    // say goodbye to list them all.
    //
    // Keyword-in-a-short-utterance instead, with the same length limit doing
    // the safety work: a real farewell is a few characters, while "这个功能怎么
    // 退出" or "帮我看看怎么结束进程" are longer and never match.
    keywords: [
      '拜拜', '再见', '退下', '退出', '没事了', '不用了', '先这样',
      '结束', '休眠', '待机', '好了', '就这样', '不聊了', '走吧', '睡吧'
    ],
    // Six, not eight: at eight both 这个功能怎么退出 and 退出登录要点哪里 slipped
    // through. Real farewells are short.
    maxLength: 6,
    tool: 'end_conversation',
    delayMs: 2_500
  },
  {
    // Asked about the weather, the model answered "我没有权限" without ever
    // calling the tool — the credentials and default city were configured the
    // whole time. Inventing a limitation is worse than failing, because the
    // user has no reason to try again.
    //
    // Weather is read-only and repeatable, so a spurious call costs nothing.
    keywords: ['天气', '气温', '多少度', '冷不冷', '热不热', '带伞', '下雨'],
    maxLength: 15,
    tool: 'get_weather',
    delayMs: 2_000
  },
  {
    // Rotation is visual, local and reversible. Seeduplex occasionally speaks
    // a confirmation without calling rotate_helmet at all, which looks like a
    // completely dead assistant. Keep explicit rotation commands reliable,
    // including a long ASR turn that contains repeated attempts.
    // ASR may collapse “转一圈给我看” into “转圈，我看一下”, so match the
    // stable action word as well as the more specific phrasings.
    keywords: [
      '转圈', '转一圈', '转个圈', '转一下', '转给我看',
      '旋转一圈', '转起来', '顺时针转', '逆时针转'
    ],
    excludeKeywords: ['不要转', '不用转', '别转', '停止转', '取消转'],
    maxLength: 50,
    tool: 'rotate_helmet',
    delayMs: 1_200,
    arguments: (rawText) => ({
      view: 'spin',
      direction: rawText.includes('逆时针')
        ? 'counterclockwise'
        : rawText.includes('顺时针')
          ? 'clockwise'
          : 'random'
    })
  },
  {
    // Exact matching is too brittle here. Farewells are short and stable, but a
    // summon is not: "怎么看不到你" and "怎么没看到你" differ by one character
    // and only the second was listed, so a real summon slipped through. Names
    // vary too — the transcript may come back as Jarvis, jarvis or 贾维斯.
    //
    // So this entry matches a keyword inside a SHORT utterance instead. The
    // length limit is what keeps it safe: "贾维斯是谁演的" and "帮我用 Jarvis
    // 查点东西" are past the limit and never trigger it.
    keywords: [
      'ashley', '艾希莉', '艾什莉', '阿什利',
      'jarvis', '贾维斯', '出来', '现身', '回来', '看到你', '看不到', '你在哪', '你在吗'
    ],
    // Six characters, tested against real phrasings. Seven would let
    // "贾维斯是谁演的" through, and twelve let in "这部电影里贾维斯很酷".
    // A summon is always short; anything longer is talking *about* Jarvis.
    maxLength: 6,
    tool: 'show_jarvis',
    // Shorter than the exit fallback: this one is purely visual, so a brief
    // wait for the model to do it itself is all that is warranted.
    delayMs: 1_500
  },
  {
    // The user asked to switch Spaces and the transcript shows no
    // switch_desktop call at all — the same miss as weather and rotation.
    // Requiring the word 桌面 keeps this narrow: "切换一下输入法" and
    // "换个话题" do not contain it.
    keywords: ['桌面'],
    excludeKeywords: ['壁纸', '背景', '图标', '整理', '文件', '保存到', '放到', '新建'],
    maxLength: 20,
    tool: 'switch_desktop',
    delayMs: 1_800,
    arguments: (rawText) => ({
      destination: inferDesktopSwitchDestination(rawText) ?? 'next'
    })
  }
];

let spokenCommandFallbackTimer: number | null = null;
let spokenCommandFallbackTool: string | null = null;
let partialUserTranscript = '';
let partialFarewellTimer: number | null = null;
// The most recent thing the user actually said, as the provider transcribed it.
// Irreversible tools check this before acting, because the model's choice of
// tool has proven unreliable enough that "close 抖音" reached quit_jarvis.
let lastUserUtterance = '';

function cancelSpokenCommandFallback(tool: string) {
  if (spokenCommandFallbackTool !== tool || spokenCommandFallbackTimer === null) return;
  window.clearTimeout(spokenCommandFallbackTimer);
  spokenCommandFallbackTimer = null;
  spokenCommandFallbackTool = null;
}

function beginDoubaoFarewellConfirmation() {
  if (!activeSession || activeSession.provider.name !== 'doubao') return;
  if (sleepRequested) return;
  sleepRequested = true;
  sleepConfirmationPending = true;
  sleepConfirmationPlaying = false;
  if (sleepFallbackTimer !== null) window.clearTimeout(sleepFallbackTimer);
  sleepFallbackTimer = window.setTimeout(() => {
    void stopRealtimeSession('Conversation ended by voice request.');
  }, doubaoFarewellFallbackMs);
  recordVoiceEvent(
    `Farewell accepted locally; waiting for Doubao confirmation audio (fallback=${doubaoFarewellFallbackMs}ms).`
  );
}

function matchesShortFarewell(rawText: string) {
  const normalized = rawText.replace(/[。，、！？!?,.\s]/g, '').toLowerCase();
  const farewell = spokenCommandFallbacks.find((entry) => entry.tool === 'end_conversation');
  if (!farewell || normalized.length > (farewell.maxLength ?? 6)) return false;
  if (farewell.excludeKeywords?.some((keyword) => normalized.includes(keyword))) return false;
  if (farewell.phrases?.has(normalized)) return true;
  return farewell.keywords?.some((keyword) => normalized.includes(keyword)) ?? false;
}

function observePartialUserTranscript(delta: string) {
  if (activeSession?.provider.name !== 'doubao' || sleepRequested || !delta) return;
  // Providers differ on whether a delta is incremental or the full transcript
  // so far. Handle both without duplicating the cumulative form.
  partialUserTranscript = delta.startsWith(partialUserTranscript)
    ? delta
    : partialUserTranscript + delta;
  if (partialFarewellTimer !== null) window.clearTimeout(partialFarewellTimer);
  partialFarewellTimer = null;
  if (!matchesShortFarewell(partialUserTranscript)) return;
  partialFarewellTimer = window.setTimeout(() => {
    partialFarewellTimer = null;
    if (!activeSession || sleepRequested) return;
    recordVoiceEvent(
      `Farewell accepted from partial transcript: ${JSON.stringify(partialUserTranscript.slice(0, 30))}.`
    );
    beginDoubaoFarewellConfirmation();
  }, 650);
}

function clearPartialUserTranscript() {
  partialUserTranscript = '';
  if (partialFarewellTimer !== null) window.clearTimeout(partialFarewellTimer);
  partialFarewellTimer = null;
}

function armSpokenCommandFallback(rawText: string) {
  const providerName = activeSession?.provider.name;
  if (!providerName) return;
  if (sleepRequested) return;

  const normalized = rawText.replace(/[。，、！？!?,.\s]/g, '');
  const lowered = normalized.toLowerCase();
  const match = spokenCommandFallbacks.find((entry) => {
    if (entry.excludeKeywords?.some((keyword) => lowered.includes(keyword))) return false;
    if (entry.matches?.(rawText)) return true;
    if (entry.phrases?.has(normalized)) return true;
    if (!entry.keywords) return false;
    if (normalized.length > (entry.maxLength ?? 12)) return false;
    return entry.keywords.some((keyword) => lowered.includes(keyword));
  });
  if (!match) return;

  // Most deterministic fallbacks remain Doubao-specific. Farewell is the
  // exception: an accidental OpenAI fallback ignored "退出" and entered a
  // response-cancellation loop, leaving the user unable to end the session.
  if (providerName !== 'doubao' && match.tool !== 'end_conversation') return;

  // The old path waited 2.5 seconds and then synthesized “好的” through
  // OpenAI TTS. When that account had no balance, a perfectly recognized
  // farewell appeared to do nothing. Doubao is already producing the reply
  // for this turn, so accept the command immediately, let that short reply
  // drain, and stop as soon as its audio-ended event arrives.
  if (match.tool === 'end_conversation' && providerName === 'doubao') {
    beginDoubaoFarewellConfirmation();
    return;
  }

  if (spokenCommandFallbackTimer !== null) window.clearTimeout(spokenCommandFallbackTimer);
  spokenCommandFallbackTool = match.tool;
  spokenCommandFallbackTimer = window.setTimeout(() => {
    spokenCommandFallbackTimer = null;
    spokenCommandFallbackTool = null;
    if (sleepRequested || !activeSession) return;
    // completedToolCalls is keyed by call id, so a model call and this one never
    // collide; the tool handlers themselves are safe to run twice.
    recordVoiceEvent(`Heard a command the model did not act on; calling ${match.tool} locally.`);
    void executeFunctionCall({
      id: `local-${match.tool}-${Date.now()}`,
      name: match.tool,
      arguments: JSON.stringify(match.arguments?.(rawText) ?? {})
    });
  }, match.delayMs);
}

function updateOutputLevel() {
  const session = activeSession;
  if (!session?.analyser || !session.analyserData) return;
  // Provider audio still arrives while playback is locally muted. Reporting
  // its level would leave the helmet talking to itself in silence.
  if (localBargeInMuted) {
    window.jarvis.reportLevel(0);
    session.levelFrame = requestAnimationFrame(updateOutputLevel);
    return;
  }
  session.analyser.getByteTimeDomainData(session.analyserData);
  let sum = 0;
  for (const value of session.analyserData) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const level = Math.min(1, Math.sqrt(sum / session.analyserData.length) * voiceConfig.outputLevelScale);
  window.jarvis.reportLevel(level);
  session.levelFrame = requestAnimationFrame(updateOutputLevel);
}

// Barge-in used to depend entirely on the provider: microphone audio travelled
// to the server, server VAD decided the user was speaking, that verdict came
// back as a semantic user-speech-start event, and only then did the client
// request an interruption. Three network legs before a sample stops playing —
// well over a second on a long or proxied link, which is why the assistant kept
// talking over the user and then answered the wrong question.
//
// What the user actually perceives as "it stopped" is the speaker going quiet,
// and that is entirely local. So watch the microphone here, silence playback the
// instant speech begins, and only then tell the server. The network round trip
// still happens, but it no longer sits between the user and the silence.
// The local monitor is fast but not smart: it hears energy, not language. A
// burst of typing next to the laptop looks exactly like the start of a word.
//
// So the two halves of an interruption are deliberately separated:
//
//   local  — instant, and strictly reversible. Mute playback, nothing else.
//   server — authoritative, and allowed to destroy. Cancel the response and
//            drop queued provider narration.
//
// The local half buys back the network round trip; the server half decides
// whether that silence becomes a real interruption. If the server never
// confirms, playback simply resumes and the user hears a brief dropout instead
// of losing the whole answer.
const inputSpeechRmsThreshold = 0.08;
// Roughly 200ms of sustained energy at 60fps. Speech holds that easily; typing,
// a mouse click and a closing door do not.
const inputSpeechFramesRequired = 12;
// How long to wait for the server to agree before treating it as a false alarm.
const localBargeInConfirmTimeoutMs = 1_200;

let localBargeInMuted = false;
let localBargeInTimer: number | null = null;

function monitorMicrophoneForBargeIn() {
  const session = activeSession;
  if (!session?.inputAnalyser || !session.inputData) return;

  session.inputAnalyser.getByteTimeDomainData(session.inputData);
  let sum = 0;
  for (const value of session.inputData) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / session.inputData.length);

  if (rms >= inputSpeechRmsThreshold) session.loudInputFrames += 1;
  else session.loudInputFrames = 0;

  const assistantAudible = outputAudioPlaying;
  const speaking = session.loudInputFrames >= inputSpeechFramesRequired;

  // Never mute the short "好的" that confirms 退下; that exchange has to finish
  // deterministically or the session never closes.
  if (speaking && assistantAudible && !localBargeInMuted && !sleepRequested
    && performance.now() >= assemblySoundMutedUntil) {
    session.loudInputFrames = 0;
    beginLocalBargeIn();
  }

  session.inputFrame = requestAnimationFrame(monitorMicrophoneForBargeIn);
}

function setPlaybackMuted(muted: boolean) {
  const session = activeSession;
  if (session) setProviderPlaybackMuted(session, muted);
  if (muted) window.jarvis.reportLevel(0);
}

function setProviderPlaybackMuted(session: VoiceSession, muted: boolean) {
  session.audio.muted = muted;
  const chunkPlayback = session.chunkPlayback;
  if (chunkPlayback && chunkPlayback.context.state !== 'closed') {
    chunkPlayback.gain.gain.setValueAtTime(muted ? 0 : 1, chunkPlayback.context.currentTime);
  }
}

function interruptProviderOutput(options: { clearOutputAudio?: boolean } = {}) {
  const session = activeSession;
  if (!session) return false;
  if (options.clearOutputAudio) clearChunkAudioQueue(session);
  return session.provider.interrupt(options);
}

function beginLocalBargeIn() {
  localBargeInMuted = true;
  setPlaybackMuted(true);
  recordVoiceEvent('Local speech detected; playback muted pending server confirmation.');

  if (localBargeInTimer !== null) window.clearTimeout(localBargeInTimer);
  localBargeInTimer = window.setTimeout(() => {
    localBargeInTimer = null;
    if (!localBargeInMuted) return;
    recordVoiceEvent('Server did not confirm the interruption; resuming playback.');
    endLocalBargeIn();
  }, localBargeInConfirmTimeoutMs);
}

function endLocalBargeIn() {
  if (localBargeInTimer !== null) window.clearTimeout(localBargeInTimer);
  localBargeInTimer = null;
  if (!localBargeInMuted) return;
  localBargeInMuted = false;
  setPlaybackMuted(false);
}

function restoreAssistantPlayback() {
  endLocalBargeIn();
  const session = activeSession;
  if (!session) return;
  setProviderPlaybackMuted(session, false);
}

function suppressPlaybackForMusicCommand() {
  musicCommandPlaybackSuppressed = true;
  const session = activeSession;
  if (!session) return;
  clearChunkAudioQueue(session);
  setProviderPlaybackMuted(session, true);
  window.jarvis.reportLevel(0);
}

function releaseMusicCommandPlaybackSuppression() {
  if (!musicCommandPlaybackSuppressed) return;
  musicCommandPlaybackSuppressed = false;
  const session = activeSession;
  if (!session) return;
  // Discard any planning audio already queued before making the provider
  // audible for the post-tool confirmation.
  clearChunkAudioQueue(session);
  setProviderPlaybackMuted(session, false);
}

// Local barge-in exists to hide network latency, and only OpenAI's turn-based
// Realtime API needs it: there, the microphone audio has to reach the server,
// server VAD has to decide the user is speaking, that verdict has to come back,
// and only then does a cancel go out — three legs before the speaker goes
// quiet.
//
// Seeduplex is natively full-duplex. The model listens while it speaks and
// decides for itself when to stop, including deliberate overlap. Muting it
// locally fights that: the client silences audio the model intends to keep
// producing, and the provider is told to cancel a turn it never considered
// over. Let the model own interruption where the model was built for it.
function providerHandlesInterruptionNatively() {
  return activeSession?.provider.name === 'doubao';
}

function startMicrophoneMonitor(microphone: MediaStream) {
  const session = activeSession;
  if (!session) return;
  if (providerHandlesInterruptionNatively()) {
    log(`Local barge-in monitor disabled: ${session.provider.name} handles interruption natively.`);
    return;
  }
  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(microphone);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    session.inputContext = context;
    session.inputAnalyser = analyser;
    session.inputData = new Uint8Array(analyser.fftSize);
    session.loudInputFrames = 0;
    session.inputFrame = requestAnimationFrame(monitorMicrophoneForBargeIn);
    log('Local barge-in monitor active on the microphone.');
  } catch (error) {
    // Losing local barge-in only costs latency; the server path still works.
    console.error('[Jarvis] Unable to start the local barge-in monitor.', error);
  }
}

function releaseOutputAudioAnalysis(session: VoiceSession) {
  if (session.levelFrame !== null) cancelAnimationFrame(session.levelFrame);
  session.levelFrame = null;
  const context = session.analyserContext;
  session.analyserContext = null;
  session.analyser = null;
  session.analyserData = null;
  if (context && context.state !== 'closed') void context.close();
}

function attachStreamOutputAudio(stream: MediaStream) {
  const session = activeSession;
  if (!session) return;
  if (session.chunkPlayback) {
    clearChunkAudioQueue(session);
    session.chunkPlayback = null;
  }
  releaseOutputAudioAnalysis(session);
  session.audio.srcObject = stream;
  void session.audio.play().catch((error) => {
    console.error('[Jarvis] Unable to play Realtime audio.', error);
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  session.analyserContext = context;
  session.analyser = analyser;
  session.analyserData = new Uint8Array(analyser.fftSize);
  session.levelFrame = requestAnimationFrame(updateOutputLevel);
}

function createChunkAudioPlayback(session: VoiceSession, sampleRate: number) {
  const current = session.chunkPlayback;
  if (current && current.context.sampleRate === sampleRate && current.context.state !== 'closed') {
    return current;
  }
  if (current) {
    clearChunkAudioQueue(session);
  }
  releaseOutputAudioAnalysis(session);

  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.65;
  const gain = context.createGain();
  analyser.connect(gain);
  gain.connect(context.destination);

  const playback: ChunkAudioPlayback = {
    context,
    analyser,
    gain,
    sources: new Set(),
    nextStartTime: context.currentTime,
    generation: 0,
    pendingDecodes: 0,
    pendingPcmByte: null,
    decodeChain: Promise.resolve(),
    finishWhenDrained: false
  };
  session.audio.pause();
  session.audio.srcObject = null;
  session.analyserContext = context;
  session.analyser = analyser;
  session.analyserData = new Uint8Array(analyser.fftSize);
  session.chunkPlayback = playback;
  session.levelFrame = requestAnimationFrame(updateOutputLevel);
  void context.resume().catch((error) => {
    console.warn('[Jarvis] Unable to resume chunk audio output.', error);
  });
  return playback;
}

function scheduleChunkAudioBuffer(
  session: VoiceSession,
  playback: ChunkAudioPlayback,
  buffer: AudioBuffer
) {
  if (activeSession !== session || session.chunkPlayback !== playback) return;
  const source = playback.context.createBufferSource();
  source.buffer = buffer;
  source.connect(playback.analyser);
  const startTime = Math.max(playback.context.currentTime + 0.005, playback.nextStartTime);
  playback.nextStartTime = startTime + buffer.duration;
  playback.sources.add(source);
  source.onended = () => {
    playback.sources.delete(source);
    maybeFinishChunkAudioPlayback(session, playback);
  };
  source.start(startTime);
}

function maybeFinishChunkAudioPlayback(session: VoiceSession, playback: ChunkAudioPlayback) {
  if (
    activeSession !== session ||
    session.chunkPlayback !== playback ||
    !playback.finishWhenDrained ||
    playback.pendingDecodes > 0 ||
    playback.sources.size > 0
  ) return;
  playback.finishWhenDrained = false;
  completeAssistantAudioPlayback();
}

function queuePcmAudioChunk(
  session: VoiceSession,
  playback: ChunkAudioPlayback,
  data: Uint8Array,
  sampleRate: number
) {
  let bytes = data;
  if (playback.pendingPcmByte !== null) {
    const combined = new Uint8Array(data.length + 1);
    combined[0] = playback.pendingPcmByte;
    combined.set(data, 1);
    bytes = combined;
    playback.pendingPcmByte = null;
  }
  if (bytes.length % 2 !== 0) {
    playback.pendingPcmByte = bytes[bytes.length - 1] ?? null;
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  const sampleCount = bytes.length / 2;
  if (sampleCount === 0) return;
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  const buffer = playback.context.createBuffer(1, sampleCount, sampleRate);
  buffer.copyToChannel(samples, 0);
  scheduleChunkAudioBuffer(session, playback, buffer);
}

function queueEncodedAudioChunk(
  session: VoiceSession,
  playback: ChunkAudioPlayback,
  data: Uint8Array
) {
  const generation = playback.generation;
  const encoded = new Uint8Array(data);
  playback.pendingDecodes += 1;
  playback.decodeChain = playback.decodeChain.then(async () => {
    try {
      const buffer = await playback.context.decodeAudioData(encoded.buffer);
      if (playback.generation === generation) scheduleChunkAudioBuffer(session, playback, buffer);
    } catch (error) {
      if (playback.generation === generation) {
        console.warn('[Jarvis] Unable to decode provider audio chunk.', error);
      }
    } finally {
      if (playback.generation === generation) {
        playback.pendingDecodes = Math.max(0, playback.pendingDecodes - 1);
        maybeFinishChunkAudioPlayback(session, playback);
      }
    }
  });
}

function queueProviderAudioChunk(audio: Extract<VoiceProviderOutputAudio, { kind: 'chunk' }>) {
  const session = activeSession;
  if (!session || audio.data.length === 0) return;
  const playback = createChunkAudioPlayback(session, audio.sampleRate);
  const format = audio.format.trim().toLowerCase();
  if (format.includes('pcm') || format.includes('s16')) {
    queuePcmAudioChunk(session, playback, audio.data, audio.sampleRate);
  } else {
    queueEncodedAudioChunk(session, playback, audio.data);
  }
}

function clearChunkAudioQueue(session: VoiceSession | null) {
  const playback = session?.chunkPlayback;
  if (!playback) return;
  playback.generation += 1;
  playback.pendingDecodes = 0;
  playback.pendingPcmByte = null;
  playback.finishWhenDrained = false;
  playback.nextStartTime = playback.context.currentTime;
  for (const source of playback.sources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A source that ended between the Set iteration and stop() is harmless.
    }
    source.disconnect();
  }
  playback.sources.clear();
  window.jarvis.reportLevel(0);
}

function handleProviderOutputAudio(audio: VoiceProviderOutputAudio) {
  if (audio.kind === 'stream') attachStreamOutputAudio(audio.stream);
  else queueProviderAudioChunk(audio);
}

function inferDesktopSwitchDestination(task: string) {
  const normalized = task.toLowerCase();
  if (!/(桌面|space|spaces)/u.test(normalized)) return null;
  if (/(第一|第1|1st|first)/u.test(normalized)) return 'first' as const;
  if (/(第二|第2|2nd|second)/u.test(normalized)) return 'second' as const;
  if (/(上一个|上个|previous|prev)/u.test(normalized)) return 'previous' as const;
  if (/(下一个|下个|next)/u.test(normalized)) return 'next' as const;
  // Stepping to the adjacent Space is the reasonable and reversible reading
  // of an unqualified switch request.
  if (/(切换|换到|换个|切到|跳到|切一下)/u.test(normalized)) return 'next' as const;
  return null;
}

async function executeFunctionCall(call: VoiceProviderToolCall) {
  if (!call.id || completedToolCalls.has(call.id)) return;
  if (call.name) cancelSpokenCommandFallback(call.name);
  completedToolCalls.add(call.id);
  // Even if ASR phrasing did not match the deterministic parser, an actual
  // play_music call must never expose Seeduplex's spoken JSON/planning. Mute
  // as soon as the provider identifies the tool and keep it muted until the
  // current audio has genuinely drained.
  if (activeSession?.provider.name === 'doubao' && call.name === 'play_music') {
    suppressPlaybackForMusicCommand();
  }
  reportState('thinking');
  recordVoiceEvent(`Realtime routed turn to tool: ${call.name ?? 'unknown'}.`);

  let output: string;
  let skipResponseCreation = false;
  let responseInstruction: string | null = null;
  try {
    const args = JSON.parse(call.arguments ?? '{}') as Record<string, unknown>;
    const spokenMusicRequest = inferSpokenMusicRequest(lastUserUtterance);
    const spokenGuanlanOpenRequest = inferSpokenGuanlanOpenRequest(lastUserUtterance);
    const spokenGuanlanCloseRequest = inferSpokenGuanlanCloseRequest(lastUserUtterance);
    if (spokenGuanlanCloseRequest) {
      cancelSpokenCommandFallback('close_application');
      if (call.name !== 'close_application') {
        recordVoiceEvent(`Corrected ${call.name ?? 'unknown'} to close_application because the utterance asked to close Guanlan.`);
      }
      output = await window.jarvis.executeAction('close_application', spokenGuanlanCloseRequest);
      responseInstruction = '只根据工具返回的实际结果，用一句简短中文确认观澜已经关闭。';
    } else if ((call.name === 'query_guanlan' || call.name === 'show_jarvis') && spokenGuanlanOpenRequest) {
      cancelSpokenCommandFallback('open_application');
      recordVoiceEvent(`Corrected ${call.name} to open_application because the utterance asked to open Guanlan.`);
      output = await window.jarvis.executeAction('open_application', spokenGuanlanOpenRequest);
      responseInstruction = '只根据工具返回的实际结果，用一句简短中文确认观澜已经打开并切到最前面。';
    } else if (call.name === 'control_music' && spokenMusicRequest) {
      recordVoiceEvent('Corrected control_music to play_music because the utterance named a song.');
      output = await window.jarvis.executeAction('play_music', spokenMusicRequest);
      responseInstruction = '只根据工具返回的实际结果用一句中文确认，不要声称执行了工具没有确认的事情。';
    } else if (call.name === 'end_conversation') {
      skipResponseCreation = true;
      if (activeSession?.provider.name === 'doubao') {
        // The full-duplex provider speaks its own confirmation. Waiting for
        // that audio avoids both an overlapping second voice and any
        // dependency on the separate OpenAI TTS balance.
        beginDoubaoFarewellConfirmation();
      } else {
        sleepRequested = true;
        void stopRealtimeSession('Conversation ended by voice request.');
      }
      output = 'sleep';
    } else if (call.name === 'quit_jarvis') {
      // Guard against the model mistaking "close <some app>" for "close
      // yourself". Observed: the user said 你帮我把抖音关掉吧 and Seeduplex
      // routed it to quit_jarvis, killing the whole assistant.
      //
      // Quitting is irreversible by voice — once the process is gone the user
      // has no way to ask for it back — so it requires the last thing the user
      // said to actually be about Jarvis, not about another app.
      const spokenAboutJarvis =
        /ashley|艾希莉|艾什莉|阿什利|jarvis|贾维斯|你自己|程序|应用|完全退出|彻底退出/i.test(lastUserUtterance);
      const spokenAboutAnotherApp = /观澜|抖音|微信|浏览器|safari|chrome|音乐|邮件|窗口|网页/i.test(lastUserUtterance);
      if (!spokenAboutJarvis || spokenAboutAnotherApp) {
        recordVoiceEvent(
          `Refused quit_jarvis: last utterance ${JSON.stringify(lastUserUtterance.slice(0, 40))} was not about Jarvis.`
        );
        output = '你说的不是关闭我自己，请说得更明确一点。';
        responseInstruction = '只用一句简短中文说明你不确定要关闭什么，请用户说清楚。';
      } else {
        log('Voice-requested full application exit.');
        window.jarvis.quitApp();
        return;
      }
    } else if (call.name === 'perform_head_gesture') {
      const gesture = args.gesture === 'nod' || args.gesture === 'shake'
        ? args.gesture
        : null;
      if (!gesture) throw new Error('头部动作无效。');
      window.jarvis.reportGesture(gesture);
      output = gesture === 'nod' ? 'Ashley 已点头。' : 'Ashley 已摇头。';
      responseInstruction = '只用一句简短的“好的”确认，不要解释或补充。';
    } else if (call.name === 'rotate_helmet') {
      const gestures = {
        front: 'face-front',
        back: 'face-back',
        left: 'face-left',
        right: 'face-right'
      } as const;
      const view = typeof args.view === 'string' ? args.view : '';
      const direction = typeof args.direction === 'string' ? args.direction : 'random';
      const gesture = view === 'spin'
        ? direction === 'clockwise'
          ? 'spin-clockwise'
          : direction === 'counterclockwise'
            ? 'spin-counterclockwise'
            : 'spin'
        : gestures[view as keyof typeof gestures];
      if (!gesture) throw new Error('头盔转动方向无效。');
      window.jarvis.reportGesture(gesture);
      output = '头盔已按用户指定的方向转动。';
      responseInstruction = '只用一句简短的“好的”确认，不要解释或补充。';
    } else if (call.name === 'show_jarvis') {
      output = await window.jarvis.executeAction(call.name, args);
      responseInstruction = '只用一句“我在”回应，不要解释或补充。';
    } else if (call.name === 'get_weather') {
      output = await window.jarvis.executeAction(call.name, args);
      // The tool already returns a finished, speakable sentence. Without this
      // the model narrated its own plumbing — "调用 weather 下划线实时天气" —
      // and only produced the forecast when asked a second time.
      responseInstruction = '把工具返回的那句话原样念出来，一个字都不要增删，不要说任何前缀或后缀。';
    } else if (call.name === 'query_guanlan') {
      output = await window.jarvis.executeAction(call.name, args);
      responseInstruction = '读取工具返回的 JSON。如果 verbatim_answer 是非空字符串，只把 verbatim_answer 原样念出来，一个字都不要增删；否则根据 question、instruction 和 data 回答。只能依据 data，说明数据时间、缺失或过期状态，不要编造，也不要形成自动买卖指令。';
    } else if (call.name === 'play_music' || call.name === 'control_music') {
      output = await window.jarvis.executeAction(call.name, args);
      responseInstruction = '只根据工具返回的实际结果用一句中文确认，不要声称执行了工具没有确认的事情。';
    } else if (call.name) {
      output = await window.jarvis.executeAction(call.name, args);
    } else {
      throw new Error('工具名称缺失。');
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    if (call.name === 'play_music' || call.name === 'control_music') {
      responseInstruction = '工具执行失败。只用一句中文如实说明工具返回的错误，不要说已经播放或已经完成。';
    }
  }

  if (call.name === 'play_music' || call.name === 'control_music') {
    recordVoiceEvent(`Tool ${call.name} result: ${output.slice(0, 300)}`);
  }

  const provider = activeSession?.provider;
  if (!provider?.submitToolResult(call.id, output.slice(0, 24_000))) return;
  if (skipResponseCreation) {
    if (!outputAudioPlaying && !sleepRequested) {
      reportState('listening');
    }
    return;
  }
  const confirmationInstruction = sleepRequested
      ? '只输出两个汉字“好的”。不要标点，不要解释，不要补充任何其他字词。'
      : responseInstruction;
  provider.requestResponse({
    instructions: confirmationInstruction
      ?? '只用一句简短中文确认操作结果，不要调用工具。',
    disableTools: true
  });
}

// Delta events arrive dozens of times per response; logging each occurrence
// would bury everything else. Record the first sighting of each type per
// session, plus every response-lifecycle event, which is what we actually need.
const seenUnhandledEventTypes = new Set<string>();

function recordUnhandledRealtimeEvent(type: string) {
  const isResponseLifecycle = type.startsWith('response.') && !type.includes('.delta');
  if (!isResponseLifecycle && seenUnhandledEventTypes.has(type)) return;
  seenUnhandledEventTypes.add(type);
  recordVoiceEvent(`Unhandled Realtime event: ${type}`);
}

function completeAssistantAudioPlayback() {
  // Audio finished but the turn is still open. This is the signature of a
  // reply that stops mid-sentence with clean network stats: the client
  // stopped playing, but the provider never reported how the response ended.
  if (openResponseId) {
    const heldFor = Math.round(performance.now() - openResponseStartedAt);
    recordVoiceEvent(
      `Output audio stopped while response ${openResponseId} is still open (${heldFor}ms since created).`
    );
  }
  if (activeSession?.outputAudioQuality) {
    const quality = activeSession.outputAudioQuality;
    activeSession.outputAudioQuality = null;
    void sampleRealtimeAudioStats(activeSession, quality).finally(() => logOutputAudioQuality(quality));
  }
  outputAudioPlaying = false;
  nativeAudioTailUntil = performance.now() + 360;
  if (musicCommandPlaybackSuppressed) {
    releaseMusicCommandPlaybackSuppression();
    recordVoiceEvent('Released music-command suppression only after provider audio drained.');
  }
  window.jarvis.reportLevel(0);
  if (sleepRequested && sleepConfirmationPlaying) {
    sleepRequested = false;
    sleepConfirmationPending = false;
    sleepConfirmationPlaying = false;
    if (sleepFallbackTimer !== null) window.clearTimeout(sleepFallbackTimer);
    sleepFallbackTimer = null;
    void stopRealtimeSession('Conversation ended by voice request.');
    return;
  }
  if (!sleepRequested) reportState('listening');
}

function handleVoiceProviderEvent(event: VoiceProviderEvent) {
  switch (event.type) {
    case 'session.ready':
      reportState('listening');
      break;
    case 'transport.connected':
      log('Realtime Mini media connection ready.');
      if (activeSession) startRealtimeAudioDiagnostics(activeSession);
      break;
    case 'transport.disconnected':
      if (disconnectTimer !== null) window.clearTimeout(disconnectTimer);
      disconnectTimer = window.setTimeout(() => void stopRealtimeSession('Realtime disconnected.'), 5000);
      break;
    case 'transport.failed':
    case 'transport.closed':
      void stopRealtimeSession(`Realtime connection ${event.type.split('.')[1]}.`);
      break;
    case 'user.speech.started':
      if (sleepRequested) {
        // Once “退下” has been accepted, protect the very short “好的”
        // confirmation from room noise and finish the exit deterministically.
        break;
      }
      // A new utterance supersedes any older music command whose confirmation
      // has not arrived yet; never leave the provider permanently muted.
      releaseMusicCommandPlaybackSuppression();
      clearPartialUserTranscript();
      interruptAssistantSpeechForUser();
      reportState('listening');
      break;
    case 'user.speech.ended':
      reportState('thinking');
      break;
    case 'assistant.response.started':
      // Pair every created response with its provider-reported completion. A
      // response that never terminates is itself the bug: the server keeps the
      // turn open, which is what produces "Conversation already has an active
      // response in progress" on the next utterance.
      if (openResponseId) {
        recordVoiceEvent(
          `Realtime response ${openResponseId} never reported completion before a new response started.`
        );
      }
      openResponseId = event.responseId ?? '(no id)';
      openResponseStartedAt = performance.now();
      reportState('thinking');
      outputTranscript = '';
      completedOutputTranscript = '';
      realtimeTextTranscript = '';
      break;
    case 'transcription':
      // Record what the provider heard the USER say. Without this line there
      // is no way to tell apart "audio never reached the server", "ASR could
      // not make out the words" and "the model heard it and chose not to act"
      // — three failures with identical symptoms and completely different
      // fixes. A 35-second stretch of a live microphone and a silent model
      // was undiagnosable for exactly this reason.
      if (event.speaker === 'user') {
        if (!event.final) {
          observePartialUserTranscript(event.text);
        } else {
          clearPartialUserTranscript();
          if (event.text.trim()) {
            lastUserUtterance = event.text.trim();
            recordVoiceEvent(`User heard as: ${JSON.stringify(lastUserUtterance.slice(0, 80))}`);
            if (activeSession?.provider.name === 'doubao' && inferSpokenMusicRequest(event.text)) {
              suppressPlaybackForMusicCommand();
              recordVoiceEvent('Suppressed Realtime planning audio for an explicit local music command.');
            }
            armSpokenCommandFallback(event.text);
          }
        }
      }
      if (event.speaker !== 'assistant') break;
      if (event.source === 'text') {
        realtimeTextTranscript = event.final
          ? event.text.trim() || realtimeTextTranscript
          : realtimeTextTranscript + event.text;
        break;
      }
      if (!event.final) {
        outputTranscript += event.text;
        break;
      }
      completedOutputTranscript = event.text || outputTranscript;
      if (completedOutputTranscript) {
        log(`Assistant audio transcript: ${JSON.stringify(completedOutputTranscript)}`);
      }
      outputTranscript = '';
      break;
    case 'assistant.audio.started':
      if (activeSession?.chunkPlayback) {
        activeSession.chunkPlayback.finishWhenDrained = false;
      }
      outputAudioPlaying = true;
      // A new answer is starting, so whatever the local barge-in monitor
      // silenced is over. Unmute here rather than on a timer, so a false
      // positive costs at most the tail of one reply.
      if (musicCommandPlaybackSuppressed) {
        if (activeSession) {
          clearChunkAudioQueue(activeSession);
          setProviderPlaybackMuted(activeSession, true);
        }
      } else {
        restoreAssistantPlayback();
      }
      if (activeSession) {
        activeSession.outputAudioQuality = createOutputAudioQuality();
        // Prime the counter baseline before this answer's first full interval.
        void sampleRealtimeAudioStats(activeSession);
      }
      reportState('speaking');
      if (sleepRequested && sleepConfirmationPending) {
        sleepConfirmationPending = false;
        sleepConfirmationPlaying = true;
      }
      break;
    case 'assistant.response.ended':
      {
        // Record how this response ended before anything else. A transcript
        // that stops mid-sentence looks identical whether the model finished,
        // the renderer cancelled it on a false speech_started, or the reply hit
        // max_output_tokens. Only these fields tell them apart.
        const status = event.status ?? 'unknown';
        const summary =
          `Realtime response ended: status=${status}` +
          (event.reason ? ` reason=${event.reason}` : '') +
          (typeof event.outputTokens === 'number' ? ` outputTokens=${event.outputTokens}` : '') +
          (event.responseId ? ` id=${event.responseId}` : '');

        // Record clean completions too. Keeping them console-only made their
        // absence from voice-events.json indistinguishable from turns that
        // never finished at all, which is exactly the question this line was
        // added to answer.
        recordVoiceEvent(summary);
        openResponseId = null;
        // Everyday replies are native provider audio. Do not start a second
        // buffered TTS path here: response completion can arrive before the
        // provider reports that audio playback has started.
      }
      break;
    case 'tool.call':
      void executeFunctionCall(event.call);
      break;
    case 'assistant.audio.ended': {
      const chunkPlayback = activeSession?.chunkPlayback;
      if (chunkPlayback && (chunkPlayback.sources.size > 0 || chunkPlayback.pendingDecodes > 0)) {
        chunkPlayback.finishWhenDrained = true;
        break;
      }
      completeAssistantAudioPlayback();
      break;
    }
    case 'diagnostic':
      recordVoiceEvent(event.message);
      break;
    case 'error':
      recordVoiceEvent(`Realtime API error: ${event.message}`);
      break;
    case 'unhandled':
      recordUnhandledRealtimeEvent(event.providerEventType);
      break;
  }
}

async function startRealtimeSession() {
  if (activeSession) return;
  const provider = createConfiguredVoiceProvider();
  const sessionConfigPromise = window.jarvis.getVoiceSessionConfig();
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  const unsubscribeProvider = provider.subscribe(handleVoiceProviderEvent);
  const unsubscribeOutputAudio = provider.receiveAudio(handleProviderOutputAudio);
  activeSession = {
    provider,
    unsubscribeProvider,
    unsubscribeOutputAudio,
    microphone,
    audio,
    analyserContext: null,
    analyser: null,
    analyserData: null,
    chunkPlayback: null,
    levelFrame: null,
    audioStatsTimer: null,
    lastInboundAudioStats: null,
    outputAudioQuality: null,
    inputContext: null,
    inputAnalyser: null,
    inputData: null,
    inputFrame: null,
    loudInputFrames: 0
  };
  startMicrophoneMonitor(microphone);

  const microphoneTrack = microphone.getAudioTracks()[0];
  if (!microphoneTrack) throw new Error('Microphone did not provide an audio track.');
  muteRealtimeMicrophoneUntil(microphone, microphoneTrack, assemblySoundMutedUntil);
  await provider.sendAudio(microphone);
  const sessionConfig = await sessionConfigPromise;
  await provider.establishSession(
    provider.name === 'doubao'
      ? { ...sessionConfig, voice: voiceConfig.doubaoVoice }
      : sessionConfig
  );
  recordVoiceEvent('Realtime voice session ready.');
}

async function stopRealtimeSession(reason: string) {
  if (stoppingSession) return;
  stoppingSession = true;
  const session = activeSession;
  activeSession = null;
  if (spokenCommandFallbackTimer !== null) window.clearTimeout(spokenCommandFallbackTimer);
  spokenCommandFallbackTimer = null;
  spokenCommandFallbackTool = null;
  clearPartialUserTranscript();
  if (localBargeInTimer !== null) window.clearTimeout(localBargeInTimer);
  localBargeInTimer = null;
  localBargeInMuted = false;
  musicCommandPlaybackSuppressed = false;
  outputAudioPlaying = false;
  completedOutputTranscript = '';
  sleepRequested = false;
  sleepConfirmationPending = false;
  sleepConfirmationPlaying = false;
  if (sleepFallbackTimer !== null) window.clearTimeout(sleepFallbackTimer);
  sleepFallbackTimer = null;
  clearSessionTimers();
  completedToolCalls.clear();

  if (session) {
    stopRealtimeAudioDiagnostics(session);
    clearChunkAudioQueue(session);
    if (session.levelFrame !== null) cancelAnimationFrame(session.levelFrame);
    if (session.inputFrame !== null) cancelAnimationFrame(session.inputFrame);
    if (session.inputContext && session.inputContext.state !== 'closed') {
      await session.inputContext.close();
    }
    session.microphone.getTracks().forEach((track) => track.stop());
    session.audio.pause();
    session.audio.srcObject = null;
    session.unsubscribeProvider();
    session.unsubscribeOutputAudio();
    await session.provider.closeSession();
    if (session.analyserContext && session.analyserContext.state !== 'closed') {
      await session.analyserContext.close();
    }
  }
  window.jarvis.reportLevel(0);
  window.dispatchEvent(new Event('jarvis:prepare-hide'));
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    window.setTimeout(finish, 50);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  window.jarvis.conversationEnded();
  log(reason);
  stoppingSession = false;
  const isVoiceSleep = reason === 'Conversation ended by voice request.';
  if (isVoiceSleep) {
    wakeResumeNotBefore = performance.now() + wakeResumeHoldoffMs;
    recordVoiceEvent(`Sleep completed; wake-word holdoff=${wakeResumeHoldoffMs}ms.`);
  }
  if (!shuttingDown) {
    const delay = Math.max(0, wakeResumeNotBefore - performance.now());
    window.setTimeout(() => void startWakeWord(), delay);
  }
}

async function handleWakeDetection(score: number, wakeFeatures: number[] | null) {
  if (wakeEnrollment) {
    // During an explicitly armed enrolment sample the phrase is training data,
    // not a command to open Jarvis. speech-end will save the same rolling
    // features and the existing detector remains otherwise untouched.
    return;
  }
  if (wakeTransition || activeSession) return;
  if (!wakeRunning) {
    // Fired between wakeEngine.start() and the point where startWakeWord()
    // considers the engine live. Nothing legitimate arrives in that gap.
    recordVoiceEvent(`Wake word ignored before the engine was live (score=${score.toFixed(3)}).`);
    return;
  }
  if (performance.now() < wakeResumeNotBefore) {
    recordVoiceEvent(`Wake word ignored during post-sleep holdoff (score=${score.toFixed(3)}).`);
    return;
  }
  if (performance.now() < wakeWarmupUntil) {
    // Never replay a warm-up detection later. Logs proved that scores 0.982
    // and 0.984 here were the pre-sleep audio still present in the rolling
    // feature window; deferring them converted known stale input into two
    // guaranteed false wakes.
    pendingWakeCandidateAt = 0;
    pendingWakeCandidateScore = 0;
    recordVoiceEvent(`Wake word ignored during engine warm-up (score=${score.toFixed(3)}).`);
    return;
  }
  if (personalWakeModel && personalWakeModel.mode !== 'off') {
    if (!wakeFeatures) {
      recordVoiceEvent('Personal wake verifier had no feature snapshot; preserving baseline wake behavior.');
    } else {
      const verificationStartedAt = performance.now();
      try {
        const personalScore = scorePersonalWake(personalWakeModel, wakeFeatures);
        const verificationMs = performance.now() - verificationStartedAt;
        const effectiveThreshold = Math.max(
          0.45,
          personalWakeModel.threshold - personalWakeRuntimeTolerance
        );
        recordVoiceEvent(
          `Personal wake ${personalWakeModel.mode}: score=${personalScore.toFixed(3)}, `
          + `threshold=${effectiveThreshold.toFixed(3)} `
          + `(configured=${personalWakeModel.threshold.toFixed(3)}), `
          + `latency=${verificationMs.toFixed(1)}ms.`
        );
        if (personalWakeModel.mode === 'active' && personalScore < effectiveThreshold) {
          pendingWakeCandidateAt = 0;
          pendingWakeCandidateScore = 0;
          recordVoiceEvent('Wake word rejected by the active personal verifier.');
          return;
        }
      } catch (error) {
        // A corrupt or incompatible optional model must never make Jarvis
        // impossible to summon. Failing open is the exact baseline behavior.
        recordVoiceEvent(
          `Personal wake verifier bypassed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  if (score < immediateWakeScore) {
    const now = performance.now();
    const confirmed =
      pendingWakeCandidateAt > 0 &&
      now - pendingWakeCandidateAt <= wakeCandidateConfirmationMs;
    if (!confirmed) {
      pendingWakeCandidateAt = now;
      pendingWakeCandidateScore = score;
      recordVoiceEvent(
        `Borderline wake candidate (score=${score.toFixed(3)}); waiting for a second detection.`
      );
      return;
    }
    recordVoiceEvent(
      `Borderline wake confirmed twice (scores=${pendingWakeCandidateScore.toFixed(3)},${score.toFixed(3)}).`
    );
  }
  pendingWakeCandidateAt = 0;
  pendingWakeCandidateScore = 0;
  pendingPersonalWakeCandidateAt = 0;
  pendingPersonalWakeCandidateScore = 0;
  wakeTransition = true;
  try {
    recordVoiceEvent(`Wake word accepted (score=${score.toFixed(3)}).`);
    await stopWakeWord();
    // Echo cancellation handles the assembly sound. Keeping the microphone
    // closed for the full animation made short commands spoken just after the
    // wake word disappear entirely.
    assemblySoundMutedUntil = performance.now() + 450;
    window.jarvis.wakeDetected();
    await startRealtimeSession();
  } catch (error) {
    console.error('[Jarvis] Unable to start Realtime conversation.', error);
    await stopRealtimeSession('Realtime startup failed; returning to local wake word.');
  } finally {
    wakeTransition = false;
  }
}

wakeEngine.on('detect', ({ score }) => {
  const wakeFeatures = snapshotWakeFeatures();
  void handleWakeDetection(score, wakeFeatures);
});
wakeEngine.on('speech-start', () => log('Wake microphone heard speech.'));
wakeEngine.on('speech-end', () => void handleWakeSpeechEnd());
wakeEngine.on('error', (error) => console.error('[Jarvis] Local wake-word error.', error));

// The engine opens its microphone with deviceId "default", which macOS resolves
// once, when the stream is created. Plugging in headphones or changing the
// input in System Settings afterwards leaves the engine listening to the old
// device — silently, since a disconnected or wrong microphone simply never
// produces a detection. Reopen the stream when the default input changes.
async function describeDefaultInput() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const preferred = devices.find(
      (device) => device.kind === 'audioinput' && device.deviceId === 'default'
    );
    // Labels are empty until microphone permission is granted; groupId is a
    // stable fallback that still changes when the underlying device changes.
    return preferred ? `${preferred.label}|${preferred.groupId}` : '';
  } catch {
    return '';
  }
}

let knownDefaultInput = '';
let inputChangeTimer: number | null = null;

async function restartWakeWordForNewInput() {
  // Never interrupt a live conversation; Realtime owns the microphone then.
  if (activeSession || wakeStartInProgress || wakeTransition || shuttingDown) return;

  const current = await describeDefaultInput();
  if (!current || current === knownDefaultInput) return;

  const previous = knownDefaultInput;
  knownDefaultInput = current;
  if (!previous) return;

  if (!wakeRunning) return;
  recordVoiceEvent('Default microphone changed; restarting local wake word.');
  await stopWakeWord();
  await startWakeWord();
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  // devicechange fires several times for a single physical event.
  if (inputChangeTimer !== null) window.clearTimeout(inputChangeTimer);
  inputChangeTimer = window.setTimeout(() => {
    inputChangeTimer = null;
    void restartWakeWordForNewInput();
  }, 600);
});

window.jarvis.onWakeEnrollmentCommand(handleWakeEnrollmentCommand);
window.jarvis.onPersonalWakeModelUpdated((model) => {
  personalWakeModel = isPersonalWakeModel(model) ? model : null;
  recordVoiceEvent(
    personalWakeModel
      ? `Personal wake mode updated live: ${personalWakeModel.mode}.`
      : 'Personal wake model removed; baseline wake behavior restored.'
  );
});

window.jarvis.onAssemblyPresented(() => {
  assemblySoundMutedUntil = performance.now() + 450;
  const session = activeSession;
  const microphoneTrack = session?.microphone.getAudioTracks()[0];
  if (session && microphoneTrack) {
    muteRealtimeMicrophoneUntil(session.microphone, microphoneTrack, assemblySoundMutedUntil);
  }
});

export function initializeVoiceAssistant() {
  shuttingDown = false;
  if (wakeHealthTimer !== null) window.clearInterval(wakeHealthTimer);
  wakeHealthTimer = window.setInterval(() => void maintainWakeWordHealth(), wakeHealthCheckMs);
  void (async () => {
    const storedModel = await window.jarvis.getPersonalWakeModel();
    personalWakeModel = isPersonalWakeModel(storedModel) ? storedModel : null;
    if (personalWakeModel && personalWakeModel.scoring !== 'temporal-shift-v1') {
      // Migrate the first enrolment format in place. It stored the complete
      // local feature templates, so no new recording is needed; only the
      // alignment-aware score and its threshold are recomputed.
      const migrated = trainPersonalWakeModel(
        personalWakeModel.keyword,
        personalWakeModel.templates,
        personalWakeModel.createdAt
      );
      migrated.mode = 'shadow';
      await window.jarvis.savePersonalWakeModel(migrated);
      personalWakeModel = migrated;
      recordVoiceEvent('Personal wake model migrated to temporal-shift scoring; mode remains shadow.');
    }
    if (personalWakeModel && !personalWakeModel.rescueMode) {
      personalWakeModel = { ...personalWakeModel, rescueMode: 'shadow' };
      await window.jarvis.savePersonalWakeModel(personalWakeModel);
      recordVoiceEvent('Personal wake independent rescue channel initialized in shadow mode.');
    }
    const legacyRaisedRescueThreshold = personalWakeModel
      ? Math.min(0.98, personalWakeModel.threshold + 0.02)
      : Number.NaN;
    if (
      personalWakeModel
      && (
        !Number.isFinite(personalWakeModel.rescueThreshold)
        || Math.abs(Number(personalWakeModel.rescueThreshold) - legacyRaisedRescueThreshold) < 1e-6
      )
    ) {
      const rescueThreshold = personalWakeModel.threshold;
      personalWakeModel = {
        ...personalWakeModel,
        rescueThreshold
      };
      await window.jarvis.savePersonalWakeModel(personalWakeModel);
      recordVoiceEvent(
        `Personal wake rescue threshold initialized at ${rescueThreshold.toFixed(3)}.`
      );
    }
    if (personalWakeModel) {
      recordVoiceEvent(
        `Personal wake model loaded: samples=${personalWakeModel.templates.length}, `
        + `threshold=${personalWakeModel.threshold.toFixed(3)}, mode=${personalWakeModel.mode}.`
      );
    } else {
      recordVoiceEvent('Personal wake model absent; using the unchanged community wake path.');
    }
    await startWakeWord();
    // Seed the baseline so the first devicechange has something to compare
    // against and does not trigger a pointless restart.
    knownDefaultInput = await describeDefaultInput();
  })();
}

export function shutdownVoiceAssistant() {
  shuttingDown = true;
  if (wakeHealthTimer !== null) window.clearInterval(wakeHealthTimer);
  wakeHealthTimer = null;
  if (sleepFallbackTimer !== null) window.clearTimeout(sleepFallbackTimer);
  sleepFallbackTimer = null;
  clearSessionTimers();
  void stopWakeWord();
  if (activeSession) void stopRealtimeSession('Jarvis renderer is shutting down.');
}
