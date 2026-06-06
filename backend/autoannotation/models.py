from __future__ import annotations

import json
import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


def classification_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, Any]:
    y_true = np.asarray(y_true, dtype=np.int64)
    y_pred = np.asarray(y_pred, dtype=np.int64)
    tp = int(np.sum((y_true == 1) & (y_pred == 1)))
    tn = int(np.sum((y_true == 0) & (y_pred == 0)))
    fp = int(np.sum((y_true == 0) & (y_pred == 1)))
    fn = int(np.sum((y_true == 1) & (y_pred == 0)))
    total = int(len(y_true))
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    specificity = tn / (tn + fp) if tn + fp else 0.0
    f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
    balanced_accuracy = (recall + specificity) / 2.0
    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "specificity": specificity,
        "f1": f1,
        "balanced_accuracy": balanced_accuracy,
        "tp": tp,
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "n": total,
    }


def _as_jsonable(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {str(k): _as_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_jsonable(v) for v in value]
    return value


@dataclass
class RobustScaler:
    median_: np.ndarray | None = None
    scale_: np.ndarray | None = None
    clip: float = 12.0

    def fit(self, matrix: np.ndarray) -> "RobustScaler":
        matrix = np.asarray(matrix, dtype=np.float64)
        self.median_ = np.median(matrix, axis=0)
        q1 = np.percentile(matrix, 25, axis=0)
        q3 = np.percentile(matrix, 75, axis=0)
        scale = q3 - q1
        std = np.std(matrix, axis=0)
        scale = np.where(scale < 1e-9, std, scale)
        scale = np.where(scale < 1e-9, 1.0, scale)
        self.scale_ = scale
        return self

    def transform(self, matrix: np.ndarray) -> np.ndarray:
        if self.median_ is None or self.scale_ is None:
            raise RuntimeError("RobustScaler is not fitted")
        scaled = (np.asarray(matrix, dtype=np.float64) - self.median_) / self.scale_
        return np.clip(np.nan_to_num(scaled, nan=0.0, posinf=0.0, neginf=0.0), -self.clip, self.clip)


@dataclass
class WeightedKNN:
    k: int = 15
    matrix_: np.ndarray | None = None
    y_: np.ndarray | None = None

    def fit(self, matrix: np.ndarray, y: np.ndarray) -> "WeightedKNN":
        self.matrix_ = np.asarray(matrix, dtype=np.float64)
        self.y_ = np.asarray(y, dtype=np.float64)
        return self

    def predict_proba(self, matrix: np.ndarray) -> np.ndarray:
        if self.matrix_ is None or self.y_ is None:
            raise RuntimeError("WeightedKNN is not fitted")
        train = self.matrix_
        labels = self.y_
        k = min(max(1, int(self.k)), len(labels))
        output = np.zeros(len(matrix), dtype=np.float64)
        for idx, row in enumerate(np.asarray(matrix, dtype=np.float64)):
            distances = np.sqrt(np.sum((train - row) ** 2, axis=1))
            nearest = np.argpartition(distances, k - 1)[:k]
            weights = 1.0 / (distances[nearest] + 1e-6)
            output[idx] = float(np.sum(weights * labels[nearest]) / np.sum(weights))
        return output


@dataclass
class LogisticRegressionGD:
    l2: float = 0.03
    learning_rate: float = 0.03
    epochs: int = 2200
    weights_: np.ndarray | None = None

    def fit(self, matrix: np.ndarray, y: np.ndarray) -> "LogisticRegressionGD":
        x = np.c_[np.ones(len(matrix)), np.asarray(matrix, dtype=np.float64)]
        x = np.nan_to_num(x, nan=0.0, posinf=12.0, neginf=-12.0)
        labels = np.asarray(y, dtype=np.float64)
        weights = np.zeros(x.shape[1], dtype=np.float64)
        positives = max(1, int(np.sum(labels == 1)))
        negatives = max(1, int(np.sum(labels == 0)))
        class_weights = np.where(
            labels == 1,
            len(labels) / (2.0 * positives),
            len(labels) / (2.0 * negatives),
        )

        for _ in range(self.epochs):
            with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
                logits = x @ weights
            logits = np.nan_to_num(logits, nan=0.0, posinf=35.0, neginf=-35.0)
            logits = np.clip(logits, -35.0, 35.0)
            probs = 1.0 / (1.0 + np.exp(-logits))
            with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
                gradient = (x.T @ ((probs - labels) * class_weights)) / len(labels)
            gradient = np.nan_to_num(gradient, nan=0.0, posinf=20.0, neginf=-20.0)
            gradient[1:] += self.l2 * weights[1:]
            norm = float(np.linalg.norm(gradient))
            if norm > 20.0:
                gradient *= 20.0 / norm
            weights -= self.learning_rate * gradient
            weights = np.nan_to_num(weights, nan=0.0, posinf=50.0, neginf=-50.0)
            weights = np.clip(weights, -50.0, 50.0)

        self.weights_ = weights
        return self

    def predict_proba(self, matrix: np.ndarray) -> np.ndarray:
        if self.weights_ is None:
            raise RuntimeError("LogisticRegressionGD is not fitted")
        x = np.c_[np.ones(len(matrix)), np.asarray(matrix, dtype=np.float64)]
        x = np.nan_to_num(x, nan=0.0, posinf=12.0, neginf=-12.0)
        with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
            logits = x @ self.weights_
        logits = np.nan_to_num(logits, nan=0.0, posinf=35.0, neginf=-35.0)
        logits = np.clip(logits, -35.0, 35.0)
        return np.nan_to_num(1.0 / (1.0 + np.exp(-logits)), nan=0.5)


@dataclass(frozen=True)
class ModelConfig:
    name: str
    k: int = 15
    l2: float = 0.03
    knn_weight: float = 0.55

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "k": self.k,
            "l2": self.l2,
            "knn_weight": self.knn_weight,
        }


