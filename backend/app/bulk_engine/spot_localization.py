"""Shape-based coordinates for detected GFP foci, independent of GFP intensity.

Longitudinal coordinates follow a contour-derived centerline from pole to pole.
Transverse coordinates divide signed normal distance by the local half-width.
Neither intensity alignment nor symmetry augmentation is applied.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from dataclasses import asdict, dataclass
import hashlib
import logging
from threading import Lock

import cv2
import numpy as np
from scipy.optimize import brentq
from sqlalchemy import String, cast, or_, select

from app.bulk_engine.heatmap_bulk_core import _parse_contour_points
from app.database_manager.crud import (
    DatabaseManagerCrud, _as_grayscale, _decode_image, _normalize_annotation_label,
    _prepare_replot_geometry, _project_points_to_polynomial, get_cells_table,
)
from app.database_manager.spot_detection import analyze_spots

MAX_SPOTS = 10
VERSION = "1"
MIN_HALF_WIDTH_PX = 1.0
_CACHE_LIMIT = 2048
_cache: OrderedDict[bytes, dict] = OrderedDict()
_cache_lock = Lock()
logger = logging.getLogger(__name__)


def _cross(a, b):
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


def _line_intersections(contour, origin, direction):
    edges = np.roll(contour, -1, axis=0) - contour
    delta = contour - origin
    denominator = _cross(direction, edges)
    valid = np.abs(denominator) > 1e-10
    t = np.divide(_cross(delta, edges), denominator, out=np.zeros(len(edges)), where=valid)
    u = np.divide(_cross(delta, direction), denominator, out=np.zeros(len(edges)), where=valid)
    return np.unique(t[valid & (u >= -1e-8) & (u <= 1 + 1e-8)])


@dataclass
class CellCoordinates:
    origin: np.ndarray
    basis: np.ndarray
    contour: np.ndarray
    coefficients: np.ndarray
    sample_x: np.ndarray
    arc: np.ndarray

    @classmethod
    def from_contour(cls, contour, coordinates):
        pixels = coordinates[:, ::-1].astype(float)
        origin = pixels.mean(axis=0)
        values, vectors = np.linalg.eigh(np.cov(pixels - origin, rowvar=False))
        if not np.isfinite(values).all() or values[-1] <= 0 or values[-1] < 1.2 * values[0]:
            raise ValueError("Cell has no well-defined long axis")
        long = vectors[:, -1]
        # A reproducible image-coordinate convention, not a biological pole label.
        if long[np.argmax(np.abs(long))] < 0:
            long = -long
        basis = np.column_stack((long, [-long[1], long[0]]))
        aligned = (contour - origin) @ basis
        lower, upper = aligned[:, 0].min(), aligned[:, 0].max()
        if upper - lower < 4:
            raise ValueError("Cell is too short to normalize")
        # Fit slice midpoints rather than intensity-weighted positions or pixel density.
        samples = np.linspace(lower, upper, 65)[1:-1]
        midpoints, fit_x = [], []
        for x in samples:
            ys = _line_intersections(aligned, np.array([x, 0.0]), np.array([0.0, 1.0]))
            if len(ys) != 2:
                # Pixel-scale notches, especially near poles, can intersect a slice
                # more than twice. Fit only unambiguous sections of the original contour.
                continue
            fit_x.append(x)
            midpoints.append((ys[0] + ys[-1]) / 2)
        if len(fit_x) < .8 * len(samples):
            raise ValueError("Contour is not a single rod-shaped cell")
        fitted = np.polynomial.Polynomial.fit(fit_x, midpoints, 4).convert()
        coefficients = fitted.coef[::-1]
        if not np.isfinite(coefficients).all():
            raise ValueError("Could not fit a centerline")
        polygon = aligned.astype(np.float32)

        def boundary_distance(x):
            return cv2.pointPolygonTest(polygon, (float(x), float(fitted(x))), True)

        xs = np.linspace(lower, upper, 1025)
        distances = np.array([boundary_distance(x) for x in xs])
        inside = np.flatnonzero(distances > 0)
        if len(inside) < 2 or np.any(np.diff(inside) != 1):
            raise ValueError("Centerline does not stay inside the cell")
        first, last = inside[0], inside[-1]
        lo = brentq(boundary_distance, xs[first - 1], xs[first]) if first else lower
        hi = brentq(boundary_distance, xs[last], xs[last + 1]) if last < len(xs) - 1 else upper
        xs = np.linspace(lo, hi, 2049)
        speed = np.sqrt(1 + fitted.deriv()(xs) ** 2)
        arc = np.r_[0.0, np.cumsum(np.diff(xs) * (speed[:-1] + speed[1:]) / 2)]
        if not np.isfinite(arc[-1]) or arc[-1] <= 0:
            raise ValueError("Invalid centerline length")
        return cls(origin, basis, aligned, coefficients, xs, arc)

    def locate(self, raw_center):
        point = (np.asarray(raw_center) - self.origin) @ self.basis
        x, y, _ = _project_points_to_polynomial(
            self.coefficients, np.array([point[0]]), np.array([point[1]]),
            float(self.sample_x[0]), float(self.sample_x[-1]),
        )
        t = float(np.interp(x[0], self.sample_x, self.arc) / self.arc[-1])
        slope = np.polyval(np.polyder(self.coefficients), x[0])
        normal = np.array([-slope, 1.0]) / np.hypot(slope, 1)
        foot = np.array([x[0], y[0]])
        distance = float((point - foot) @ normal)
        crossings = _line_intersections(self.contour, foot, normal)
        positive, negative = crossings[crossings > 1e-7], crossings[crossings < -1e-7]
        lateral, reason = None, "Local width is unreliable near a pole"
        if len(positive) and len(negative):
            half_width = float(positive.min() if distance >= 0 else -negative.max())
            # Endpoint projections and narrow sections do not have reliable transverse coordinates.
            if half_width >= MIN_HALF_WIDTH_PX and 1e-5 < t < 1 - 1e-5:
                relative = distance / half_width
                if abs(relative) <= 1 + 1e-5:
                    lateral, reason = float(np.clip(relative, -1, 1)), None
                else:
                    reason = "Fitted center is outside the local contour section"
        return {
            "longitudinal": t, "nearest_pole": min(t, 1 - t),
            "lateral": lateral, "lateral_reason": reason,
        }


def analyze_cell(image_raw: bytes, contour_raw: bytes) -> dict:
    image = _as_grayscale(_decode_image(image_raw))
    contour, _ = _parse_contour_points(contour_raw)
    if not np.isfinite(contour).all() or len(contour) < 3:
        raise ValueError("Invalid contour")
    coordinates, _, _, _, _, points = _prepare_replot_geometry(image, contour_raw)
    geometry = CellCoordinates.from_contour(contour, coordinates)
    # Same input coordinates and settings as the single-cell e-means spots panel.
    result = analyze_spots(image, coordinates, np.asarray(points)[:, ::-1],
                           max_spots=MAX_SPOTS, auto_tune=True)
    spots = []
    for index, spot in enumerate(result.spots):
        center = spot.raw_center
        spots.append({
            "spot_id": index + 1, "raw_x": float(center[0]), "raw_y": float(center[1]),
            **geometry.locate(center), "amplitude": spot.amplitude, "snr": spot.snr,
            "bic_improvement": spot.bic_improvement,
        })
    return {"status": "ok", "error": None, "length_px": float(geometry.arc[-1]),
            "at_cap": len(spots) == MAX_SPOTS, "settings": asdict(result.settings), "spots": spots}


def _cached_cell(image_raw, contour_raw):
    digest = hashlib.blake2b(digest_size=20)
    digest.update(f"{VERSION}:{MAX_SPOTS}:auto".encode())
    for blob in (image_raw, contour_raw):
        digest.update((-1 if blob is None else len(blob)).to_bytes(8, "big", signed=True))
        if blob is not None:
            digest.update(blob)
    key = digest.digest()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return deepcopy(_cache[key])
    error = "Fluorescence image missing" if image_raw is None else "Contour missing" if contour_raw is None else None
    if error is None:
        try:
            result = analyze_cell(image_raw, contour_raw)
        except Exception as exc:
            logger.debug("Spot localization failed for a cell", exc_info=True)
            error = str(exc) if isinstance(exc, ValueError) else "Could not analyze image or contour"
    if error is not None:
        result = {"status": "skipped", "error": error, "length_px": None,
                  "at_cap": False, "settings": None, "spots": []}
    with _cache_lock:
        _cache[key] = deepcopy(result)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)
    return result


def get_spot_localization(db_name: str, label: str | None = None, channel: str = "fluo1") -> dict:
    if channel not in ("fluo1", "fluo2"):
        raise ValueError("Spot localization requires fluo1 or fluo2")
    label_text = str(label).strip() if label is not None else ""
    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)
        query = select(cells.c.cell_id, cells.c.manual_label, cells.c[f"img_{channel}"], cells.c.contour) \
            .where(cells.c.cell_id.is_not(None)).order_by(cells.c.cell_id)
        if label_text and label_text.lower() != "all":
            if _normalize_annotation_label(label_text) == "N/A":
                query = query.where(or_(cells.c.manual_label.is_(None),
                    cast(cells.c.manual_label, String).in_(["N/A", "1000", ""])))
            else:
                query = query.where(cast(cells.c.manual_label, String) == label_text)
        rows = [{"cell_id": str(cell_id), "manual_label": _normalize_annotation_label(manual_label),
                 **_cached_cell(bytes(image) if image is not None else None,
                                bytes(contour) if contour is not None else None)}
                for cell_id, manual_label, image, contour in session.execute(query)]
    finally:
        session.close()
    successful = [row for row in rows if row["status"] == "ok"]
    return {
        "dbname": db_name, "channel": channel, "label": label_text or "All",
        "version": VERSION, "max_spots": MAX_SPOTS, "auto_tune": True,
        "coordinate_system": "contour_centerline_arc_length_and_local_half_width",
        "orientation": "image_geometry_only; poles and transverse sides are unassigned",
        "summary": {
            "total_cells": len(rows), "analyzed_cells": len(successful),
            "skipped_cells": len(rows) - len(successful),
            "positive_cells": sum(bool(row["spots"]) for row in successful),
            "total_spots": sum(len(row["spots"]) for row in successful),
            "at_cap_cells": sum(row["at_cap"] for row in successful),
            "unmapped_lateral_spots": sum(spot["lateral"] is None for row in successful for spot in row["spots"]),
        },
        "cells": rows,
    }
