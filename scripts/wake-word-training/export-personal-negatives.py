#!/usr/bin/env python3
"""Export saved local negative acoustic features to openWakeWord .npy format.

Only already-extracted 16x96 embeddings are read. No microphone audio is read,
written, uploaded, or reconstructed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = json.loads(args.dataset.read_text(encoding="utf-8"))
    keywords = payload.get("keywords", {})
    samples: list[list[float]] = []
    seen: set[bytes] = set()

    for keyword in ("ashley", "jarvis"):
        for sample in keywords.get(keyword, {}).get("negativeSamples", []):
            array = np.asarray(sample, dtype=np.float32)
            if array.size != 16 * 96 or not np.isfinite(array).all():
                continue
            key = array.tobytes()
            if key in seen:
                continue
            seen.add(key)
            samples.append(array.tolist())

    if not samples:
        raise SystemExit("No valid 16x96 local negative features were found.")

    output = np.asarray(samples, dtype=np.float32).reshape(-1, 16, 96)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.save(args.output, output, allow_pickle=False)
    print(f"Exported {output.shape[0]} local negative feature windows to {args.output}")


if __name__ == "__main__":
    main()