@dataclass
class AutoAnnotator:
    feature_names: list[str]
    scaler: RobustScaler
    knn: WeightedKNN
    logistic: LogisticRegressionGD
    threshold: float = 0.5
    knn_weight: float = 0.55
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def fit(
        cls,
        matrix: np.ndarray,
        y: np.ndarray,
        feature_names: list[str],
        *,
        config: ModelConfig,
        threshold: float = 0.5,
        metadata: dict[str, Any] | None = None,
    ) -> "AutoAnnotator":
        scaler = RobustScaler().fit(matrix)
        scaled = scaler.transform(matrix)
        knn = WeightedKNN(k=config.k).fit(scaled, y)
        logistic = LogisticRegressionGD(l2=config.l2).fit(scaled, y)
        return cls(
            feature_names=list(feature_names),
            scaler=scaler,
            knn=knn,
            logistic=logistic,
            threshold=float(threshold),
            knn_weight=float(config.knn_weight),
            metadata=metadata or {},
        )

    def predict_proba_matrix(self, matrix: np.ndarray) -> np.ndarray:
        scaled = self.scaler.transform(matrix)
        knn_probs = self.knn.predict_proba(scaled)
        logistic_probs = self.logistic.predict_proba(scaled)
        weight = float(np.clip(self.knn_weight, 0.0, 1.0))
        return np.clip(weight * knn_probs + (1.0 - weight) * logistic_probs, 0.0, 1.0)

    def predict_matrix(
        self,
        matrix: np.ndarray,
        *,
        threshold: float | None = None,
    ) -> np.ndarray:
        cutoff = self.threshold if threshold is None else threshold
        return (self.predict_proba_matrix(matrix) >= cutoff).astype(np.int64)

    def predict_feature_dicts(
        self,
        features: list[dict[str, float]],
        *,
        threshold: float | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        matrix = np.asarray(
            [[feature.get(name, 0.0) for name in self.feature_names] for feature in features],
            dtype=np.float64,
        )
        probs = self.predict_proba_matrix(matrix)
        cutoff = self.threshold if threshold is None else threshold
        return probs, (probs >= cutoff).astype(np.int64)


def make_candidate_configs() -> list[ModelConfig]:
    return [
        ModelConfig("knn_k7", k=7, l2=0.03, knn_weight=1.0),
        ModelConfig("knn_k15", k=15, l2=0.03, knn_weight=1.0),
        ModelConfig("knn_k21", k=21, l2=0.03, knn_weight=1.0),
        ModelConfig("logistic_l2_003", k=15, l2=0.03, knn_weight=0.0),
        ModelConfig("logistic_l2_010", k=15, l2=0.10, knn_weight=0.0),
        ModelConfig("ensemble_k7_l2_003_w50", k=7, l2=0.03, knn_weight=0.50),
        ModelConfig("ensemble_k15_l2_003_w55", k=15, l2=0.03, knn_weight=0.55),
        ModelConfig("ensemble_k15_l2_010_w55", k=15, l2=0.10, knn_weight=0.55),
        ModelConfig("ensemble_k21_l2_003_w60", k=21, l2=0.03, knn_weight=0.60),
    ]


def stratified_folds(y: np.ndarray, folds: int, seed: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    fold_parts: list[list[int]] = [[] for _ in range(folds)]
    for label in (0, 1):
        indices = np.where(y == label)[0]
        rng.shuffle(indices)
        for fold_idx, part in enumerate(np.array_split(indices, folds)):
            fold_parts[fold_idx].extend(int(index) for index in part)
    return [np.asarray(sorted(part), dtype=np.int64) for part in fold_parts]


def threshold_search(
    y_true: np.ndarray,
    probabilities: np.ndarray,
) -> tuple[float, dict[str, Any]]:
    best_threshold = 0.5
    best_metrics: dict[str, Any] | None = None
    for threshold in np.linspace(0.20, 0.80, 121):
        metrics = classification_metrics(y_true, probabilities >= threshold)
        score = (
            metrics["f1"],
            metrics["balanced_accuracy"],
            metrics["accuracy"],
            -metrics["fp"],
        )
        if best_metrics is None:
            best_threshold = float(threshold)
            best_metrics = metrics
            best_score = score
            continue
        if score > best_score:  # type: ignore[has-type]
            best_threshold = float(threshold)
            best_metrics = metrics
            best_score = score
    assert best_metrics is not None
    return best_threshold, best_metrics


def cross_val_probabilities(
    matrix: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    *,
    config: ModelConfig,
    folds: int,
    seed: int,
) -> np.ndarray:
    probabilities = np.zeros(len(y), dtype=np.float64)
    all_indices = np.arange(len(y))
    for test_idx in stratified_folds(y, folds, seed):
        train_idx = np.setdiff1d(all_indices, test_idx)
        model = AutoAnnotator.fit(
            matrix[train_idx],
            y[train_idx],
            feature_names,
            config=config,
        )
        probabilities[test_idx] = model.predict_proba_matrix(matrix[test_idx])
    return probabilities


def evaluate_configs(
    matrix: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    *,
    folds: int = 5,
    seed: int = 7,
) -> tuple[ModelConfig, float, list[dict[str, Any]]]:
    results: list[dict[str, Any]] = []
    best_config: ModelConfig | None = None
    best_threshold = 0.5
    best_score: tuple[float, float, float, int] | None = None

    for config in make_candidate_configs():
        probabilities = cross_val_probabilities(
            matrix,
            y,
            feature_names,
            config=config,
            folds=folds,
            seed=seed,
        )
        threshold, best_metrics = threshold_search(y, probabilities)
        metrics_05 = classification_metrics(y, probabilities >= 0.5)
        result = {
            "config": config.to_dict(),
            "threshold": threshold,
            "metrics": best_metrics,
            "metrics_at_0_5": metrics_05,
        }
        results.append(_as_jsonable(result))
        score = (
            best_metrics["f1"],
            best_metrics["balanced_accuracy"],
            best_metrics["accuracy"],
            -best_metrics["fp"],
        )
        if best_score is None or score > best_score:
            best_score = score
            best_config = config
            best_threshold = threshold

    assert best_config is not None
    results.sort(
        key=lambda item: (
            item["metrics"]["f1"],
            item["metrics"]["balanced_accuracy"],
            item["metrics"]["accuracy"],
            -item["metrics"]["fp"],
        ),
        reverse=True,
    )
    return best_config, best_threshold, results


def save_model(model: AutoAnnotator, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        pickle.dump(model, handle, protocol=pickle.HIGHEST_PROTOCOL)


def load_model(path: str | Path) -> AutoAnnotator:
    with Path(path).open("rb") as handle:
        model = pickle.load(handle)
    if not isinstance(model, AutoAnnotator):
        raise TypeError(f"{path} does not contain an AutoAnnotator")
    return model


def write_report(report: dict[str, Any], path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(_as_jsonable(report), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
