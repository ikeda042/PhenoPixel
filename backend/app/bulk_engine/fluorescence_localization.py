"""Defined concentration and position descriptors of intracellular fluorescence."""

from __future__ import annotations

from typing import Literal

import cv2
import numpy as np

from app.bulk_engine.heatmap_bulk_core import (
    _decode_grayscale_preserve_depth,
    _parse_contour_points,
    _project_points_to_polynomial,
)

BackgroundMode = Literal["local_ring", "none"]
LOCALIZATION_UNITS = {
    "entropy_norm": "dimensionless",
    "hoyer_sparsity": "dimensionless",
    "top10_fraction": "dimensionless",
    "polar_enrichment": "dimensionless",
    "midcell_enrichment": "dimensionless",
    "axial_spread": "relative cell length",
    "axial_offset": "dimensionless",
    "axial_asymmetry": "dimensionless",
    "background_intensity": "image intensity units",
}
LOCALIZATION_PARAMETERS = {
    "background_ring_px": 3,
    "pole_fraction": 0.2,
    "midcell_start": 0.4,
    "midcell_end": 0.6,
    "top_fraction": 0.1,
    "coordinate": "normalized_centerline_arc_length",
}


def _axial_coordinates(y: np.ndarray, x: np.ndarray, degree: int) -> np.ndarray:
    points = np.column_stack((x, y)).astype(float)
    centered = points - points.mean(axis=0)
    values, vectors = np.linalg.eigh(np.cov(centered, rowvar=False))
    if not np.all(np.isfinite(values)) or values[-1] <= 0:
        raise ValueError("Cell has no longitudinal extent")
    long_axis = vectors[:, -1]
    short_axis = np.array([-long_axis[1], long_axis[0]])
    long = centered @ long_axis
    short = centered @ short_axis
    lower, upper = float(long.min()), float(long.max())
    fit_degree = min(degree, np.unique(long).size - 1)
    if upper <= lower or fit_degree < 1:
        raise ValueError("Cannot fit localization centerline")
    # Scale the polynomial fit domain to avoid powers of large image coordinates.
    fitted = np.polynomial.Polynomial.fit(long, short, fit_degree).convert()
    coefficients = fitted.coef[::-1]
    if not np.all(np.isfinite(coefficients)):
        raise ValueError("Invalid localization centerline")
    projected = _project_points_to_polynomial(coefficients, long, short, lower, upper)
    sample_x = np.linspace(lower, upper, min(4097, max(257, int(np.ceil(upper - lower)) * 4 + 1)))
    speed = np.sqrt(1.0 + fitted.deriv()(sample_x) ** 2)
    increments = np.diff(sample_x) * (speed[:-1] + speed[1:]) / 2
    arc = np.r_[0.0, np.cumsum(increments)]
    if not np.isfinite(arc[-1]) or arc[-1] <= 0:
        raise ValueError("Invalid centerline arc length")
    return np.clip(np.interp(projected, sample_x, arc) / arc[-1], 0, 1)


def calculate_localization_metrics(
    image_raw: bytes,
    contour_raw: bytes,
    degree: int = 4,
    background_mode: BackgroundMode = "local_ring",
) -> dict[str, float | None]:
    if degree < 1:
        raise ValueError("degree must be >= 1")
    if background_mode not in ("local_ring", "none"):
        raise ValueError("Invalid background mode")
    image = _decode_grayscale_preserve_depth(image_raw)
    points, contour = _parse_contour_points(contour_raw)
    if not np.all(np.isfinite(points)) or len(points) < 3 or cv2.contourArea(contour) <= 0:
        raise ValueError("Invalid fluorescence contour")
    mask = np.zeros(image.shape, dtype=np.uint8)
    cv2.fillPoly(mask, [contour], 1)
    y, x = np.nonzero(mask)
    result: dict[str, float | None] = dict.fromkeys(LOCALIZATION_UNITS)
    if x.size < 2:
        return result
    background = 0.0
    if background_mode == "local_ring":
        radius = LOCALIZATION_PARAMETERS["background_ring_px"]
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
        ring = (cv2.dilate(mask, kernel) != 0) & (mask == 0)
        if not np.any(ring):
            return result
        background = float(np.median(image[ring]))
    result["background_intensity"] = background
    weights = np.maximum(image[y, x].astype(float) - background, 0)
    total = float(weights.sum())
    if not np.isfinite(total) or total <= 0:
        return result
    p = weights / total
    positive = p[p > 0]
    result["entropy_norm"] = float(np.clip(-np.sum(positive * np.log(positive)) / np.log(p.size), 0, 1))
    root_n = np.sqrt(p.size)
    result["hoyer_sparsity"] = float(np.clip((root_n - 1 / np.linalg.norm(p)) / (root_n - 1), 0, 1))
    top_count = max(1, int(np.ceil(LOCALIZATION_PARAMETERS["top_fraction"] * p.size)))
    result["top10_fraction"] = float(np.partition(p, p.size - top_count)[-top_count:].sum())

    try:
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            t = _axial_coordinates(y, x, degree)
        if not np.all(np.isfinite(t)):
            return result
    except (ValueError, np.linalg.LinAlgError, FloatingPointError):
        return result

    tolerance = 1e-7
    poles = (t <= LOCALIZATION_PARAMETERS["pole_fraction"] + tolerance) | (t >= 1 - LOCALIZATION_PARAMETERS["pole_fraction"] - tolerance)
    middle = (t >= LOCALIZATION_PARAMETERS["midcell_start"] - tolerance) & (t <= LOCALIZATION_PARAMETERS["midcell_end"] + tolerance)
    # Mean intensity ratios correct for different pixel counts in these regions.
    for name, region in (("polar_enrichment", poles), ("midcell_enrichment", middle)):
        if np.any(region):
            result[name] = float(p[region].sum() * p.size / np.count_nonzero(region))
    mean_t = float(np.sum(p * t))
    result["axial_spread"] = float(np.sqrt(np.sum(p * ((t - mean_t) ** 2))))
    result["axial_offset"] = float(np.clip(2 * abs(mean_t - 0.5), 0, 1))
    # Midline pixels contribute half to each side so a central spot is symmetric.
    left = np.where(np.isclose(t, 0.5, atol=tolerance, rtol=0), 0.5, (t < 0.5).astype(float))
    right = 1 - left
    if left.sum() > 0 and right.sum() > 0:
        mean_left = float(np.sum(p * left) / left.sum())
        mean_right = float(np.sum(p * right) / right.sum())
        if mean_left + mean_right > 0:
            result["axial_asymmetry"] = float(abs(mean_left - mean_right) / (mean_left + mean_right))
    return result
