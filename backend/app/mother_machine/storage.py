from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.mother_machine.database import (
    count_review_images,
    load_dataset_manifest,
    query_review_image,
    store_dataset_assets,
)


APP_DIR = Path(__file__).resolve().parents[1]
ND2_DIR = APP_DIR / "mother-machine-nd2files"
DATABASES_DIR = APP_DIR / "mother-machine-databases"
RESULTS_DIR = APP_DIR / "mother-machine-results"


def ensure_directories() -> None:
    for directory in (ND2_DIR, DATABASES_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def sanitize_nd2_filename(filename: str) -> str:
    cleaned = Path(filename or "").name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Filename is required")
    stem, suffix = Path(cleaned).stem, Path(cleaned).suffix
    if not stem:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if suffix.lower() != ".nd2":
        raise HTTPException(status_code=400, detail="Only .nd2 files are supported")
    return f"{stem.replace('.', 'p')}.nd2"


def dataset_key(filename: str) -> str:
    sanitized = sanitize_nd2_filename(filename)
    stem = Path(sanitized).stem
    key = re.sub(r"[^\w\-]+", "_", stem, flags=re.UNICODE).strip("_")
    if not key:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return key


def nd2_path(filename: str) -> Path:
    ensure_directories()
    return ND2_DIR / sanitize_nd2_filename(filename)


def database_path(filename: str) -> Path:
    ensure_directories()
    return DATABASES_DIR / f"{dataset_key(filename)}.db"


def result_path(filename: str) -> Path:
    ensure_directories()
    return RESULTS_DIR / dataset_key(filename)


def manifest_path(filename: str) -> Path:
    return result_path(filename) / "manifest.json"


def load_manifest(filename: str) -> dict[str, Any] | None:
    db_path = database_path(filename)
    embedded = load_dataset_manifest(db_path)
    if embedded is not None:
        return embedded

    legacy_manifest = manifest_path(filename)
    if not legacy_manifest.is_file() or not db_path.is_file():
        return None
    manifest = {
        **json.loads(legacy_manifest.read_text(encoding="utf-8")),
        "schema_version": 2,
    }
    legacy_results = result_path(filename)
    legacy_image_paths: list[tuple[int, int, int, str, Path]] = []
    for view in manifest.get("views", []):
        view_index = int(view.get("view_index", -1))
        for channel in view.get("channels", []):
            roi_id = int(channel.get("channel_id", -1))
            for mode in ("raw", "overlay"):
                image_dir = (
                    legacy_results
                    / "views"
                    / str(view_index)
                    / "channels"
                    / str(roi_id)
                    / mode
                )
                for image_path in sorted(
                    image_dir.glob("*.png"),
                    key=lambda item: int(item.stem),
                ):
                    legacy_image_paths.append(
                        (view_index, roi_id, int(image_path.stem), mode, image_path)
                    )

    try:
        store_dataset_assets(
            db_path,
            manifest,
            (
                (view_index, roi_id, frame, mode, image_path.read_bytes())
                for view_index, roi_id, frame, mode, image_path in legacy_image_paths
            ),
        )
        embedded = load_dataset_manifest(db_path)
        if (
            embedded is not None
            and count_review_images(db_path) == len(legacy_image_paths)
        ):
            shutil.rmtree(legacy_results)
            return embedded
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError):
        pass
    return manifest


def load_review_image(
    filename: str,
    view_index: int,
    roi_id: int,
    time_frame: int,
    mode: str,
) -> bytes | None:
    embedded = query_review_image(
        database_path(filename), view_index, roi_id, time_frame, mode
    )
    if embedded is not None:
        return embedded
    legacy_path = (
        result_path(filename)
        / "views"
        / str(view_index)
        / "channels"
        / str(roi_id)
        / mode
        / f"{time_frame}.png"
    )
    return legacy_path.read_bytes() if legacy_path.is_file() else None


def remove_dataset(filename: str) -> None:
    db_path = database_path(filename)
    results = result_path(filename)
    if db_path.is_file():
        db_path.unlink()
    if results.is_dir():
        shutil.rmtree(results)


def replace_dataset(
    filename: str,
    temporary_database: Path,
) -> None:
    final_database = database_path(filename)
    os.replace(temporary_database, final_database)
    shutil.rmtree(result_path(filename), ignore_errors=True)
