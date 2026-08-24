#!/usr/bin/env python3
"""Evaluate a fixed-window openWakeWord ONNX classifier in vectorized batches."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--positive", required=True, type=Path)
    parser.add_argument("--negative", required=True, type=Path)
    parser.add_argument("--validation", required=True, type=Path)
    parser.add_argument("--local-negative", required=True, type=Path)
    parser.add_argument("--thresholds", default="0.30,0.35,0.40,0.45,0.50,0.60,0.70")
    parser.add_argument("--validation-hours", type=float, default=11.3)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def load_weights(model_path: Path) -> dict[str, np.ndarray]:
    model = onnx.load_model(model_path, load_external_data=True)
    return {item.name: numpy_helper.to_array(item) for item in model.graph.initializer}


def layer_norm(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    mean = x.mean(axis=-1, keepdims=True)
    variance = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
    return ((x - mean) / np.sqrt(variance + 1e-5)) * weight + bias


def predict(features: np.ndarray, weights: dict[str, np.ndarray], batch_size: int = 4096) -> np.ndarray:
    predictions: list[np.ndarray] = []
    for start in range(0, len(features), batch_size):
        x = np.asarray(features[start : start + batch_size], dtype=np.float32).reshape(-1, 1536)
        x = x @ weights["layer1.weight"].T + weights["layer1.bias"]
        x = layer_norm(x, weights["layernorm1.weight"], weights["layernorm1.bias"])
        x = np.maximum(x, 0)
        x = x @ weights["blocks.0.fcn_layer.weight"].T + weights["blocks.0.fcn_layer.bias"]
        x = layer_norm(x, weights["blocks.0.layer_norm.weight"], weights["blocks.0.layer_norm.bias"])
        x = np.maximum(x, 0)
        x = x @ weights["last_layer.weight"].T + weights["last_layer.bias"]
        predictions.append((1 / (1 + np.exp(-x))).reshape(-1))
    return np.concatenate(predictions)


def windows(features: np.ndarray, size: int = 16) -> np.ndarray:
    return np.lib.stride_tricks.sliding_window_view(features, size, axis=0).transpose(0, 2, 1)


def quantiles(scores: np.ndarray) -> dict[str, float]:
    return {
        str(q): float(np.quantile(scores, q))
        for q in (0, 0.01, 0.05, 0.1, 0.5, 0.9, 0.95, 0.99, 1)
    }


def main() -> None:
    args = parse_args()
    weights = load_weights(args.model)
    positive = np.load(args.positive, mmap_mode="r")
    negative = np.load(args.negative, mmap_mode="r")
    validation = np.load(args.validation, mmap_mode="r")
    local_negative = np.load(args.local_negative, mmap_mode="r")

    positive_scores = predict(positive, weights)
    negative_scores = predict(negative, weights)
    validation_scores = predict(windows(validation), weights)
    local_negative_scores = predict(local_negative, weights)

    metrics = []
    for threshold in (float(item) for item in args.thresholds.split(",")):
        metrics.append(
            {
                "threshold": threshold,
                "recall": float((positive_scores >= threshold).mean()),
                "adversarial_false_positive_rate": float((negative_scores >= threshold).mean()),
                "validation_false_positives_per_hour": float(
                    (validation_scores >= threshold).sum() / args.validation_hours
                ),
                "local_negative_false_positive_rate": float(
                    (local_negative_scores >= threshold).mean()
                ),
            }
        )

    report = {
        "model": str(args.model),
        "counts": {
            "positive": len(positive_scores),
            "adversarial_negative": len(negative_scores),
            "validation_windows": len(validation_scores),
            "local_negative": len(local_negative_scores),
        },
        "score_quantiles": {
            "positive": quantiles(positive_scores),
            "adversarial_negative": quantiles(negative_scores),
            "validation": quantiles(validation_scores),
            "local_negative": quantiles(local_negative_scores),
        },
        "metrics": metrics,
    }
    output = json.dumps(report, ensure_ascii=False, indent=2)
    print(output)
    if args.output:
        args.output.write_text(output + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
