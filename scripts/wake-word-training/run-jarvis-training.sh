#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_root=${script_dir:h:h}
workspace=${JARVIS_WORD_TRAINING_WORKSPACE:-${script_dir}/.work}
python_bin="$workspace/.venv/bin/python"
dataset_path=${JARVIS_PERSONAL_WAKE_DATASET:-$HOME/Library/Application Support/jarvis-desktop-assistant/personal-wake-training-features.json}

apply_training_patch() {
  local checkout=$1
  local patch_file=$2
  if git -C "$checkout" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    return
  fi
  git -C "$checkout" apply --check "$patch_file"
  git -C "$checkout" apply "$patch_file"
}

apply_training_patch "$workspace/piper-sample-generator" "$script_dir/piper-generator-macos-mps.patch"
"$python_bin" "$script_dir/patch-openwakeword-mps.py" \
  "$workspace/openWakeWord/openwakeword/train.py"

for required in \
  "$workspace/openWakeWord/openwakeword/train.py" \
  "$workspace/piper-sample-generator/generate_samples.py" \
  "$workspace/piper-sample-generator/models/en-us-libritts-high.pt" \
  "$workspace/validation_set_features.npy" \
  "$workspace/openwakeword_features_ACAV100M_2000_hrs_16bit.npy" \
  "$python_bin" \
  "$dataset_path"; do
  if [[ ! -e "$required" ]]; then
    print -u2 "Missing training input: $required"
    exit 1
  fi
done

cp "$script_dir/jarvis.yml" "$workspace/jarvis.yml"
"$python_bin" "$script_dir/export-personal-negatives.py" \
  "$dataset_path" "$workspace/local_personal_negatives.npy"
"$python_bin" "$script_dir/generate-backgrounds.py" "$workspace/background_clips"

cd "$workspace"
export PYTHONPATH="$workspace/openWakeWord:$workspace/piper-sample-generator"
if command -v brew >/dev/null 2>&1; then
  homebrew_prefix=$(brew --prefix)
  espeak_prefix=$(brew --prefix espeak-ng)
  export HOMEBREW_PREFIX="$homebrew_prefix"
  export ESPEAK_NG_LIBRARY="$espeak_prefix/lib/libespeak-ng.1.dylib"
  export DYLD_LIBRARY_PATH="$homebrew_prefix/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

"$python_bin" "$script_dir/generate-jarvis-clips.py" \
  --workspace "$workspace" \
  --config "$workspace/jarvis.yml"
"$python_bin" openWakeWord/openwakeword/train.py \
  --training_config jarvis.yml \
  --generate_clips

feature_dir="$workspace/output/jarvis"
feature_files=(
  positive_features_train.npy
  negative_features_train.npy
  positive_features_test.npy
  negative_features_test.npy
)
feature_set_complete=true
for feature_file in "${feature_files[@]}"; do
  if [[ ! -s "$feature_dir/$feature_file" ]]; then
    feature_set_complete=false
  fi
done
if [[ "$feature_set_complete" != true ]]; then
  for feature_file in "${feature_files[@]}"; do
    if [[ -e "$feature_dir/$feature_file" ]]; then
      mv "$feature_dir/$feature_file" "$feature_dir/$feature_file.incomplete"
    fi
  done
fi
"$python_bin" openWakeWord/openwakeword/train.py \
  --training_config jarvis.yml \
  --augment_clips
"$python_bin" openWakeWord/openwakeword/train.py \
  --training_config jarvis.yml \
  --train_model

model="$workspace/output/jarvis.onnx"
if [[ ! -s "$model" ]]; then
  print -u2 "Training completed without producing $model"
  exit 1
fi
single_file_model="$workspace/output/jarvis-single.onnx"
"$python_bin" "$script_dir/consolidate-onnx.py" "$model" "$single_file_model"
cp "$single_file_model" "$project_root/assets/wake-word/models/jarvis.onnx"
print "Installed trained model at $project_root/assets/wake-word/models/jarvis.onnx"
