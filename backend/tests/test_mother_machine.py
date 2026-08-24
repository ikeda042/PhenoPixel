from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException
from PIL import Image

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
    make_channel_overlay,
)
from app.mother_machine.router import (
    _contours_from_overlay,
    _densify_contour,
    _encode_gif,
    _stitch_frames,
    render_contour_plot,
)
from app.mother_machine.storage import (
    dataset_key,
    list_databases,
    sanitize_database_name,
    sanitize_nd2_filename,
)
from app.mother_machine import storage, training
from app.mother_machine.training import (
    get_frame_image,
    get_training_frame,
    initialize_training_from_extraction,
    save_annotation,
    training_summary,
)


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
    def test_overlay_uses_a_different_color_for_each_cell(self):
        image = np.full((24, 24), 100, dtype=np.uint8)
        labels = np.zeros((24, 24), dtype=np.int32)
        labels[3:10, 3:10] = 1
        labels[14:21, 14:21] = 2

        overlay = make_channel_overlay(image, labels)

        self.assertFalse(np.array_equal(overlay[6, 6], overlay[17, 17]))
        self.assertTrue(np.array_equal(overlay[0, 0], [100, 100, 100]))

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
    def test_aligned_image_stitches_frames_in_time_order(self):
        frames: list[bytes] = []
        for color in ((10, 20, 30), (100, 110, 120), (200, 210, 220)):
            image = np.full((4, 3, 3), color, dtype=np.uint8)
            ok, encoded = cv2.imencode(".png", image)
            self.assertTrue(ok)
            frames.append(encoded.tobytes())

        stitched = _stitch_frames(frames)

        with Image.open(BytesIO(stitched)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (9, 4))
            self.assertNotEqual(image.getpixel((1, 1)), image.getpixel((7, 1)))

    def test_gif_encoder_preserves_frame_order(self):
        frames: list[bytes] = []
        for value in (20, 220):
            image = np.full((8, 8, 3), value, dtype=np.uint8)
            ok, encoded = cv2.imencode(".png", image)
            self.assertTrue(ok)
            frames.append(encoded.tobytes())

        gif = _encode_gif(frames)

        with Image.open(BytesIO(gif)) as animation:
            self.assertEqual(animation.format, "GIF")
            self.assertEqual(animation.n_frames, 2)
            animation.seek(0)
            first_value = animation.convert("RGB").getpixel((0, 0))[0]
            animation.seek(1)
            second_value = animation.convert("RGB").getpixel((0, 0))[0]
        self.assertLess(first_value, second_value)

    def test_overlay_contours_use_roi_local_coordinates(self):
        overlay = np.full((32, 16, 3), 80, dtype=np.uint8)
        overlay[8:24, 4:12] = (40, 210, 60)
        ok, encoded = cv2.imencode(".png", overlay)
        self.assertTrue(ok)

        contours = _contours_from_overlay(encoded.tobytes())

        self.assertEqual(len(contours), 1)
        xs = [point[0] for point in contours[0]]
        ys = [point[1] for point in contours[0]]
        self.assertEqual((min(xs), max(xs)), (4.0, 11.0))
        self.assertEqual((min(ys), max(ys)), (8.0, 23.0))

    def test_sparse_contour_is_densified_to_pixel_spacing(self):
        points = [[4, 8], [12, 8], [12, 24], [4, 24]]

        dense = _densify_contour(points)

        self.assertEqual(len(dense), 48)
        self.assertIn((8.0, 8.0), dense)
        self.assertIn((12.0, 16.0), dense)

    def test_contour_plot_is_a_square_png(self):
        png = render_contour_plot(
            [{"contour": [[4, 8], [12, 8], [12, 24], [4, 24]]}],
            (0, 0, 16, 32),
        )

        with Image.open(BytesIO(png)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (600, 600))

    def test_database_manager_lists_reviewable_extractions(self):
        manifest = {
            "schema_version": 2,
            "filename": "sample.nd2",
            "views": [],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            databases_dir = Path(temp_dir)
            with patch.object(storage, "DATABASES_DIR", databases_dir):
                create_cells_database(
                    databases_dir / "sample.db",
                    "sample.nd2",
                    [],
                    {},
                    manifest=manifest,
                )

                databases = list_databases()

        self.assertEqual(len(databases), 1)
        self.assertEqual(databases[0]["name"], "sample.db")
        self.assertEqual(databases[0]["source_filename"], "sample.nd2")
        self.assertEqual(databases[0]["review_filename"], "sample.nd2")
        self.assertGreater(databases[0]["size_bytes"], 0)

    def test_database_name_rejects_paths_and_non_sqlite_files(self):
        self.assertEqual(sanitize_database_name("sample.db"), "sample.db")
        with self.assertRaises(HTTPException):
            sanitize_database_name("../sample.db")
        with self.assertRaises(HTTPException):
            sanitize_database_name("sample.nd2")

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


class MotherMachineTrainingDatasetTest(unittest.TestCase):
    def _make_extracted_database(self, path: Path) -> None:
        raw = np.full((32, 16), 90, dtype=np.uint8)
        labels = np.zeros((32, 16), dtype=np.uint16)
        labels[4:14, 4:11] = 1
        overlay = make_channel_overlay(raw, labels)
        raw_ok, raw_png = cv2.imencode(".png", raw)
        overlay_ok, overlay_png = cv2.imencode(
            ".png", cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)
        )
        self.assertTrue(raw_ok and overlay_ok)
        manifest = {
            "schema_version": 2,
            "filename": "training.nd2",
            "model": "cpsam_v2",
            "niter": 500,
            "timeframe_count": 1,
            "views": [
                {
                    "view_index": 0,
                    "configured": True,
                    "channels": [{"channel_id": 1, "frame_cell_counts": [1]}],
                }
            ],
        }
        create_cells_database(
            path,
            "training.nd2",
            [],
            {},
            manifest=manifest,
            review_images=[
                (0, 1, 0, "raw", raw_png.tobytes()),
                (0, 1, 0, "overlay", overlay_png.tobytes()),
            ],
        )

    def test_extraction_becomes_resumable_training_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "training.db"
            self._make_extracted_database(path)

            initialize_training_from_extraction(path, "training.nd2")
            summary = training_summary(path)
            frame = get_training_frame(path)

            self.assertEqual(summary["status"], "annotating")
            self.assertEqual(summary["total_frames"], 1)
            self.assertEqual(frame["status"], "draft")
            self.assertEqual(len(frame["instances"]), 1)
            self.assertEqual(load_dataset_manifest(path)["schema_version"], 3)
            self.assertEqual(load_dataset_manifest(path)["training"]["status"], "annotating")
            self.assertTrue(get_frame_image(path, frame["id"], "raw").startswith(b"\x89PNG"))
            self.assertTrue(get_frame_image(path, frame["id"], "auto").startswith(b"\x89PNG"))

    def test_pending_frame_runs_cellpose_only_when_inference_is_requested(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "training.db"
            self._make_extracted_database(path)
            initialize_training_from_extraction(path, "training.nd2")
            frame = get_training_frame(path)
            connection = sqlite3.connect(path)
            try:
                manifest = load_dataset_manifest(path)
                manifest["image_height"] = 2044
                manifest["image_width"] = 2048
                connection.execute(
                    "UPDATE dataset_manifest SET manifest_json = ? WHERE id = 1",
                    (json.dumps(manifest),),
                )
                connection.execute("DELETE FROM annotation_revisions")
                connection.execute("DELETE FROM training_annotations")
                connection.execute("DELETE FROM training_masks")
                connection.execute(
                    "UPDATE training_frames SET status = 'pending', revision = 0"
                )
                connection.commit()
            finally:
                connection.close()

            self.assertIsNone(get_frame_image(path, frame["id"], "auto"))
            labels = np.zeros((32, 16), dtype=np.uint16)
            labels[4:20, 4:12] = 1
            with (
                patch.object(training, "_get_cellpose_model", return_value=object()),
                patch.object(training, "_segment_band", return_value=labels) as segment,
                patch.object(
                    training,
                    "load_view_config",
                    return_value=([], CellFilter(), "test"),
                ),
                patch.object(
                    training,
                    "extract_channel_cells",
                    return_value=(labels, set()),
                ),
            ):
                inferred = training.run_training_frame_inference(path, frame["id"])

            segment.assert_called_once()
            self.assertEqual(inferred["status"], "draft")
            self.assertEqual(inferred["revision"], 1)
            self.assertEqual(len(inferred["instances"]), 1)
            self.assertTrue(
                get_frame_image(path, frame["id"], "auto").startswith(b"\x89PNG")
            )

    def test_reviewed_annotation_writes_16_bit_mask_and_completes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "training.db"
            self._make_extracted_database(path)
            initialize_training_from_extraction(path, "training.nd2")
            frame = get_training_frame(path)

            saved = save_annotation(
                path,
                frame["id"],
                frame["revision"],
                "reviewed",
                [{"id": "cell-a", "points": [[3, 3], [12, 3], [12, 20], [3, 20]]}],
            )
            mask_png = get_frame_image(path, frame["id"], "corrected")
            mask = cv2.imdecode(np.frombuffer(mask_png, dtype=np.uint8), cv2.IMREAD_UNCHANGED)

            self.assertEqual(saved["revision"], 1)
            self.assertEqual(mask.dtype, np.uint16)
            self.assertEqual(int(mask.max()), 1)
            self.assertEqual(training_summary(path)["status"], "completed")

            with self.assertRaises(HTTPException) as conflict:
                save_annotation(path, frame["id"], 0, "draft", [])
            self.assertEqual(conflict.exception.status_code, 409)

    def test_overlapping_instances_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "training.db"
            self._make_extracted_database(path)
            initialize_training_from_extraction(path, "training.nd2")
            frame = get_training_frame(path)
            with self.assertRaises(HTTPException) as invalid:
                save_annotation(
                    path,
                    frame["id"],
                    0,
                    "reviewed",
                    [
                        {"id": "a", "points": [[2, 2], [10, 2], [10, 12], [2, 12]]},
                        {"id": "b", "points": [[6, 6], [14, 6], [14, 18], [6, 18]]},
                    ],
                )
            self.assertEqual(invalid.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
