"""Per-cell features for the linked phenotype scatter plot."""

from __future__ import annotations

import hashlib
import logging
from collections import OrderedDict
from threading import Lock
from typing import Any

import numpy as np
from sqlalchemy import String, cast, or_, select

from app.bulk_engine.crud import (
    _calc_cell_length_px,
    _calc_normalized_median_intensity,
)
from app.bulk_engine.heatmap_bulk_core import calculate_cell_width_metrics
from app.bulk_engine.fluorescence_localization import (
    BackgroundMode,
    LOCALIZATION_PARAMETERS,
    LOCALIZATION_UNITS,
    calculate_localization_metrics,
)
from app.database_manager.crud import (
    DatabaseManagerCrud,
    _normalize_annotation_label,
    get_cells_table,
)

FEATURE_VERSION = "2"
FEATURE_UNITS = {
    "length_px": "px",
    "width_mean_px": "px",
    "width_median_px": "px",
    "area_px2": "px^2",
    "fluo1_normalized_median": "dimensionless",
    "fluo2_normalized_median": "dimensionless",
    **{f"{channel}_{key}": unit for channel in ("fluo1", "fluo2")
       for key, unit in LOCALIZATION_UNITS.items()},
}
_CACHE_LIMIT = 4096
_cache: OrderedDict[bytes, dict[str, float | None]] = OrderedDict()
_cache_lock = Lock()
logger = logging.getLogger(__name__)


def _finite_number(value: object, *, positive: bool = False) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not np.isfinite(number) or number < 0 or (positive and number == 0):
        return None
    return number


def _cell_features(
    contour: bytes | None,
    image_ph: bytes | None,
    image_fluo1: bytes | None,
    image_fluo2: bytes | None,
    area: float | None,
    degree: int,
    background_mode: BackgroundMode,
) -> tuple[bytes, dict[str, float | None]]:
    # Cache only small numeric results. Content hashes invalidate results after
    # contour/image edits, including edits made outside this application.
    digest = hashlib.blake2b(digest_size=20)
    digest.update(f"{FEATURE_VERSION}:{degree}:{area}:{background_mode}".encode())
    for blob in (contour, image_ph, image_fluo1, image_fluo2):
        digest.update((-1 if blob is None else len(blob)).to_bytes(8, "big", signed=True))
        if blob is not None:
            digest.update(blob)
    fingerprint = digest.digest()
    with _cache_lock:
        cached = _cache.get(fingerprint)
        if cached is not None:
            _cache.move_to_end(fingerprint)
            return fingerprint, cached.copy()

    features: dict[str, float | None] = dict.fromkeys(FEATURE_UNITS)
    features["area_px2"] = area
    if contour:
        try:
            features["length_px"] = _finite_number(
                _calc_cell_length_px(image_ph, contour), positive=True
            )
        except Exception:
            logger.debug("Could not calculate phenotype length", exc_info=True)
        try:
            mean_width, median_width = calculate_cell_width_metrics(contour, degree)
            features["width_mean_px"] = _finite_number(mean_width, positive=True)
            features["width_median_px"] = _finite_number(median_width, positive=True)
        except Exception:
            logger.debug("Could not calculate phenotype width", exc_info=True)
        for channel, image in (("fluo1", image_fluo1), ("fluo2", image_fluo2)):
            if image:
                try:
                    features[f"{channel}_normalized_median"] = _finite_number(
                        _calc_normalized_median_intensity(image, contour)
                    )
                except Exception:
                    logger.debug("Could not calculate phenotype fluorescence", exc_info=True)
                try:
                    localization = calculate_localization_metrics(image, contour, degree, background_mode)
                    features.update({f"{channel}_{key}": _finite_number(value)
                                     for key, value in localization.items()})
                except Exception:
                    logger.debug("Could not calculate fluorescence localization", exc_info=True)

    with _cache_lock:
        _cache[fingerprint] = features.copy()
        _cache.move_to_end(fingerprint)
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)
    return fingerprint, features


def get_phenotype_features(
    db_name: str, label: str | None = None, degree: int = 4,
    background_mode: BackgroundMode = "local_ring",
) -> dict[str, Any]:
    """Read cells once and retain missing/invalid measurements as JSON nulls."""
    if degree < 1:
        raise ValueError("degree must be >= 1")
    if background_mode not in ("local_ring", "none"):
        raise ValueError("Invalid background mode")
    label_text = str(label).strip() if label is not None else ""
    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)
        stmt = select(
            cells.c.cell_id,
            cells.c.manual_label,
            cells.c.area,
            cells.c.contour,
            cells.c.img_ph,
            cells.c.img_fluo1,
            cells.c.img_fluo2,
        ).where(cells.c.cell_id.is_not(None)).order_by(cells.c.cell_id)
        if label_text and label_text.lower() != "all":
            if _normalize_annotation_label(label_text) == "N/A":
                stmt = stmt.where(or_(
                    cells.c.manual_label.is_(None),
                    cast(cells.c.manual_label, String).in_(["N/A", "1000", ""]),
                ))
            else:
                stmt = stmt.where(cast(cells.c.manual_label, String) == label_text)

        rows = []
        source_digest = hashlib.blake2b(digest_size=20)
        for cell_id, manual_label, area, contour, image_ph, fluo1, fluo2 in session.execute(stmt):
            fingerprint, features = _cell_features(
                *(bytes(blob) if blob is not None else None
                  for blob in (contour, image_ph, fluo1, fluo2)),
                area=_finite_number(area, positive=True),
                degree=degree,
                background_mode=background_mode,
            )
            normalized_label = _normalize_annotation_label(manual_label)
            source_digest.update(fingerprint)
            source_digest.update(str(cell_id).encode() + b"\0" + normalized_label.encode() + b"\0")
            rows.append({
                "cell_id": str(cell_id),
                "manual_label": normalized_label,
                **features,
            })
        return {
            "dbname": db_name,
            "feature_version": FEATURE_VERSION,
            "source_fingerprint": source_digest.hexdigest(),
            "degree": degree,
            "units": FEATURE_UNITS.copy(),
            "localization": {"background_mode": background_mode, **LOCALIZATION_PARAMETERS},
            "cells": rows,
        }
    finally:
        session.close()
