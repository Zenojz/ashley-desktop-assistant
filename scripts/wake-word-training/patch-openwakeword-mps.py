#!/usr/bin/env python3
"""Idempotently enable MPS for the official openWakeWord classifier head."""

from __future__ import annotations

import argparse
from pathlib import Path


ORIGINAL = "self.device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')"
REPLACEMENT = """if torch.cuda.is_available():
            self.device = torch.device('cuda:0')
        elif torch.backends.mps.is_available():
            self.device = torch.device('mps')
        else:
            self.device = torch.device('cpu')"""

TORCHAUDIO_IMPORT = "import torch\n"
TORCHAUDIO_COMPAT = '''import torch
import torchaudio

# torchaudio 2.11 removed info(), while torch-audiomentations still uses it
# for WAV metadata. Restore only that compatibility surface with SoundFile.
if not hasattr(torchaudio, "info"):
    import soundfile as sf
    from types import SimpleNamespace

    def _torchaudio_info(path):
        metadata = sf.info(str(path))
        return SimpleNamespace(
            sample_rate=metadata.samplerate,
            num_frames=metadata.frames,
            num_channels=metadata.channels,
            bits_per_sample=0,
            encoding=metadata.subtype,
        )

    torchaudio.info = _torchaudio_info
'''

OPENWAKEWORD_IMPORT = "import openwakeword\n"
SPEECHBRAIN_COMPAT = '''# SpeechBrain documents rotation_index as an int, but its reverberation
# helper passes the single-element argmax tensor returned by current PyTorch.
# Normalize that argument while preserving SpeechBrain's convolution itself.
import speechbrain.processing.signal_processing as _sb_signal

_speechbrain_convolve1d = _sb_signal.convolve1d

def _speechbrain_convolve1d_compat(*args, **kwargs):
    rotation_index = kwargs.get("rotation_index")
    if torch.is_tensor(rotation_index):
        kwargs["rotation_index"] = int(rotation_index.reshape(-1)[0].item())
    return _speechbrain_convolve1d(*args, **kwargs)

_sb_signal.convolve1d = _speechbrain_convolve1d_compat

import openwakeword
'''

RIR_ORIGINAL = '''            rir_waveform, sr = torchaudio.load(random.choice(RIR_paths))
            augmented_batch = reverberate(augmented_batch.cpu(), rir_waveform, rescale_amp="avg")'''
RIR_PRIOR_COMPAT = '''            rir_waveform, sr = torchaudio.load(random.choice(RIR_paths))
            # Piper's bundled impulse responses include stereo files, while
            # SpeechBrain reverberation expects one kernel shared by the batch.
            rir_waveform = rir_waveform.mean(dim=0, keepdim=True)
            augmented_batch = reverberate(augmented_batch.cpu(), rir_waveform, rescale_amp="avg")'''
RIR_REPLACEMENT = '''            rir_waveform, rir_sr = torchaudio.load(random.choice(RIR_paths))
            # Keep the clip sample rate intact across batches. Normalize the
            # room impulse response separately before applying reverberation.
            if rir_sr != sr:
                rir_waveform = torchaudio.functional.resample(rir_waveform, rir_sr, sr)
            # Piper's bundled impulse responses include stereo files, while
            # SpeechBrain reverberation expects one kernel shared by the batch.
            rir_waveform = rir_waveform.mean(dim=0, keepdim=True)
            augmented_batch = reverberate(augmented_batch.cpu(), rir_waveform, rescale_amp="avg")'''

DATALOADER_ORIGINAL = '''        X_train = torch.utils.data.DataLoader(IterDataset(batch_generator),
                                              batch_size=None, num_workers=n_cpus, prefetch_factor=16)'''
DATALOADER_REPLACEMENT = '''        # The generator closes over lambda transforms and cannot be pickled by
        # macOS spawn workers. MPS still performs model compute; read memmaps
        # in the main process to preserve the official batch generator.
        X_train = torch.utils.data.DataLoader(IterDataset(batch_generator),
                                              batch_size=None, num_workers=0)'''

ARGPARSE_FALSE_ORIGINAL = '''        action="store_true",
        default="False",
        required=False'''
ARGPARSE_FALSE_REPLACEMENT = '''        action="store_true",
        default=False,
        required=False'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("train_py", type=Path)
    args = parser.parse_args()
    source = args.train_py.read_text(encoding="utf-8")
    changed = False
    if REPLACEMENT not in source:
        if ORIGINAL not in source:
            raise SystemExit(f"Official device-selection line not found in {args.train_py}")
        source = source.replace(ORIGINAL, REPLACEMENT, 1)
        changed = True
    if TORCHAUDIO_COMPAT not in source:
        if TORCHAUDIO_IMPORT not in source:
            raise SystemExit(f"Official torch import not found in {args.train_py}")
        source = source.replace(TORCHAUDIO_IMPORT, TORCHAUDIO_COMPAT, 1)
        changed = True
    if SPEECHBRAIN_COMPAT not in source:
        if OPENWAKEWORD_IMPORT not in source:
            raise SystemExit(f"Official openwakeword import not found in {args.train_py}")
        source = source.replace(OPENWAKEWORD_IMPORT, SPEECHBRAIN_COMPAT, 1)
        changed = True
    if DATALOADER_REPLACEMENT not in source:
        if DATALOADER_ORIGINAL not in source:
            raise SystemExit(f"Official training DataLoader block not found in {args.train_py}")
        source = source.replace(DATALOADER_ORIGINAL, DATALOADER_REPLACEMENT, 1)
        changed = True
    # Upstream currently uses the truthy string "False" as the default for
    # store_true flags. Normalize each flag so an ONNX-only run does not enter
    # the optional TensorFlow/TFLite conversion path.
    if ARGPARSE_FALSE_ORIGINAL in source:
        source = source.replace(ARGPARSE_FALSE_ORIGINAL, ARGPARSE_FALSE_REPLACEMENT)
        changed = True
    if changed:
        args.train_py.write_text(source, encoding="utf-8")

    data_py = args.train_py.with_name("data.py")
    data_source = data_py.read_text(encoding="utf-8")
    if RIR_REPLACEMENT not in data_source:
        if RIR_PRIOR_COMPAT in data_source:
            original_rir_block = RIR_PRIOR_COMPAT
        elif RIR_ORIGINAL in data_source:
            original_rir_block = RIR_ORIGINAL
        else:
            raise SystemExit(f"Official RIR loading block not found in {data_py}")
        data_py.write_text(
            data_source.replace(original_rir_block, RIR_REPLACEMENT, 1),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
