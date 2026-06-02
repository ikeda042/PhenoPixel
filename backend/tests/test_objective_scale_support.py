from __future__ import annotations

import sqlite3
import tempfile
import unittest
import pickle
import shutil
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np

from app.bulk_engine.crud import _calc_cell_length_um
from app.bulk_engine.heatmap_bulk_core import build_heatmap_vectors_csv
from app.cellextraction.crud import (
    ExtractionCrudBase,
    SyncChores,
    _get_temp_dir,
    create_database,
)
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
                "SELECT objective_magnification, pixel_size_um, position_x, position_y "
                "FROM cells"
            ).fetchone()

        self.assertIn("objective_magnification", columns)
        self.assertIn("pixel_size_um", columns)
        self.assertIn("position_x", columns)
        self.assertIn("position_y", columns)
        self.assertEqual(row[0], "100x")
        self.assertAlmostEqual(float(row[1]), 0.065)
        self.assertIsNone(row[2])
        self.assertIsNone(row[3])

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
        self.assertIn("position_x", columns)
        self.assertIn("position_y", columns)

    def test_extracted_cell_records_original_nd2_position(self):
        ulid = f"position-test-{uuid4().hex}"
        temp_dir = Path(_get_temp_dir(ulid))
        with tempfile.TemporaryDirectory() as contour_tmp:
            try:
                ph_dir = temp_dir / "PH"
                ph_dir.mkdir(parents=True, exist_ok=True)
                image = np.zeros((2048, 2048), dtype=np.uint8)
                cv2.rectangle(image, (670, 770), (731, 831), 255, -1)
                self.assertTrue(cv2.imwrite(str(ph_dir / "0.tif"), image))

                SyncChores.init(
                    "position-test.nd2",
                    1,
                    ulid,
                    param1=130,
                    image_size=200,
                    mode="single_layer",
                    contour_dir=str(Path(contour_tmp) / "contours"),
                )

                extractor = ExtractionCrudBase(
                    nd2_path="position-test.nd2",
                    mode="single_layer",
                    param1=130,
                    image_size=200,
                )
                extractor.ulid = ulid
                extractor.temp_dir = str(temp_dir)

                cell = extractor.process_cell(0, 0)
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        self.assertIsNotNone(cell)
        assert cell is not None
        self.assertAlmostEqual(float(cell.position_x), 700.0)
        self.assertAlmostEqual(float(cell.position_y), 800.0)
        self.assertAlmostEqual(float(cell.center_x), 100.0, delta=2.0)
        self.assertAlmostEqual(float(cell.center_y), 100.0, delta=2.0)

    def test_cell_length_uses_supplied_pixel_size_um(self):
        contour = np.array([[[0, 0]], [[10, 0]]], dtype=np.int32)
        contour_blob = pickle.dumps(contour)

        self.assertAlmostEqual(
            _calc_cell_length_um(None, contour_blob, 0.065),
            0.65,
        )
        self.assertAlmostEqual(
            _calc_cell_length_um(None, contour_blob, 0.108),
            1.08,
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


if __name__ == "__main__":
    unittest.main()
