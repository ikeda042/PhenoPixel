from __future__ import annotations

import json
import math
import sqlite3
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any
from uuid import uuid4

import cv2
import numpy as np
from fastapi import HTTPException

from app.mother_machine.database import load_dataset_manifest, query_review_image
from app.mother_machine.processor import (
    MODEL_NAME,
    ChannelRoi,
    _build_frame_index,
    _load_config,
    _read_frame,
    _segment_band,
    best_profile_shift,
    extract_channel_cells,
    load_view_config,
    shifted_channels,
    vertical_edge_profile,
    wall_profile,
)


TRAINING_SCHEMA_VERSION = 3
FRAME_STATES = {"pending", "inferring", "draft", "reviewed", "failed"}
DATASET_STATES = {"uploading", "preparing", "annotating", "paused", "completed"}
_inference_lock = Lock()
_cellpose_model: Any | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_training_database(path: Path, filename: str, model: str = "cpsam_v2") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    connection = sqlite3.connect(path)
    try:
        _create_tables(connection)
        now = _now()
        connection.execute(
            """
            INSERT INTO training_dataset(
                id, source_filename, status, current_order, total_frames,
                reviewed_count, model, created_at, updated_at
            ) VALUES (1, ?, 'uploading', 0, 0, 0, ?, ?, ?)
            """,
            (filename, model, now, now),
        )
        connection.commit()
    finally:
        connection.close()


