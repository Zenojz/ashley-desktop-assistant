# Training Ashley and Jarvis word-level wake models

This directory contains a reproducible local training workflow based on the
official openWakeWord custom-model pipeline and Piper sample generator. It
contains code and configuration only. It does **not** contain generated WAV
files, public corpora, local acoustic features, checkpoints, or trained ONNX
models.

The generated `ashley.onnx` and `jarvis.onnx` models can encode characteristics
of the negative speech features used during training. Keep the workspace,
feature arrays, recordings, and resulting models private. The repository's
`.gitignore` excludes the default workspace and final personal models.

## What the workflow does

For either keyword, the runner performs the complete pipeline:

1. Synthesizes varied positive clips with Piper/LibriTTS speaker interpolation
   and multiple speaking speeds.
2. Generates phonetically similar adversarial phrases and synthesizes them as
   hard negative clips.
3. Mixes clips with generated background noise and room impulse responses,
   then extracts openWakeWord features.
4. Combines the synthetic hard negatives, the public ACAV100M feature corpus,
   and the user's locally exported negative acoustic features.
5. Trains the small classifier head, evaluates candidate checkpoints, exports
   ONNX, and consolidates any external weight file into one browser-loadable
   model.

`ashley.yml` creates 20,000 training positives and 4,000 validation positives.
`jarvis.yml` uses the same positive counts plus 30,000 training and 6,000
validation adversarial negatives because the shorter word is more confusable.
Edit `custom_negative_phrases` when your environment reveals additional
false-positive phrases.

## Pinned upstream sources

The compatibility patches in this directory target these revisions:

