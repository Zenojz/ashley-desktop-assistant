export type WakeModelConfig = { keyword: string; modelFile: string };

const defaultWakeModel: WakeModelConfig = {
  keyword: 'hey_jarvis',
  modelFile: 'hey_jarvis_community_20260625.onnx'
};

function readExtraWakeModels(): WakeModelConfig[] {
  const raw = new URLSearchParams(window.location.search).get('extraWakeModels');
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WakeModelConfig => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<WakeModelConfig>;
      return typeof candidate.keyword === 'string' && typeof candidate.modelFile === 'string';
    });
  } catch {
    return [];
  }
}

const wakeModels = [defaultWakeModel, ...readExtraWakeModels()];

export const voiceConfig = {
  wakeKeyword: 'hey_jarvis',
  // The May community model repeatedly heard microphone speech without
  // producing any candidate at all for the user's normal summon, even after
  // the reporting floor was lowered. Use the newer local model already
  // bundled with the project; the higher-level confirmation policy still
  // guards marginal scores and stale-buffer detections.
  wakeModelFile: 'hey_jarvis_community_20260625.onnx',
  wakeModels,
  // This is only the candidate-reporting floor. voice.ts applies the real
  // policy: strong scores wake immediately, while weaker scores must repeat.
  // Keeping this below the acceptance threshold lets a softly spoken summon
  // participate in that confirmation instead of disappearing inside the
  // wake-word library with no diagnostic event at all.
  wakeThreshold: 0.45,
  wakeGain: 1.1,
  assemblySoundDurationMs: 2_600,
  outputLevelScale: 3.2,
  doubaoVoice: 'zh_male_xiaotian_jupiter_bigtts'
};
