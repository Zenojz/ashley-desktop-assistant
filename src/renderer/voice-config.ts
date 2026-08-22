export const voiceConfig = {
  wakeKeyword: 'hey_jarvis',
  // The May community model repeatedly heard microphone speech without
  // producing any candidate at all for the user's normal summon, even after
  // the reporting floor was lowered. Use the newer local model already
  // bundled with the project; the higher-level confirmation policy still
  // guards marginal scores and stale-buffer detections.
  wakeModelFile: 'hey_jarvis_community_20260625.onnx',
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
