from __future__ import annotations

import math
import pickle
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np


IMAGE_FEATURE_SUFFIXES: tuple[str, ...] = (
    "present",
    "inside_mean",
    "inside_std",
    "inside_min",
    "inside_p10",
    "inside_p25",
    "inside_p50",
    "inside_p75",
    "inside_p90",
    "inside_max",
    "outside_mean",
    "outside_std",
    "outside_min",
    "outside_p10",
    "outside_p25",
    "outside_p50",
    "outside_p75",
    "outside_p90",
    "outside_max",
    "contrast",
    "grad_inside_mean",
    "edge_density",
)


@dataclass(frozen=True)
class FeatureRecord:
    source_db: str
    row_id: int | None
    cell_id: str
    manual_label: str | None
    y: int | None
    features: dict[str, float]


def normalize_label(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    upper = text.upper()
    if upper in {"N/A", "NA", "NONE", "NULL"} or text == "1000":
        return "N/A"
    if text in {"1", "1.0"}:
        return "1"
    return text


def label_to_binary(value: Any) -> int | None:
    label = normalize_label(value)
    if label == "1":
        return 1
    if label in {"N/A", "0", "1000"}:
        return 0
    return None


def normalize_contour(contour_blob: bytes) -> np.ndarray:
    contour = pickle.loads(contour_blob)
    arr = np.asarray(contour)
    if arr.size == 0:
        raise ValueError("empty contour")

    arr = np.squeeze(arr)
    if arr.ndim == 1:
        if arr.size < 4 or arr.size % 2 != 0:
            raise ValueError(f"invalid contour shape {arr.shape}")
        arr = arr.reshape(-1, 2)
    elif arr.ndim == 2:
        if arr.shape[0] == 2 and arr.shape[1] != 2:
            arr = arr.T
    elif arr.ndim == 3 and arr.shape[-1] == 2:
        arr = arr.reshape(-1, 2)
    else:
        raise ValueError(f"invalid contour shape {arr.shape}")

    if arr.ndim != 2 or arr.shape[1] < 2 or arr.shape[0] < 2:
        raise ValueError(f"invalid contour shape {arr.shape}")
    if arr.shape[1] > 2:
        arr = arr[:, :2]
    return arr.astype(np.float32, copy=False)


def decode_png_blob(blob: bytes | None) -> np.ndarray | None:
    if blob is None:
        return None
    image = cv2.imdecode(np.frombuffer(blob, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        return None
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image


def _safe_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return number


def _add_quantiles(values: np.ndarray, prefix: str, out: dict[str, float]) -> None:
    values = np.asarray(values, dtype=np.float32)
    if values.size == 0:
        for suffix in (
            "mean",
            "std",
            "min",
            "p10",
            "p25",
            "p50",
            "p75",
            "p90",
            "max",
        ):
            out[f"{prefix}_{suffix}"] = 0.0
        return

    out[f"{prefix}_mean"] = float(np.mean(values))
    out[f"{prefix}_std"] = float(np.std(values))
    for q, suffix in (
        (0, "min"),
        (10, "p10"),
        (25, "p25"),
        (50, "p50"),
        (75, "p75"),
        (90, "p90"),
        (100, "max"),
    ):
        out[f"{prefix}_{suffix}"] = float(np.percentile(values, q))


def _add_missing_image_features(channel: str, out: dict[str, float]) -> None:
    for suffix in IMAGE_FEATURE_SUFFIXES:
        out[f"{channel}_{suffix}"] = 0.0


def _normalized_image(image: np.ndarray) -> np.ndarray:
    arr = image.astype(np.float32, copy=False)
    low, high = np.percentile(arr, [1, 99])
    if high <= low:
        return np.zeros(arr.shape, dtype=np.float32)
    norm = np.clip((arr - low) / (high - low), 0.0, 1.0)
    return norm.astype(np.float32, copy=False)


def _add_image_features(
    channel: str,
    image: np.ndarray | None,
    contour_i: np.ndarray,
    shape: tuple[int, int] | None,
    out: dict[str, float],
) -> None:
    if image is None or shape is None:
        _add_missing_image_features(channel, out)
        return

    out[f"{channel}_present"] = 1.0
    norm = _normalized_image(image)
    if norm.shape[:2] != shape:
        norm = cv2.resize(norm, (shape[1], shape[0]), interpolation=cv2.INTER_AREA)

    mask = np.zeros(shape, dtype=np.uint8)
    cv2.drawContours(mask, [contour_i], -1, 255, thickness=-1)
    kernel = np.ones((5, 5), dtype=np.uint8)
    ring = cv2.subtract(cv2.dilate(mask, kernel, iterations=3), mask)

    inside = norm[mask > 0]
    outside = norm[ring > 0]
    _add_quantiles(inside, f"{channel}_inside", out)
    _add_quantiles(outside, f"{channel}_outside", out)

    inside_mean = float(np.mean(inside)) if inside.size else 0.0
    outside_mean = (
        float(np.mean(outside)) if outside.size else float(np.mean(norm))
    )
    out[f"{channel}_contrast"] = (
        (inside_mean - outside_mean) / (float(np.std(norm)) + 1e-6)
    )

    grad_x = cv2.Sobel(norm, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(norm, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(grad_x * grad_x + grad_y * grad_y)
    if inside.size:
        out[f"{channel}_grad_inside_mean"] = float(np.mean(grad[mask > 0]))
        out[f"{channel}_edge_density"] = float(
            np.mean(grad[mask > 0] > np.percentile(grad, 75))
        )
    else:
        out[f"{channel}_grad_inside_mean"] = 0.0
        out[f"{channel}_edge_density"] = 0.0


def extract_feature_dict(
    *,
    perimeter: Any,
    area: Any,
    img_ph: bytes | None,
    img_fluo1: bytes | None,
    img_fluo2: bytes | None,
    contour: bytes,
) -> dict[str, float]:
    points = normalize_contour(contour)
    contour_i = np.rint(points).astype(np.int32).reshape(-1, 1, 2)
    features: dict[str, float] = {}

    measured_area = _safe_float(area, cv2.contourArea(contour_i))
    measured_perimeter = _safe_float(perimeter, cv2.arcLength(contour_i, True))
    features["n_points"] = float(len(points))
    features["area"] = measured_area
    features["log_area"] = math.log1p(max(measured_area, 0.0))
    features["perimeter"] = measured_perimeter
    features["log_perimeter"] = math.log1p(max(measured_perimeter, 0.0))
    features["circularity"] = (
        4.0 * math.pi * measured_area / (measured_perimeter * measured_perimeter)
        if measured_perimeter > 0.0
        else 0.0
    )

    x, y, width, height = cv2.boundingRect(contour_i)
    bbox_area = float(width * height)
    features["bbox_w"] = float(width)
    features["bbox_h"] = float(height)
    features["bbox_area"] = bbox_area
    features["extent"] = measured_area / bbox_area if bbox_area > 0.0 else 0.0
    features["aspect_ratio"] = max(width, height) / max(1.0, min(width, height))
    features["center_dx"] = abs((x + width / 2.0) - 100.0)
    features["center_dy"] = abs((y + height / 2.0) - 100.0)

    hull = cv2.convexHull(contour_i)
    hull_area = float(cv2.contourArea(hull))
    hull_perimeter = float(cv2.arcLength(hull, True))
    features["hull_area"] = hull_area
    features["hull_perimeter"] = hull_perimeter
    features["solidity"] = measured_area / hull_area if hull_area > 0.0 else 0.0
    features["convexity"] = (
        hull_perimeter / measured_perimeter if measured_perimeter > 0.0 else 0.0
    )

    centered = points - np.mean(points, axis=0, keepdims=True)
    if len(points) > 1:
        eigvals = np.linalg.eigvalsh(np.cov(centered, rowvar=False))
        eigvals = np.sort(eigvals)[::-1]
        major = max(float(eigvals[0]), 0.0)
        minor = max(float(eigvals[1]), 0.0)
        features["pca_major_var"] = major
        features["pca_minor_var"] = minor
        features["pca_major_sd"] = math.sqrt(major)
        features["pca_minor_sd"] = math.sqrt(minor)
        features["pca_ratio"] = major / minor if minor > 1e-9 else 0.0
        features["eccentricity"] = math.sqrt(max(0.0, 1.0 - minor / major)) if major else 0.0
    else:
        for name in (
            "pca_major_var",
            "pca_minor_var",
            "pca_major_sd",
            "pca_minor_sd",
            "pca_ratio",
            "eccentricity",
        ):
            features[name] = 0.0

    hu = cv2.HuMoments(cv2.moments(contour_i)).reshape(-1)
    for idx, value in enumerate(hu):
        sign = 1.0 if value >= 0 else -1.0
        features[f"hu_{idx}"] = float(-sign * math.log10(abs(float(value)) + 1e-30))

    images = {
        "ph": decode_png_blob(img_ph),
        "fluo1": decode_png_blob(img_fluo1),
        "fluo2": decode_png_blob(img_fluo2),
    }
    shape = next((image.shape[:2] for image in images.values() if image is not None), None)
    for channel, image in images.items():
        _add_image_features(channel, image, contour_i, shape, features)

    return {key: _safe_float(value) for key, value in features.items()}


def _available_columns(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(cells)").fetchall()
    }


def _select_expression(columns: set[str], name: str, alias: str | None = None) -> str:
    if name in columns:
        return f"{name} AS {alias or name}"
    return f"NULL AS {alias or name}"


def iter_cell_rows(db_path: str | Path) -> Iterable[sqlite3.Row]:
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    try:
        columns = _available_columns(connection)
        row_id_expr = "id AS row_id" if "id" in columns else "rowid AS row_id"
        select_parts = [
            row_id_expr,
            _select_expression(columns, "cell_id"),
            _select_expression(columns, "manual_label"),
            _select_expression(columns, "perimeter"),
            _select_expression(columns, "area"),
            _select_expression(columns, "img_ph"),
            _select_expression(columns, "img_fluo1"),
            _select_expression(columns, "img_fluo2"),
            _select_expression(columns, "contour"),
        ]
        query = f"SELECT {', '.join(select_parts)} FROM cells ORDER BY row_id"
        yield from connection.execute(query)
    finally:
        connection.close()


def load_records(
    db_paths: Iterable[str | Path],
    *,
    require_labeled: bool = True,
) -> list[FeatureRecord]:
    records: list[FeatureRecord] = []
    for db_path in db_paths:
        path = Path(db_path)
        for row in iter_cell_rows(path):
            if row["contour"] is None:
                continue
            y = label_to_binary(row["manual_label"])
            if require_labeled and y is None:
                continue
            features = extract_feature_dict(
                perimeter=row["perimeter"],
                area=row["area"],
                img_ph=row["img_ph"],
                img_fluo1=row["img_fluo1"],
                img_fluo2=row["img_fluo2"],
                contour=row["contour"],
            )
            records.append(
                FeatureRecord(
                    source_db=path.name,
                    row_id=row["row_id"],
                    cell_id=str(row["cell_id"] or ""),
                    manual_label=normalize_label(row["manual_label"]),
                    y=y,
                    features=features,
                )
            )
    return records


def feature_names_from_records(records: Iterable[FeatureRecord]) -> list[str]:
    names: set[str] = set()
    for record in records:
        names.update(record.features)
    return sorted(names)


def records_to_matrix(
    records: list[FeatureRecord],
    feature_names: list[str] | None = None,
) -> tuple[np.ndarray, np.ndarray | None, list[str]]:
    names = list(feature_names or feature_names_from_records(records))
    matrix = np.asarray(
        [[record.features.get(name, 0.0) for name in names] for record in records],
        dtype=np.float64,
    )
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0)
    labels = [record.y for record in records]
    y = None if any(label is None for label in labels) else np.asarray(labels, dtype=np.int64)
    return matrix, y, names


def current_heuristic_from_features(features: dict[str, float]) -> int:
    return int(
        features.get("pca_minor_var", math.inf) <= 120.0
        and features.get("convexity", 0.0) > 0.85
    )