- [openWakeWord](https://github.com/dscripka/openWakeWord) commit
  `368c03716d1e92591906a84949bc477f3a834455`
- [piper-sample-generator](https://github.com/dscripka/piper-sample-generator)
  commit `f1988a4d54eddb23d99e86f0adfef6226a85acc7`
- Piper `en-us-libritts-high.pt` release model
- [`davidscripka/openwakeword_features`](https://huggingface.co/datasets/davidscripka/openwakeword_features)
  ACAV100M 2,000-hour negative features and approximately 11-hour validation set

Do not silently switch the two Git checkouts to another revision: the patch
helpers intentionally fail when the expected upstream code is no longer
present.

## Apple Silicon requirements

The tested setup is macOS on Apple Silicon with Python 3.11. Install:

```sh
brew install git git-lfs uv espeak-ng ffmpeg libsndfile
```

Use a fast local SSD. The public ACAV100M feature file is about 17.3GB, the
validation set about 185MB, the Piper model about 243MB, and the Python
environment about 1.3GB. Generated clips and feature arrays add roughly
2–4GB per keyword. Reserve at least **30GB free disk space** when training
both models in the shared default workspace.

A machine with 16GB unified memory is recommended. Plan for roughly 8–12GB
during the heaviest stages. On an 8GB machine,
reduce `tts_batch_size` and `batch_n_per_class` and expect substantially longer
runs. MPS accelerates Piper synthesis and the small PyTorch classifier head;
the official ONNX feature extraction path remains CPU-bound.

Typical end-to-end times vary with the M-series generation, cooling, and SSD:

| Stage | Ashley | Jarvis |
| --- | ---: | ---: |
| Piper positive and adversarial synthesis | 2–5 hours | 3–7 hours |
| Augmentation and feature extraction | 1–3 hours | 2–4 hours |
| Classifier training and ONNX export | 5–20 minutes | 5–25 minutes |
| Expected total | 4–8 hours | 6–11 hours |

These are planning estimates, not guarantees. The scripts are resumable and
preserve completed clip batches in `.work/`.

## 1. Prepare the isolated workspace

Run from the Ashley project root:

```sh
work=scripts/wake-word-training/.work
mkdir -p "$work"

git clone https://github.com/dscripka/openWakeWord.git "$work/openWakeWord"
git -C "$work/openWakeWord" checkout 368c03716d1e92591906a84949bc477f3a834455

git clone https://github.com/dscripka/piper-sample-generator.git \
  "$work/piper-sample-generator"
git -C "$work/piper-sample-generator" checkout \
  f1988a4d54eddb23d99e86f0adfef6226a85acc7

uv venv --python 3.11 "$work/.venv"
uv pip install --python "$work/.venv/bin/python" \
  -r "$work/piper-sample-generator/requirements.txt"
uv pip install --python "$work/.venv/bin/python" \
  -e "$work/openWakeWord" \
  'numpy<2' onnx onnxruntime soundfile torch torchaudio torchcodec \
  torchinfo torchmetrics speechbrain audiomentations torch-audiomentations \
  acoustics pyyaml pronouncing datasets huggingface-hub
```

The runners apply the included macOS/MPS compatibility patches idempotently.
They do not modify this repository's application source.

## 2. Download public models and negative features

```sh
mkdir -p "$work/piper-sample-generator/models"
curl -fL \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v1.0.0/en-us-libritts-high.pt \
  -o "$work/piper-sample-generator/models/en-us-libritts-high.pt"

"$work/.venv/bin/hf" download davidscripka/openwakeword_features \
  openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
  validation_set_features.npy \
  --repo-type dataset --local-dir "$work"
```

Review the licenses of all upstream inputs before redistribution or commercial
use. In particular, the public feature dataset currently declares
CC BY-NC-SA 4.0. The large files remain in `.work/` and are never committed.

## 3. Prepare local negative acoustic features

Use Ashley's enrollment window to collect natural speech and television/music
background negatives. The application stores extracted 16x96 acoustic
embeddings, not raw microphone recordings. The runner reads the application's
default local feature store. If your Electron user-data directory differs,
set it explicitly before training:

```sh
export JARVIS_PERSONAL_WAKE_DATASET="$HOME/Library/Application Support/jarvis-desktop-assistant/personal-wake-training-features.json"
```

`export-personal-negatives.py` deduplicates the saved negative embeddings and
writes `.work/local_personal_negatives.npy`. It neither reads nor reconstructs
audio. Never commit either input or output.

## 4. Generate samples, train, and export ONNX

Train Ashley:

```sh
scripts/wake-word-training/run-ashley-training.sh
```

Train Jarvis, reusing the same downloaded workspace:

```sh
scripts/wake-word-training/run-jarvis-training.sh
```

Each runner generates synthetic positives and adversarial negatives, augments
them, trains the classifier, exports ONNX, embeds external weights, validates
the consolidated file, and copies the result to:

- `assets/wake-word/models/ashley.onnx`
- `assets/wake-word/models/jarvis.onnx`

Both destinations are intentionally ignored by Git.

To keep the workspace elsewhere, set `ASHLEY_TRAINING_WORKSPACE` or
`JARVIS_WORD_TRAINING_WORKSPACE` to the same directory before running the
corresponding script.

## 5. Evaluate a trained model

The official trainer selects a checkpoint against the validation feature set.
For a threshold report over held-out positives, adversarial negatives, public
validation features, and your local negatives, run for example:

```sh
"$work/.venv/bin/python" scripts/wake-word-training/evaluate-onnx-model.py \
  --model "$work/output/ashley-single.onnx" \
  --positive "$work/output/ashley/positive_features_test.npy" \
  --negative "$work/output/ashley/negative_features_test.npy" \
  --validation "$work/validation_set_features.npy" \
  --local-negative "$work/local_personal_negatives.npy" \
  --output "$work/output/ashley-evaluation.json"
```

Repeat with the Jarvis paths after its run. Treat synthetic metrics as a
starting point: test recall with your own microphone and measure false wakes
for several hours in the real television/music environment before choosing a
runtime threshold.

## File map

- `ashley.yml`, `jarvis.yml`: editable training configurations.
- `generate-*-clips.py`: Piper positive and adversarial-negative synthesis.
- `generate-backgrounds.py`: programmatic background-noise generation.
- `export-personal-negatives.py`: local feature-only negative export.
- `patch-openwakeword-mps.py`, `piper-generator-macos-mps.patch`: pinned
  Apple Silicon compatibility helpers.
- `consolidate-onnx.py`: embeds an adjacent ONNX weight file.
- `evaluate-onnx-model.py`: threshold/recall/false-positive report.
- `run-*-training.sh`: end-to-end resumable runners.

## Connect a trained model to the runtime

The runners copy their final models to the runtime model directory. If you
exported a model manually, place it there yourself:

```text
assets/wake-word/models/ashley.onnx
assets/wake-word/models/jarvis.onnx
```

Then add the keywords and filenames to the project `.env` file:

```dotenv
JARVIS_EXTRA_WAKE_MODELS=ashley:ashley.onnx,jarvis:jarvis.onnx
```

The format is a comma-separated list of `keyword:filename.onnx` pairs. Restart
the application after changing it. The bundled `hey_jarvis` community model is
always loaded as the default; removing or commenting out this single variable
returns the runtime to that one model. No TypeScript changes are required.

Do not commit generated ONNX models, thresholds, local feature datasets, or
recordings. The personal model filenames above are intentionally ignored by
Git.
