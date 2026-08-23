from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable


CELL_COLUMNS = (
    "view_index",
    "roi_id",
    "time_frame",
    "label_id",
    "local_label_id",
    "area_px",
    "centroid_x",
    "centroid_y",
    "bbox_x0",
    "bbox_y0",
    "bbox_x1",
    "bbox_y1",
    "temporal_recovery",
    "mean_intensity",
    "contour_json",
)

ReviewImageRow = tuple[int, int, int, str, bytes]


def _create_asset_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS dataset_manifest (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            manifest_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_images (
            view_index INTEGER NOT NULL,
            roi_id INTEGER NOT NULL,
            time_frame INTEGER NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('raw', 'overlay')),
            mime_type TEXT NOT NULL DEFAULT 'image/png',
            image_data BLOB NOT NULL,
            PRIMARY KEY (view_index, roi_id, time_frame, mode)
        );
        CREATE INDEX IF NOT EXISTS idx_review_images_frame
            ON review_images(view_index, roi_id, time_frame);
        """
    )


def create_cells_database(
    path: Path,
    filename: str,
    rows: Iterable[dict[str, Any]],
    metadata: dict[str, Any],
    manifest: dict[str, Any] | None = None,
    review_images: Iterable[ReviewImageRow] = (),
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=DELETE;
            PRAGMA foreign_keys=ON;
            CREATE TABLE extraction_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE cells (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_filename TEXT NOT NULL,
                view_index INTEGER NOT NULL,
                roi_id INTEGER NOT NULL,
                time_frame INTEGER NOT NULL,
                label_id INTEGER NOT NULL,
                local_label_id INTEGER NOT NULL,
                area_px INTEGER NOT NULL,
                centroid_x REAL NOT NULL,
                centroid_y REAL NOT NULL,
                bbox_x0 INTEGER NOT NULL,
                bbox_y0 INTEGER NOT NULL,
                bbox_x1 INTEGER NOT NULL,
                bbox_y1 INTEGER NOT NULL,
                temporal_recovery INTEGER NOT NULL DEFAULT 0,
                mean_intensity REAL NOT NULL,
                contour_json TEXT NOT NULL,
                UNIQUE(view_index, roi_id, time_frame, local_label_id)
            );
            CREATE INDEX idx_cells_view_roi_frame
                ON cells(view_index, roi_id, time_frame);
            CREATE INDEX idx_cells_frame
                ON cells(time_frame);
            """
        )
        _create_asset_tables(connection)
        metadata_rows = {
            "schema_version": 2,
            "source_filename": filename,
            **metadata,
        }
        connection.executemany(
            "INSERT INTO extraction_metadata(key, value) VALUES (?, ?)",
            [
                (str(key), json.dumps(value, ensure_ascii=False))
                for key, value in metadata_rows.items()
            ],
        )
        placeholders = ", ".join("?" for _ in CELL_COLUMNS)
        columns = ", ".join(CELL_COLUMNS)
        sql = (
            f"INSERT INTO cells(source_filename, {columns}) "
            f"VALUES (?, {placeholders})"
        )
        connection.executemany(
            sql,
            [
                (filename, *(row[column] for column in CELL_COLUMNS))
                for row in rows
            ],
        )
        if manifest is not None:
            connection.execute(
                "INSERT INTO dataset_manifest(id, manifest_json) VALUES (1, ?)",
                (json.dumps(manifest, ensure_ascii=False),),
            )
        connection.executemany(
            """
            INSERT INTO review_images(
                view_index, roi_id, time_frame, mode, image_data
            ) VALUES (?, ?, ?, ?, ?)
            """,
            review_images,
        )
        connection.commit()
    finally:
        connection.close()


def store_dataset_assets(
    path: Path,
    manifest: dict[str, Any],
    review_images: Iterable[ReviewImageRow],
) -> None:
    """Upgrade a legacy cells DB by embedding its manifest and review PNGs."""

    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        _create_asset_tables(connection)
        connection.execute(
            """
            INSERT INTO dataset_manifest(id, manifest_json) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json
            """,
            (json.dumps(manifest, ensure_ascii=False),),
        )
        connection.execute("DELETE FROM review_images")
        connection.executemany(
            """
            INSERT INTO review_images(
                view_index, roi_id, time_frame, mode, image_data
            ) VALUES (?, ?, ?, ?, ?)
            """,
            review_images,
        )
        connection.execute(
            """
            INSERT INTO extraction_metadata(key, value) VALUES ('schema_version', '2')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """
        )
        connection.commit()
    finally:
        connection.close()


def load_dataset_manifest(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    connection = sqlite3.connect(path)
    try:
        try:
            record = connection.execute(
                "SELECT manifest_json FROM dataset_manifest WHERE id = 1"
            ).fetchone()
        except sqlite3.OperationalError:
            return None
    finally:
        connection.close()
    if record is None:
        return None
    return json.loads(record[0])


def query_review_image(
    path: Path,
    view_index: int,
    roi_id: int,
    time_frame: int,
    mode: str,
) -> bytes | None:
    if not path.is_file():
        return None
    connection = sqlite3.connect(path)
    try:
        try:
            record = connection.execute(
                """
                SELECT image_data
                FROM review_images
                WHERE view_index = ? AND roi_id = ? AND time_frame = ? AND mode = ?
                """,
                (view_index, roi_id, time_frame, mode),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
    finally:
        connection.close()
    return bytes(record[0]) if record is not None else None


def count_review_images(path: Path) -> int:
    if not path.is_file():
        return 0
    connection = sqlite3.connect(path)
    try:
        try:
            record = connection.execute(
                "SELECT COUNT(*) FROM review_images"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
    finally:
        connection.close()
    return int(record[0]) if record is not None else 0


def query_cells(
    path: Path,
    view_index: int,
    roi_id: int,
    time_frame: int,
) -> list[dict[str, Any]]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        records = connection.execute(
            """
            SELECT id, source_filename, view_index, roi_id, time_frame,
                   label_id, local_label_id, area_px, centroid_x, centroid_y,
                   bbox_x0, bbox_y0, bbox_x1, bbox_y1, temporal_recovery,
                   mean_intensity, contour_json
            FROM cells
            WHERE view_index = ? AND roi_id = ? AND time_frame = ?
            ORDER BY local_label_id
            """,
            (view_index, roi_id, time_frame),
        ).fetchall()
    finally:
        connection.close()
    result: list[dict[str, Any]] = []
    for record in records:
        item = dict(record)
        item["temporal_recovery"] = bool(item["temporal_recovery"])
        item["contour"] = json.loads(item.pop("contour_json"))
        result.append(item)
    return result
