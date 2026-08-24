#!/usr/bin/env python3
"""Embed PyTorch ONNX external weights into one browser-loadable model file."""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    model = onnx.load_model(args.source, load_external_data=True)
    onnx.save_model(model, args.destination, save_as_external_data=False)
    onnx.checker.check_model(args.destination)


if __name__ == "__main__":
    main()