def _create_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS training_dataset (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_filename TEXT NOT NULL,
            status TEXT NOT NULL,
            current_order INTEGER NOT NULL DEFAULT 0,
            total_frames INTEGER NOT NULL DEFAULT 0,
            reviewed_count INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL,
            niter INTEGER NOT NULL DEFAULT 500,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS dataset_manifest (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS training_frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            view_index INTEGER NOT NULL,
            roi_id INTEGER NOT NULL,
            time_frame INTEGER NOT NULL,
            order_index INTEGER NOT NULL UNIQUE,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            raw_image BLOB NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            error TEXT,
            UNIQUE(view_index, roi_id, time_frame)
        );
        CREATE INDEX IF NOT EXISTS idx_training_frames_status
            ON training_frames(status, order_index);
        CREATE TABLE IF NOT EXISTS training_annotations (
            frame_id INTEGER NOT NULL REFERENCES training_frames(id) ON DELETE CASCADE,
            instance_id TEXT NOT NULL,
            display_order INTEGER NOT NULL,
            points_json TEXT NOT NULL,
            PRIMARY KEY(frame_id, instance_id),
            UNIQUE(frame_id, display_order)
        );
        CREATE TABLE IF NOT EXISTS training_masks (
            frame_id INTEGER PRIMARY KEY REFERENCES training_frames(id) ON DELETE CASCADE,
            auto_mask BLOB,
            corrected_mask BLOB
        );
        CREATE TABLE IF NOT EXISTS annotation_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            frame_id INTEGER NOT NULL REFERENCES training_frames(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            status TEXT NOT NULL,
            instances_json TEXT NOT NULL,
            mask_png BLOB NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(frame_id, revision)
        );
        """
    )


def _sync_manifest(connection: sqlite3.Connection) -> None:
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dataset_manifest'"
    ).fetchone() is None:
        return
    record = connection.execute(
        "SELECT manifest_json FROM dataset_manifest WHERE id = 1"
    ).fetchone()
    dataset = connection.execute(
        "SELECT status, current_order, total_frames, reviewed_count, updated_at FROM training_dataset WHERE id = 1"
    ).fetchone()
    if record is None or dataset is None:
        return
    manifest = json.loads(record[0])
    manifest["schema_version"] = TRAINING_SCHEMA_VERSION
    manifest["training"] = {
        "status": dataset[0],
        "current_order": int(dataset[1]),
        "total_frames": int(dataset[2]),
        "reviewed_count": int(dataset[3]),
        "updated_at": dataset[4],
    }
    connection.execute(
        "UPDATE dataset_manifest SET manifest_json = ? WHERE id = 1",
        (json.dumps(manifest, ensure_ascii=False),),
    )


def ensure_training_schema(path: Path) -> None:
    if not path.is_file():
        return
    connection = sqlite3.connect(path)
    try:
        _create_tables(connection)
        connection.commit()
    finally:
        connection.close()


def set_dataset_status(path: Path, status: str, error: str | None = None) -> None:
    if status not in DATASET_STATES:
        raise ValueError(f"Invalid dataset status: {status}")
    ensure_training_schema(path)
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "UPDATE training_dataset SET status = ?, error = ?, updated_at = ? WHERE id = 1",
            (status, error, _now()),
        )
        _sync_manifest(connection)
        connection.commit()
    finally:
        connection.close()


def _encode_png(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("Failed to encode PNG")
    return encoded.tobytes()


def _decode_png(data: bytes, flags: int = cv2.IMREAD_UNCHANGED) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), flags)
    if image is None:
        raise ValueError("Invalid PNG data")
    return image


def prepare_training_rois(
    path: Path,
    nd2_file: Path,
    filename: str,
    progress_callback: Any | None = None,
    niter: int = 500,
) -> dict[str, Any]:
    """Extract drift-corrected ROI images without running Cellpose."""

    try:
        import nd2
    except ImportError as exc:
        raise RuntimeError("The nd2 package is required for ROI preparation") from exc

    started = monotonic()
    config = _load_config()
    connection = sqlite3.connect(path)
    try:
        _create_tables(connection)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("DELETE FROM annotation_revisions")
        connection.execute("DELETE FROM training_annotations")
        connection.execute("DELETE FROM training_masks")
        connection.execute("DELETE FROM training_frames")
        connection.commit()

        with nd2.ND2File(nd2_file) as images:
            sizes = {str(axis): int(value) for axis, value in images.sizes.items()}
            timeframe_count = int(sizes.get("T", 1))
            field_count = int(sizes.get("P", 1))
            width = int(sizes.get("X", 0))
            height = int(sizes.get("Y", 0))
            frame_indices = _build_frame_index(images)
            configured: list[tuple[int, np.ndarray, list[Any], Any, str]] = []
            view_manifests: list[dict[str, Any]] = []
            total_frames = 0

            for view_index in range(field_count):
                reference = _read_frame(images, frame_indices, view_index, 0)
                loaded = load_view_config(config, view_index, reference.shape)
                if loaded is None:
                    view_manifests.append(
                        {
                            "view_index": view_index,
                            "configured": False,
                            "description": "No channel definition is configured for this field of view.",
                            "channels": [],
                        }
                    )
                    continue
                reference_channels, cell_filter, description = loaded
                configured.append(
                    (view_index, reference, reference_channels, cell_filter, description)
                )
                total_frames += len(reference_channels) * timeframe_count

            processed = 0
            order_base = 0
            for view_index, reference, reference_channels, _cell_filter, description in configured:
                reference_vertical_profile = vertical_edge_profile(reference)
                reference_horizontal_profile = wall_profile(reference)
                channel_manifests = [
                    {
                        "channel_id": channel.channel_id,
                        "reference_roi": {
                            "x0": channel.x0,
                            "y0": channel.y0,
                            "x1": channel.x1,
                            "y1": channel.y1,
                        },
                        "frame_cell_counts": [],
                    }
                    for channel in reference_channels
                ]
                for time_frame in range(timeframe_count):
                    if progress_callback is not None:
                        progress_callback(
                            {
                                "stage": "preparing_rois",
                                "message": (
                                    f"Extracting ROI images for field {view_index + 1}, "
                                    f"frame {time_frame + 1}"
                                ),
                                "processed_frames": processed,
                                "total_frames": total_frames,
                            }
                        )
                    image = reference if time_frame == 0 else _read_frame(
                        images, frame_indices, view_index, time_frame
                    )
                    max_drift = max(2, int(round(min(image.shape) * 60 / 2044)))
                    vertical_shift = best_profile_shift(
                        reference_vertical_profile,
                        vertical_edge_profile(image),
                        int(round(image.shape[0] * 200 / 2044)),
                        int(round(image.shape[0] * 1600 / 2044)),
                        max_drift,
                    )
                    horizontal_shift = best_profile_shift(
                        reference_horizontal_profile,
                        wall_profile(image, vertical_shift),
                        0,
                        image.shape[1],
                        max_drift,
                    )
                    channels = shifted_channels(
                        reference_channels, image.shape, horizontal_shift, vertical_shift
                    )
                    now = _now()
                    for channel_position, channel in enumerate(channels):
                        crop = image[channel.y0 : channel.y1, channel.x0 : channel.x1]
                        order_index = (
                            order_base
                            + channel_position * timeframe_count
                            + time_frame
                        )
                        connection.execute(
                            """
                            INSERT INTO training_frames(
                                view_index, roi_id, time_frame, order_index, width,
                                height, raw_image, status, revision, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
                            """,
                            (
                                view_index,
                                channel.channel_id,
                                time_frame,
                                order_index,
                                int(crop.shape[1]),
                                int(crop.shape[0]),
                                _encode_png(crop),
                                now,
                            ),
                        )
                        processed += 1
                    connection.commit()
                order_base += len(reference_channels) * timeframe_count
                view_manifests.append(
                    {
                        "view_index": view_index,
                        "configured": True,
                        "description": description,
                        "channels": channel_manifests,
                    }
                )

        if total_frames == 0:
            raise ValueError("No configured Mother Machine ROIs were found")
        now = _now()
        created = connection.execute(
            "SELECT created_at FROM training_dataset WHERE id = 1"
        ).fetchone()
        manifest = {
            "schema_version": TRAINING_SCHEMA_VERSION,
            "filename": filename,
            "database": path.name,
            "model": MODEL_NAME,
            "niter": niter,
            "field_count": field_count,
            "timeframe_count": timeframe_count,
            "image_width": width,
            "image_height": height,
            "configured_field_count": len(configured),
            "views": sorted(view_manifests, key=lambda item: item["view_index"]),
        }
        connection.execute(
            """
            INSERT INTO dataset_manifest(id, manifest_json) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json
            """,
            (json.dumps(manifest, ensure_ascii=False),),
        )
        connection.execute("DELETE FROM training_dataset")
        connection.execute(
            """
            INSERT INTO training_dataset(
                id, source_filename, status, current_order, total_frames,
                reviewed_count, model, niter, created_at, updated_at
            ) VALUES (1, ?, 'annotating', 0, ?, 0, ?, ?, ?, ?)
            """,
            (
                filename,
                total_frames,
                MODEL_NAME,
                niter,
                str(created[0]) if created else now,
                now,
            ),
        )
        _sync_manifest(connection)
        connection.commit()
        return {
            "filename": filename,
            "database": path.name,
            "field_count": field_count,
            "timeframe_count": timeframe_count,
            "configured_field_count": len(configured),
            "total_frames": total_frames,
            "elapsed_seconds": monotonic() - started,
        }
    finally:
        connection.close()


def _get_cellpose_model() -> Any:
    global _cellpose_model
    if _cellpose_model is None:
        try:
            from cellpose import models
        except ImportError as exc:
            raise RuntimeError("Cellpose is not installed") from exc
        _cellpose_model = models.CellposeModel(gpu=True, pretrained_model=MODEL_NAME)
    return _cellpose_model


def run_training_frame_inference(path: Path, frame_id: int) -> dict[str, Any]:
    """Run a fresh Cellpose inference for exactly one ROI image."""

    with _inference_lock:
        return _run_training_frame_inference_locked(path, frame_id)


def _run_training_frame_inference_locked(path: Path, frame_id: int) -> dict[str, Any]:

    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        frame = connection.execute(
            "SELECT * FROM training_frames WHERE id = ?", (frame_id,)
        ).fetchone()
        dataset = connection.execute(
            "SELECT niter FROM training_dataset WHERE id = 1"
        ).fetchone()
        manifest = load_dataset_manifest(path)
        if frame is None or dataset is None or manifest is None:
            raise HTTPException(status_code=404, detail="Training frame not found")
        connection.execute(
            "UPDATE training_frames SET status = 'inferring', error = NULL, updated_at = ? WHERE id = ?",
            (_now(), frame_id),
        )
        connection.commit()
        raw = _decode_png(bytes(frame["raw_image"]), cv2.IMREAD_GRAYSCALE)
        config = _load_config()
        loaded = load_view_config(
            config,
            int(frame["view_index"]),
            (int(manifest["image_height"]), int(manifest["image_width"])),
        )
        if loaded is None:
            raise ValueError("The frame's Mother Machine view is not configured")
        _channels, cell_filter, _description = loaded
        band_mask = _segment_band(_get_cellpose_model(), raw, niter=int(dataset["niter"]))
        local_channel = ChannelRoi(
            channel_id=int(frame["roi_id"]),
            x0=0,
            y0=0,
            x1=int(frame["width"]),
            y1=int(frame["height"]),
        )
        labels, _recovered = extract_channel_cells(
            band_mask, raw, 0, local_channel, cell_filter
        )
        labels = labels.astype(np.uint16)
        mask_png = _encode_png(labels)
        instances = _instances_from_labels(labels)
        next_revision = int(frame["revision"]) + 1
        now = _now()
        with connection:
            connection.execute(
                """
                INSERT INTO training_masks(frame_id, auto_mask, corrected_mask)
                VALUES (?, ?, NULL)
                ON CONFLICT(frame_id) DO UPDATE SET
                    auto_mask = excluded.auto_mask, corrected_mask = NULL
                """,
                (frame_id, mask_png),
            )
            connection.execute(
                "DELETE FROM training_annotations WHERE frame_id = ?", (frame_id,)
            )
            connection.executemany(
                "INSERT INTO training_annotations VALUES (?, ?, ?, ?)",
                [
                    (
                        frame_id,
                        item["id"],
                        item["display_order"],
                        json.dumps(item["points"], separators=(",", ":")),
                    )
                    for item in instances
                ],
            )
            connection.execute(
                """
                UPDATE training_frames SET status = 'draft', revision = ?,
                    error = NULL, updated_at = ? WHERE id = ?
                """,
                (next_revision, now, frame_id),
            )
            connection.execute(
                """
                INSERT INTO annotation_revisions(
                    frame_id, revision, status, instances_json, mask_png, created_at
                ) VALUES (?, ?, 'draft', ?, ?, ?)
                """,
                (frame_id, next_revision, json.dumps(instances), mask_png, now),
            )
            connection.execute(
                """
                UPDATE training_dataset SET
                    status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'annotating' END,
                    current_order = ?,
                    reviewed_count = (
                        SELECT COUNT(*) FROM training_frames WHERE status = 'reviewed'
                    ),
                    updated_at = ?, error = NULL WHERE id = 1
                """,
                (int(frame["order_index"]), now),
            )
            _sync_manifest(connection)
        return get_training_frame(path, frame_id) or {}
    except Exception as exc:
        connection.execute(
            "UPDATE training_frames SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
            (str(exc), _now(), frame_id),
        )
        connection.commit()
        raise
    finally:
        connection.close()


def _labels_from_overlay(raw_png: bytes, overlay_png: bytes) -> np.ndarray:
    raw = _decode_png(raw_png, cv2.IMREAD_GRAYSCALE)
    overlay = _decode_png(overlay_png, cv2.IMREAD_COLOR)
    if raw.shape != overlay.shape[:2]:
        raise ValueError("Raw and overlay dimensions differ")
    colored = (
        overlay.max(axis=2).astype(np.int16) - overlay.min(axis=2).astype(np.int16) > 18
    ).astype(np.uint8)
    count, components, stats, _ = cv2.connectedComponentsWithStats(colored, connectivity=8)
    component_ids = sorted(
        range(1, count),
        key=lambda value: (
            int(stats[value, cv2.CC_STAT_TOP]),
            int(stats[value, cv2.CC_STAT_LEFT]),
        ),
    )
    labels = np.zeros(raw.shape, dtype=np.uint16)
    for label, component_id in enumerate(component_ids, 1):
        labels[components == component_id] = label
    return labels


def _instances_from_labels(labels: np.ndarray) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for display_order, label in enumerate(np.unique(labels[labels > 0])):
        contours, _ = cv2.findContours(
            (labels == label).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea).reshape(-1, 2)
        if len(contour) < 3:
            continue
        result.append(
            {
                "id": uuid4().hex,
                "points": [[float(x), float(y)] for x, y in contour],
                "display_order": display_order,
            }
        )
    return result


def initialize_training_from_extraction(path: Path, filename: str) -> None:
    manifest = load_dataset_manifest(path)
    if manifest is None:
        raise ValueError("Extracted manifest is missing")
    connection = sqlite3.connect(path)
    try:
        _create_tables(connection)
        connection.execute("DELETE FROM annotation_revisions")
        connection.execute("DELETE FROM training_annotations")
        connection.execute("DELETE FROM training_masks")
        connection.execute("DELETE FROM training_frames")
        order_index = 0
        now = _now()
        for view in sorted(manifest.get("views", []), key=lambda item: item["view_index"]):
            if not view.get("configured"):
                continue
            for channel in sorted(view.get("channels", []), key=lambda item: item["channel_id"]):
                for time_frame in range(int(manifest.get("timeframe_count", 0))):
                    raw_png = query_review_image(
                        path, int(view["view_index"]), int(channel["channel_id"]), time_frame, "raw"
                    )
                    overlay_png = query_review_image(
                        path, int(view["view_index"]), int(channel["channel_id"]), time_frame, "overlay"
                    )
                    if raw_png is None or overlay_png is None:
                        continue
                    raw = _decode_png(raw_png, cv2.IMREAD_GRAYSCALE)
                    labels = _labels_from_overlay(raw_png, overlay_png)
                    cursor = connection.execute(
                        """
                        INSERT INTO training_frames(
                            view_index, roi_id, time_frame, order_index, width, height,
                            raw_image, status, revision, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?)
                        """,
                        (
                            int(view["view_index"]), int(channel["channel_id"]), time_frame,
                            order_index, int(raw.shape[1]), int(raw.shape[0]), raw_png, now,
                        ),
                    )
                    frame_id = int(cursor.lastrowid)
                    connection.execute(
                        "INSERT INTO training_masks(frame_id, auto_mask) VALUES (?, ?)",
                        (frame_id, _encode_png(labels)),
                    )
                    for instance in _instances_from_labels(labels):
                        connection.execute(
                            """
                            INSERT INTO training_annotations(
                                frame_id, instance_id, display_order, points_json
                            ) VALUES (?, ?, ?, ?)
                            """,
                            (
                                frame_id, instance["id"], instance["display_order"],
                                json.dumps(instance["points"], separators=(",", ":")),
                            ),
                        )
                    order_index += 1
        existing = connection.execute("SELECT created_at FROM training_dataset WHERE id = 1").fetchone()
        created_at = str(existing[0]) if existing else now
        connection.execute("DELETE FROM training_dataset")
        connection.execute(
            """
            INSERT INTO training_dataset(
                id, source_filename, status, current_order, total_frames,
                reviewed_count, model, niter, created_at, updated_at
            ) VALUES (1, ?, 'annotating', 0, ?, 0, ?, ?, ?, ?)
            """,
            (
                filename, order_index, str(manifest.get("model", "cpsam_v2")),
                int(manifest.get("niter", 500)), created_at, now,
            ),
        )
        _sync_manifest(connection)
        connection.commit()
    finally:
        connection.close()


def _dataset_row(path: Path) -> sqlite3.Row | None:
    if not path.is_file():
        return None
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        try:
            return connection.execute("SELECT * FROM training_dataset WHERE id = 1").fetchone()
        except sqlite3.OperationalError:
            return None
    finally:
        connection.close()


def training_summary(path: Path) -> dict[str, Any] | None:
    row = _dataset_row(path)
    if row is None:
        return None
    payload = dict(row)
    payload["filename"] = payload.pop("source_filename")
    payload["database"] = path.name
    total = int(payload["total_frames"])
    reviewed = int(payload["reviewed_count"])
    payload["progress_percent"] = round(reviewed * 100 / total) if total else 0
    return payload


def list_training_datasets(paths: Iterable[Path]) -> list[dict[str, Any]]:
    summaries = [summary for path in paths if (summary := training_summary(path)) is not None]
    return sorted(summaries, key=lambda item: str(item["updated_at"]), reverse=True)


def _frame_payload(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    annotations = connection.execute(
        """
        SELECT instance_id, display_order, points_json
        FROM training_annotations WHERE frame_id = ? ORDER BY display_order
        """,
        (row["id"],),
    ).fetchall()
    previous = connection.execute(
        "SELECT id FROM training_frames WHERE order_index < ? ORDER BY order_index DESC LIMIT 1",
        (row["order_index"],),
    ).fetchone()
    following = connection.execute(
        "SELECT id FROM training_frames WHERE order_index > ? ORDER BY order_index LIMIT 1",
        (row["order_index"],),
    ).fetchone()
    return {
        "id": int(row["id"]),
        "view_index": int(row["view_index"]),
        "roi_id": int(row["roi_id"]),
        "time_frame": int(row["time_frame"]),
        "order_index": int(row["order_index"]),
        "width": int(row["width"]),
        "height": int(row["height"]),
        "status": str(row["status"]),
        "revision": int(row["revision"]),
        "previous_frame_id": int(previous[0]) if previous else None,
        "next_frame_id": int(following[0]) if following else None,
        "instances": [
            {
                "id": item["instance_id"],
                "display_order": int(item["display_order"]),
                "points": json.loads(item["points_json"]),
            }
            for item in annotations
        ],
    }


def get_training_frame(path: Path, frame_id: int | None = None) -> dict[str, Any] | None:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        if frame_id is None:
            dataset = connection.execute(
                "SELECT current_order FROM training_dataset WHERE id = 1"
            ).fetchone()
            if dataset is None:
                return None
            row = connection.execute(
                "SELECT * FROM training_frames WHERE order_index = ?",
                (int(dataset["current_order"]),),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    "SELECT * FROM training_frames WHERE status != 'reviewed' ORDER BY order_index LIMIT 1"
                ).fetchone()
        else:
            row = connection.execute(
                "SELECT * FROM training_frames WHERE id = ?", (frame_id,)
            ).fetchone()
        return _frame_payload(connection, row) if row is not None else None
    finally:
        connection.close()


def get_frame_image(path: Path, frame_id: int, kind: str) -> bytes | None:
    connection = sqlite3.connect(path)
    try:
        if kind == "raw":
            row = connection.execute(
                "SELECT raw_image FROM training_frames WHERE id = ?", (frame_id,)
            ).fetchone()
        elif kind in {"auto", "corrected"}:
            column = "auto_mask" if kind == "auto" else "corrected_mask"
            row = connection.execute(
                f"SELECT {column} FROM training_masks WHERE frame_id = ?", (frame_id,)
            ).fetchone()
        else:
            raise ValueError("Unknown image kind")
        return bytes(row[0]) if row is not None and row[0] is not None else None
    finally:
        connection.close()


def reset_frame_to_auto(path: Path, frame_id: int) -> dict[str, Any]:
    labels_data = get_frame_image(path, frame_id, "auto")
    if labels_data is None:
        raise HTTPException(status_code=404, detail="Automatic mask not found")
    labels = _decode_png(labels_data)
    instances = _instances_from_labels(labels)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            row = connection.execute(
                "SELECT revision FROM training_frames WHERE id = ?", (frame_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Frame not found")
            connection.execute("DELETE FROM training_annotations WHERE frame_id = ?", (frame_id,))
            for item in instances:
                connection.execute(
                    "INSERT INTO training_annotations VALUES (?, ?, ?, ?)",
                    (frame_id, item["id"], item["display_order"], json.dumps(item["points"])),
                )
            connection.execute(
                "UPDATE training_frames SET status = 'draft', revision = revision + 1, updated_at = ? WHERE id = ?",
                (_now(), frame_id),
            )
            connection.execute(
                "UPDATE training_masks SET corrected_mask = NULL WHERE frame_id = ?",
                (frame_id,),
            )
            next_revision = int(row["revision"]) + 1
            connection.execute(
                """
                INSERT INTO annotation_revisions(
                    frame_id, revision, status, instances_json, mask_png, created_at
                ) VALUES (?, ?, 'draft', ?, ?, ?)
                """,
                (frame_id, next_revision, json.dumps(instances), labels_data, _now()),
            )
            reviewed = int(connection.execute(
                "SELECT COUNT(*) FROM training_frames WHERE status = 'reviewed'"
            ).fetchone()[0])
            order_row = connection.execute(
                "SELECT order_index FROM training_frames WHERE id = ?", (frame_id,)
            ).fetchone()
            connection.execute(
                """
                UPDATE training_dataset SET status = 'annotating', current_order = ?,
                    reviewed_count = ?, updated_at = ? WHERE id = 1
                """,
                (int(order_row[0]), reviewed, _now()),
            )
            _sync_manifest(connection)
        return get_training_frame(path, frame_id) or {}
    finally:
        connection.close()


def _orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_intersect(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], d: tuple[float, float]) -> bool:
    return (_orientation(a, b, c) * _orientation(a, b, d) < 0) and (
        _orientation(c, d, a) * _orientation(c, d, b) < 0
    )


def _validate_polygon(points: list[list[float]], width: int, height: int, instance_id: str) -> np.ndarray:
    if len(points) < 3:
        raise HTTPException(status_code=422, detail=f"Instance {instance_id} needs at least 3 points")
    normalized: list[tuple[float, float]] = []
    for point in points:
        if len(point) < 2 or not all(math.isfinite(float(value)) for value in point[:2]):
            raise HTTPException(status_code=422, detail=f"Instance {instance_id} has invalid coordinates")
        x, y = float(point[0]), float(point[1])
        if x < 0 or y < 0 or x >= width or y >= height:
            raise HTTPException(status_code=422, detail=f"Instance {instance_id} is outside the ROI")
        normalized.append((x, y))
    count = len(normalized)
    for first in range(count):
        a, b = normalized[first], normalized[(first + 1) % count]
        for second in range(first + 1, count):
            if second in {first, (first + 1) % count} or (second + 1) % count == first:
                continue
            c, d = normalized[second], normalized[(second + 1) % count]
            if _segments_intersect(a, b, c, d):
                raise HTTPException(status_code=422, detail=f"Instance {instance_id} self-intersects")
    contour = np.rint(np.asarray(normalized, dtype=np.float32)).astype(np.int32)
    if abs(float(cv2.contourArea(contour))) < 1:
        raise HTTPException(status_code=422, detail=f"Instance {instance_id} has zero area")
    return contour


def save_annotation(
    path: Path,
    frame_id: int,
    base_revision: int,
    status: str,
    instances: list[dict[str, Any]],
) -> dict[str, Any]:
    if status not in {"draft", "reviewed"}:
        raise HTTPException(status_code=422, detail="Status must be draft or reviewed")
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute("SELECT * FROM training_frames WHERE id = ?", (frame_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Frame not found")
        if int(row["revision"]) != base_revision:
            raise HTTPException(status_code=409, detail="Annotation was changed in another tab")
        mask = np.zeros((int(row["height"]), int(row["width"])), dtype=np.uint16)
        cleaned: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for display_order, instance in enumerate(instances):
            instance_id = str(instance.get("id") or uuid4().hex)
            if instance_id in seen_ids:
                raise HTTPException(status_code=422, detail=f"Duplicate instance id {instance_id}")
            seen_ids.add(instance_id)
            points = instance.get("points")
            if not isinstance(points, list):
                raise HTTPException(status_code=422, detail=f"Instance {instance_id} has no points")
            contour = _validate_polygon(points, int(row["width"]), int(row["height"]), instance_id)
            candidate = np.zeros(mask.shape, dtype=np.uint8)
            cv2.fillPoly(candidate, [contour], 1)
            if np.any((mask > 0) & (candidate > 0)):
                raise HTTPException(status_code=422, detail=f"Instance {instance_id} overlaps another cell")
            mask[candidate > 0] = display_order + 1
            cleaned.append({"id": instance_id, "points": points, "display_order": display_order})
        next_revision = base_revision + 1
        mask_png = _encode_png(mask)
        now = _now()
        with connection:
            connection.execute("DELETE FROM training_annotations WHERE frame_id = ?", (frame_id,))
            connection.executemany(
                "INSERT INTO training_annotations VALUES (?, ?, ?, ?)",
                [
                    (frame_id, item["id"], item["display_order"], json.dumps(item["points"], separators=(",", ":")))
                    for item in cleaned
                ],
            )
            connection.execute(
                "UPDATE training_masks SET corrected_mask = ? WHERE frame_id = ?",
                (mask_png, frame_id),
            )
            connection.execute(
                """
                UPDATE training_frames SET status = ?, revision = ?, updated_at = ?, error = NULL
                WHERE id = ?
                """,
                (status, next_revision, now, frame_id),
            )
            connection.execute(
                """
                INSERT INTO annotation_revisions(
                    frame_id, revision, status, instances_json, mask_png, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (frame_id, next_revision, status, json.dumps(cleaned), mask_png, now),
            )
            reviewed = int(connection.execute(
                "SELECT COUNT(*) FROM training_frames WHERE status = 'reviewed'"
            ).fetchone()[0])
            total = int(connection.execute("SELECT COUNT(*) FROM training_frames").fetchone()[0])
            next_row = connection.execute(
                "SELECT order_index FROM training_frames WHERE status != 'reviewed' ORDER BY order_index LIMIT 1"
            ).fetchone()
            current_order = int(next_row[0]) if next_row else max(total - 1, 0)
            dataset_status = "completed" if total > 0 and reviewed == total else "annotating"
            connection.execute(
                """
                UPDATE training_dataset SET status = ?, current_order = ?, reviewed_count = ?,
                    total_frames = ?, updated_at = ?, error = NULL WHERE id = 1
                """,
                (dataset_status, current_order, reviewed, total, now),
            )
            _sync_manifest(connection)
        return get_training_frame(path, frame_id) or {}
    finally:
        connection.close()
