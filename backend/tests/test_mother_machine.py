from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from app.mother_machine.database import (
    create_cells_database,
    load_dataset_manifest,
    query_cells,
    query_review_image,
)
from app.mother_machine.processor import (
    CONFIG_PATH,
    CellFilter,
    ChannelRoi,
    _segment_band,
    extract_channel_cells,
    load_view_config,
)
from app.mother_machine.storage import dataset_key, sanitize_nd2_filename
from app.mother_machine import storage


class MotherMachineConfigTest(unittest.TestCase):
    def test_sample_channel_config_contains_the_three_poc_views(self):
        payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        expected_counts = {1: 13, 2: 10, 3: 12}
        for view_index, expected_count in expected_counts.items():
            loaded = load_view_config(payload, view_index, (2044, 2048))
            self.assertIsNotNone(loaded)
            channels, _cell_filter, _description = loaded
            self.assertEqual(len(channels), expected_count)

    def test_filename_is_scoped_to_one_dataset_key(self):
        self.assertEqual(sanitize_nd2_filename("folder/sample.v1.nd2"), "samplepv1.nd2")
        self.assertEqual(dataset_key("sample.v1.nd2"), "samplepv1")


class MotherMachineSegmentationTest(unittest.TestCase):
    def test_segment_band_uses_cellpose4_arguments(self):
        class FakeCellposeModel:
            def __init__(self):
                self.kwargs = None

            def eval(self, image, **kwargs):
                self.kwargs = kwargs
                return np.ones(image.shape, dtype=np.uint16), [], []

        model = FakeCellposeModel()
        band = np.zeros((32, 48), dtype=np.uint8)

        mask = _segment_band(model, band, niter=275)

        self.assertEqual(mask.dtype, np.int32)
        self.assertEqual(mask.shape, band.shape)
        self.assertEqual(model.kwargs["cellprob_threshold"], 0.0)
        self.assertEqual(model.kwargs["niter"], 275)
        self.assertNotIn("omni", model.kwargs)
        self.assertNotIn("mask_threshold", model.kwargs)

    def test_channel_filter_keeps_a_dark_elongated_cell(self):
        image = np.full((64, 64), 220, dtype=np.uint8)
        band_mask = np.zeros((64, 64), dtype=np.int32)
        band_mask[10:40, 20:30] = 1
        image[10:40, 20:30] = 50
        labels, recovered = extract_channel_cells(
            band_mask,
            image,
            0,
            ChannelRoi(channel_id=1, x0=0, y0=0, x1=64, y1=64),
            CellFilter(),
        )
        self.assertEqual(int(labels.max()), 1)
        self.assertEqual(int(np.count_nonzero(labels)), 300)
        self.assertEqual(recovered, set())


class MotherMachineDatabaseTest(unittest.TestCase):
    def test_one_cell_instance_is_stored_as_one_indexed_record(self):
        row = {
            "view_index": 2,
            "roi_id": 4,
            "time_frame": 7,
            "label_id": 3,
            "local_label_id": 1,
            "area_px": 320,
            "centroid_x": 12.5,
            "centroid_y": 22.5,
            "bbox_x0": 8,
            "bbox_y0": 10,
            "bbox_x1": 18,
            "bbox_y1": 42,
            "temporal_recovery": 0,
            "mean_intensity": 82.25,
            "contour_json": "[[8,10],[18,10],[18,42],[8,42]]",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample.db"
            create_cells_database(path, "sample.nd2", [row], {"field_count": 8})
            cells = query_cells(path, 2, 4, 7)
            self.assertEqual(len(cells), 1)
            self.assertEqual(cells[0]["area_px"], 320)
            self.assertEqual(cells[0]["contour"][0], [8, 10])
            with sqlite3.connect(path) as connection:
                indexes = {
                    record[1]
                    for record in connection.execute("PRAGMA index_list(cells)").fetchall()
                }
            self.assertIn("idx_cells_view_roi_frame", indexes)

    def test_manifest_and_review_images_are_embedded_in_database(self):
        manifest = {
            "schema_version": 2,
            "filename": "sample.nd2",
            "views": [],
        }
        png_data = b"\x89PNG\r\n\x1a\nembedded-review-image"
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample.db"
            create_cells_database(
                path,
                "sample.nd2",
                [],
                {"field_count": 1},
                manifest=manifest,
                review_images=[(0, 1, 2, "overlay", png_data)],
            )

            self.assertEqual(load_dataset_manifest(path), manifest)
            self.assertEqual(query_review_image(path, 0, 1, 2, "overlay"), png_data)
            self.assertIsNone(query_review_image(path, 0, 1, 2, "raw"))
            self.assertFalse(path.with_name(f"{path.name}-wal").exists())

    def test_legacy_result_folder_is_migrated_into_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            nd2_dir = root / "nd2"
            databases_dir = root / "databases"
            results_dir = root / "results"
            nd2_dir.mkdir()
            databases_dir.mkdir()
            results_dir.mkdir()
            with (
                patch.object(storage, "ND2_DIR", nd2_dir),
                patch.object(storage, "DATABASES_DIR", databases_dir),
                patch.object(storage, "RESULTS_DIR", results_dir),
            ):
                db_path = storage.database_path("sample.nd2")
                create_cells_database(db_path, "sample.nd2", [], {})
                legacy_root = storage.result_path("sample.nd2")
                image_dir = legacy_root / "views" / "0" / "channels" / "1" / "raw"
                image_dir.mkdir(parents=True)
                png_data = b"\x89PNG\r\n\x1a\nlegacy-review-image"
                (image_dir / "0.png").write_bytes(png_data)
                manifest = {
                    "schema_version": 1,
                    "filename": "sample.nd2",
                    "views": [
                        {
                            "view_index": 0,
                            "channels": [{"channel_id": 1}],
                        }
                    ],
                }
                (legacy_root / "manifest.json").write_text(
                    json.dumps(manifest), encoding="utf-8"
                )

                migrated = storage.load_manifest("sample.nd2")

                self.assertEqual(migrated["schema_version"], 2)
                self.assertFalse(legacy_root.exists())
                self.assertEqual(
                    query_review_image(db_path, 0, 1, 0, "raw"), png_data
                )


if __name__ == "__main__":
    unittest.main()
