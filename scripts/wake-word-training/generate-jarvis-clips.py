#!/usr/bin/env python3
"""Generate Jarvis positives and an oversized hard-negative corpus."""

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
    if existing < target_count:
        raise RuntimeError(f"{destination} contains only {existing}/{target_count} clips")


def repeated_confusers(phrases: list[str], target_count: int) -> list[str]:
    # Guarantee thousands of explicit confusers instead of leaving their
    # frequency to the official stochastic near-phrase generator.
    repetitions = max(1, target_count // (len(phrases) * 4))
    return [phrase for phrase in phrases for _ in range(repetitions)]


def main() -> None:
    args = parse_args()
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    generator = args.workspace / "piper-sample-generator" / "generate_samples.py"
    output = args.workspace / "output" / config["model_name"]
    target = config["target_phrase"][0]
    positive_train = int(config["n_samples"])
    positive_validation = int(config["n_samples_val"])
    negative_train = int(config["n_samples_negative"])
    negative_validation = int(config["n_samples_negative_val"])
    positive_batch = int(config["tts_batch_size"])
    negative_batch = int(config["tts_negative_batch_size"])
    confusers = list(config.get("custom_negative_phrases", []))

    adversarial_train = repeated_confusers(confusers, negative_train)
    adversarial_train.extend(
        generate_adversarial_texts(
            input_text=target,
            N=negative_train - len(adversarial_train),
            include_partial_phrase=1.0,
            include_input_words=0.2,
        )
    )
    adversarial_validation = repeated_confusers(confusers, negative_validation)
    adversarial_validation.extend(
        generate_adversarial_texts(
            input_text=target,
            N=negative_validation - len(adversarial_validation),
            include_partial_phrase=1.0,
            include_input_words=0.2,
        )
    )
    train_text = args.workspace / "jarvis-adversarial-train.txt"
    validation_text = args.workspace / "jarvis-adversarial-validation.txt"
    train_text.write_text("\n".join(adversarial_train), encoding="utf-8")
    validation_text.write_text("\n".join(adversarial_validation), encoding="utf-8")

    generate(sys.executable, generator, target, output / "positive_train", positive_train, positive_batch)
    generate(sys.executable, generator, target, output / "positive_test", positive_validation, positive_batch)
    generate(sys.executable, generator, str(train_text), output / "negative_train", negative_train, negative_batch)
    generate(
        sys.executable,
        generator,
        str(validation_text),
        output / "negative_test",
        negative_validation,
        negative_batch,
    )

    for partial in output.glob(".*-partial"):
        if not any(partial.iterdir()):
            shutil.rmtree(partial)


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
