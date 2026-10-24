from __future__ import annotations

import sqlite3
import tempfile
import unittest
import pickle
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

from app.bulk_engine.crud import (
    _calc_cell_length_px,
    get_cell_areas_by_label,
    get_cell_lengths_by_label,
)
from app.bulk_engine.heatmap_bulk_core import (
    build_heatmap_vectors_csv,
    calculate_cell_width_metrics,
)
from app.cellextraction.crud import create_database
from app.database_manager.crud import (
    DATABASES_DIR,
    _scale_bar_length_px,
    migrate_database,
)
from app.graphengine.crud import GraphEngineCrud


class ObjectiveScaleSupportTest(unittest.TestCase):
    def tearDown(self) -> None:
        for path in DATABASES_DIR.glob("objective-scale-test-*.db*"):
            path.unlink(missing_ok=True)

    def test_migration_adds_objective_columns_and_backfills_100x(self):
        db_name = f"objective-scale-test-{uuid4().hex}.db"
        db_path = DATABASES_DIR / db_name
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "CREATE TABLE cells (id INTEGER PRIMARY KEY, cell_id VARCHAR)"
            )
            conn.execute("INSERT INTO cells (cell_id) VALUES ('F0C0')")

        migrate_database(db_name)

        with sqlite3.connect(db_path) as conn:
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(cells)").fetchall()
            }
            row = conn.execute(
                "SELECT objective_magnification, pixel_size_um FROM cells"
            ).fetchone()

        self.assertIn("objective_magnification", columns)
        self.assertIn("pixel_size_um", columns)
        self.assertEqual(row[0], "100x")
        self.assertAlmostEqual(float(row[1]), 0.065)

    def test_new_database_schema_includes_objective_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "new-schema.db"
            engine = create_database(str(db_path))
            engine.dispose()

            with sqlite3.connect(db_path) as conn:
                columns = {
                    row[1]
                    for row in conn.execute("PRAGMA table_info(cells)").fetchall()
                }

        self.assertIn("objective_magnification", columns)
        self.assertIn("pixel_size_um", columns)

    def test_cell_length_is_in_pixels_with_or_without_image(self):
        contour = np.array(
            [[[0, 0]], [[10, 0]], [[10, 4]], [[0, 4]]], dtype=np.int32
        )
        contour_blob = pickle.dumps(contour)
        success, encoded_image = cv2.imencode(".png", np.zeros((5, 11), dtype=np.uint8))
        self.assertTrue(success)

        self.assertAlmostEqual(
            _calc_cell_length_px(None, contour_blob),
            10.0,
        )
        self.assertAlmostEqual(
            _calc_cell_length_px(encoded_image.tobytes(), contour_blob),
            10.0,
        )

    def test_exported_lengths_and_areas_use_pixel_units_for_any_objective(self):
        db_name = f"objective-scale-test-{uuid4().hex}.db"
        db_path = DATABASES_DIR / db_name
        engine = create_database(str(db_path))
        engine.dispose()
        contour = np.array(
            [[[0, 0]], [[10, 0]], [[10, 4]], [[0, 4]]], dtype=np.int32
        )
        contour_blob = pickle.dumps(contour)
        with sqlite3.connect(db_path) as conn:
            conn.executemany(
                "INSERT INTO cells (cell_id, contour, area, manual_label, pixel_size_um) "
                "VALUES (?, ?, ?, ?, ?)",
                [
                    ("F0C0", contour_blob, 40.0, 1, 0.065),
                    ("F0C1", contour_blob, 40.0, 1, 0.108),
                ],
            )

        self.assertEqual(
            get_cell_lengths_by_label(db_name, label="1"),
            [("F0C0", 10.0), ("F0C1", 10.0)],
        )
        self.assertEqual(
            get_cell_areas_by_label(db_name, label="1"),
            [("F0C0", 40.0), ("F0C1", 40.0)],
        )

    def test_scale_bar_length_uses_pixel_size_um(self):
        self.assertEqual(_scale_bar_length_px(0.065, image_width=200), 76)
        self.assertEqual(_scale_bar_length_px(0.108, image_width=200), 46)

    def test_heatmap_csv_metadata_drives_graph_engine_length(self):
        paths = [[(float(index), float(index + 1)) for index in range(35)]]
        csv_with_metadata = build_heatmap_vectors_csv(paths, pixel_size_um=0.108)
        old_csv = build_heatmap_vectors_csv(paths)

        mean_length, _ = GraphEngineCrud._analyze_csv(
            csv_with_metadata.decode("utf-8"),
            ctrl=None,
        )
        old_mean_length, _ = GraphEngineCrud._analyze_csv(
            old_csv.decode("utf-8"),
            ctrl=None,
        )

        self.assertAlmostEqual(mean_length, 3.67)
        self.assertAlmostEqual(old_mean_length, 2.21)

    def test_cell_width_metrics_return_full_width_from_centerline_distances(self):
        contour = np.array(
            [[[0, 0]], [[10, 0]], [[10, 4]], [[0, 4]]],
            dtype=np.int32,
        )
        contour_blob = pickle.dumps(contour)

        mean_width, median_width = calculate_cell_width_metrics(contour_blob, degree=1)

        self.assertAlmostEqual(mean_width, 4.0)
        self.assertAlmostEqual(median_width, 4.0)


if __name__ == "__main__":
    unittest.main()
