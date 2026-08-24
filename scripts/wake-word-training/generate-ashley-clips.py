#!/usr/bin/env python3
"""Generate official Piper/openWakeWord clips in an isolated MPS process.

Importing the complete augmentation stack before Piper makes PyTorch's graph
fuser lose the MPS device on macOS. The official adversarial-text function runs
here; each official Piper generation then runs in a clean child process.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import yaml
from openwakeword.data import generate_adversarial_texts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    return parser.parse_args()


def finish_partial_batch(destination: Path, partial: Path) -> int:
    destination.mkdir(parents=True, exist_ok=True)
    partial.mkdir(parents=True, exist_ok=True)
    moved = 0
    for clip in partial.glob("*.wav"):
        clip.replace(destination / f"{uuid.uuid4().hex}.wav")
        moved += 1
    return moved


def generate(
    python: Path,
    generator: Path,
    text: str,
    destination: Path,
    target_count: int,
    batch_size: int,
) -> None:
    partial = destination.parent / f".{destination.name}-partial"
    finish_partial_batch(destination, partial)
    existing = len(list(destination.glob("*.wav")))
    remaining = target_count - existing
    if remaining <= 0:
        print(f"{destination.name}: {existing}/{target_count}, skipping")
        return
    # Long-running Piper inference on MPS progressively slows as its graph and
    # allocator state accumulate. Keep the official generator and parameters,
    # but release the child process every few batches. Partial output is moved
    # after every chunk, so interruption remains safely resumable.
    chunk_size = batch_size * 8
    while remaining > 0:
        this_chunk = min(remaining, chunk_size)
        subprocess.run(
            [
                str(python),
                str(generator),
                text,
                "--max-samples",
                str(this_chunk),
                "--batch-size",
                str(min(batch_size, this_chunk)),
                "--output-dir",
                str(partial),
            ],
            check=True,
        )
        finish_partial_batch(destination, partial)
        existing = len(list(destination.glob("*.wav")))
        remaining = target_count - existing
        print(f"{destination.name}: {existing}/{target_count}", flush=True)
    total = len(list(destination.glob("*.wav")))
    if total < target_count:
        raise RuntimeError(f"{destination} contains only {total}/{target_count} clips")


def main() -> None:
    args = parse_args()
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    generator = args.workspace / "piper-sample-generator" / "generate_samples.py"
    output = args.workspace / "output" / config["model_name"]
    target = config["target_phrase"][0]
    train_count = int(config["n_samples"])
    validation_count = int(config["n_samples_val"])
    positive_batch = int(config["tts_batch_size"])
    negative_batch = int(config.get("tts_negative_batch_size", max(1, positive_batch // 7)))

    adversarial_train = list(config.get("custom_negative_phrases", []))
    adversarial_train.extend(
        generate_adversarial_texts(
            input_text=target,
            N=train_count,
            include_partial_phrase=1.0,
            include_input_words=0.2,
        )
    )
    adversarial_validation = list(config.get("custom_negative_phrases", []))
    adversarial_validation.extend(
        generate_adversarial_texts(
            input_text=target,
            N=validation_count,
            include_partial_phrase=1.0,
            include_input_words=0.2,
        )
    )
    train_text = args.workspace / "ashley-adversarial-train.txt"
    validation_text = args.workspace / "ashley-adversarial-validation.txt"
    train_text.write_text("\n".join(adversarial_train), encoding="utf-8")
    validation_text.write_text("\n".join(adversarial_validation), encoding="utf-8")

    generate(sys.executable, generator, target, output / "positive_train", train_count, positive_batch)
    generate(sys.executable, generator, target, output / "positive_test", validation_count, positive_batch)
    generate(sys.executable, generator, str(train_text), output / "negative_train", train_count, negative_batch)
    generate(
        sys.executable,
        generator,
        str(validation_text),
        output / "negative_test",
        validation_count,
        negative_batch,
    )

    # Partial directories should normally be empty after a successful run.
    for partial in output.glob(".*-partial"):
        if not any(partial.iterdir()):
            shutil.rmtree(partial)


if __name__ == "__main__":
    main()
    # PyTorch/MPS can throw a recursive_mutex error while global objects are
    # destroyed after this one-shot helper has already completed successfully.
    # Flush output and bypass only interpreter teardown; child generators and
    # every requested file have completed before this point.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
