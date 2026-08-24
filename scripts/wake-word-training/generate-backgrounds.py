#!/usr/bin/env python3
"""Generate redistributable background beds for openWakeWord augmentation."""

from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 16_000
DURATION_SECONDS = 24


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def colored_noise(rng: np.random.Generator, samples: int, color: str) -> np.ndarray:
    white = rng.normal(0, 1, samples)
    if color == "white":
        signal = white
    elif color == "pink":
        spectrum = np.fft.rfft(white)
        frequencies = np.fft.rfftfreq(samples)
        spectrum /= np.sqrt(np.maximum(frequencies, 1 / samples))
        signal = np.fft.irfft(spectrum, n=samples)
    else:
        signal = np.cumsum(white)
        signal -= signal.mean()
    signal /= max(float(np.max(np.abs(signal))), 1e-9)
    return signal


def save_wav(path: Path, signal: np.ndarray) -> None:
    pcm = np.clip(signal * 6_000, -32_768, 32_767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    samples = SAMPLE_RATE * DURATION_SECONDS
    for index, color in enumerate(("white", "pink", "brown")):
        rng = np.random.default_rng(8_240 + index)
        signal = colored_noise(rng, samples, color)
        # Add a slow room-like amplitude drift without introducing any speech.
        t = np.arange(samples, dtype=np.float64) / SAMPLE_RATE
        signal *= 0.55 + 0.25 * np.sin(2 * np.pi * (0.07 + index * 0.02) * t)
        save_wav(args.output / f"procedural-{color}.wav", signal)
    print(f"Generated 3 clean background beds in {args.output}")


if __name__ == "__main__":
    main()
