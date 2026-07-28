from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from pydantic import ValidationError

from app.shared.objective_scale import DEFAULT_OBJECTIVE_MAGNIFICATION
from app.cellextraction.crud import LargeImageTileLayout, SyncChores
from app.cellextraction.router import ExtractCellsRequest


class _RawMetadata:
    def __init__(self) -> None:
        self.image_metadata = {
            b"SLxExperiment": {
                b"ppNextLevelEx": {
                    b"": {
                        b"pLargeImage": {
                            b"bValid": 1,
                            b"iXFields": 4,
                            b"iYFields": 4,
                        },
                        b"pLargeImageEx": {
                            b"bValid": 1,
                            b"iXFields": 2,
                            b"iYFields": 2,
                        },
                    }
                }
            }
        }
        self.image_metadata_sequence = {
            b"SLxPictureMetadata": {
                b"sPicturePlanes": {
                    b"sPlaneNew": {
                        b"a0": {
                            b"sizeObjFullChip": {
                                b"cx": 2048,
                                b"cy": 2044,
                            }
                        }
                    }
                }
            }
        }
        self.grabber_settings = {}


class _Parser:
    def __init__(self, raw_metadata: _RawMetadata) -> None:
        self._raw_metadata = raw_metadata


class _Images:
    def __init__(
        self,
        frames: list[np.ndarray],
        raw_metadata: _RawMetadata,
        sizes: dict[str, int] | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        self._frames = frames
        self.sizes = sizes or {"x": 8192, "y": 8176}
        self.metadata = metadata or {}
        self.parser = _Parser(raw_metadata)

    def __len__(self) -> int:
        return len(self._frames)

    def __getitem__(self, index: int) -> np.ndarray:
        return self._frames[index]


class LargeImageTileSplitTest(unittest.TestCase):
    def test_detect_large_image_prefers_camera_tile_consistent_candidate(self):
        images = _Images([np.zeros((8176, 8192), dtype=np.uint16)], _RawMetadata())

        layout = SyncChores._detect_large_image_tile_layout(images)

        self.assertIsNotNone(layout)
        assert layout is not None
        self.assertEqual(layout.x_fields, 4)
        self.assertEqual(layout.y_fields, 4)
        self.assertEqual(layout.tile_width, 2048)
        self.assertEqual(layout.tile_height, 2044)
        self.assertEqual(layout.source, "pLargeImage")

    def test_detect_large_image_falls_back_to_metadata_grid_on_camera_mismatch(self):
        images = _Images(
            [np.zeros((8176, 8200), dtype=np.uint16)],
            _RawMetadata(),
            sizes={"x": 8200, "y": 8176},
        )

        layout = SyncChores._detect_large_image_tile_layout(images)

        self.assertIsNotNone(layout)
        assert layout is not None
        self.assertEqual(layout.x_fields, 4)
        self.assertEqual(layout.y_fields, 4)
        self.assertEqual(layout.tile_width, 2050)
        self.assertEqual(layout.tile_height, 2044)
        self.assertEqual(layout.strategy, "metadata_grid")

    def test_auto_split_resolves_metadata_based_layout(self):
        images = _Images([np.zeros((8176, 8192), dtype=np.uint16)], _RawMetadata())

        layout = SyncChores._resolve_large_image_tile_layout(
            images,
            "auto",
            4,
            4,
        )

        self.assertIsNotNone(layout)
        assert layout is not None
        self.assertEqual((layout.x_fields, layout.y_fields), (4, 4))
        self.assertEqual(layout.source, "pLargeImage")

    def test_manual_split_uses_requested_grid_without_large_image_metadata(self):
        raw = _RawMetadata()
        raw.image_metadata = {}
        frame = np.arange(64, dtype=np.uint16).reshape(8, 8)
        images = _Images([frame], raw, sizes={"x": 8, "y": 8})

        layout = SyncChores._resolve_large_image_tile_layout(
            images,
            "manual",
            4,
            4,
        )

        self.assertIsNotNone(layout)
        assert layout is not None
        self.assertEqual((layout.x_fields, layout.y_fields), (4, 4))
        self.assertEqual((layout.tile_width, layout.tile_height), (2, 2))
        self.assertEqual(layout.source, "manual")
        self.assertEqual(layout.strategy, "manual_grid")

        with tempfile.TemporaryDirectory() as tmpdir:
            ph_dir = Path(tmpdir) / "PH"
            ph_dir.mkdir()

            frames = SyncChores._write_large_image_tiles(
                images,
                [(0, "PH")],
                tmpdir,
                layout,
            )

            self.assertEqual(frames, 16)
            for index in range(16):
                tile = cv2.imread(
                    str(ph_dir / f"{index}.tif"),
                    cv2.IMREAD_UNCHANGED,
                )
                self.assertIsNotNone(tile)
                assert tile is not None
                self.assertEqual(tile.shape[:2], (2, 2))

    def test_none_split_disables_metadata_based_large_image_split(self):
        images = _Images([np.zeros((8, 8), dtype=np.uint16)], _RawMetadata())

        layout = SyncChores._resolve_large_image_tile_layout(
            images,
            "none",
            4,
            4,
        )

        self.assertIsNone(layout)

    def test_manual_split_rejects_grid_larger_than_image(self):
        images = _Images(
            [np.zeros((3, 3), dtype=np.uint16)],
            _RawMetadata(),
            sizes={"x": 3, "y": 3},
        )

        with self.assertRaisesRegex(ValueError, "exceeds the image dimensions"):
            SyncChores._resolve_large_image_tile_layout(
                images,
                "manual",
                4,
                4,
            )

    def test_write_large_image_tiles_preserves_non_divisible_grid_coverage(self):
        frame = np.arange(20, dtype=np.uint16).reshape(4, 5)
        images = _Images([frame], _RawMetadata(), sizes={"x": 5, "y": 4})
        layout = LargeImageTileLayout(
            x_fields=4,
            y_fields=2,
            tile_width=1,
            tile_height=2,
            source="test",
            image_width=5,
            image_height=4,
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            ph_dir = Path(tmpdir) / "PH"
            ph_dir.mkdir()

            frames = SyncChores._write_large_image_tiles(
                images,
                [(0, "PH")],
                tmpdir,
                layout,
            )

            self.assertEqual(frames, 8)
            shapes = []
            for index in range(8):
                tile = cv2.imread(str(ph_dir / f"{index}.tif"), cv2.IMREAD_UNCHANGED)
                self.assertIsNotNone(tile)
                assert tile is not None
                shapes.append(tile.shape[:2])
            self.assertEqual(
                shapes,
                [(2, 1), (2, 1), (2, 1), (2, 2)] * 2,
            )

    def test_detect_pixel_size_prefers_nd2_metadata(self):
        images = _Images(
            [np.zeros((8176, 8192), dtype=np.uint16)],
            _RawMetadata(),
            metadata={"pixel_microns": 0.107291556674444},
        )

        pixel_size = SyncChores._detect_pixel_size_um_from_images(images)
        objective = SyncChores._objective_for_pixel_size(
            pixel_size or 0,
            DEFAULT_OBJECTIVE_MAGNIFICATION,
        )

        self.assertAlmostEqual(pixel_size or 0, 0.107291556674444)
        self.assertEqual(objective, "60x")

    def test_write_large_image_tiles_saves_each_tile_as_a_frame(self):
        raw = _RawMetadata()
        frame = np.zeros((4, 4), dtype=np.uint16)
        frame[0:2, 0:2] = 10
        frame[0:2, 2:4] = 20
        frame[2:4, 0:2] = 30
        frame[2:4, 2:4] = 40
        images = _Images([frame], raw, sizes={"x": 4, "y": 4})
        layout = SyncChores._detect_large_image_tile_layout(images)

        # Use a hand-built layout here so this test focuses on write ordering.
        layout = LargeImageTileLayout(
            x_fields=2,
            y_fields=2,
            tile_width=2,
            tile_height=2,
            source="test",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            fluo_dir = Path(tmpdir) / "Fluo1"
            fluo_dir.mkdir()

            frames = SyncChores._write_large_image_tiles(
                images,
                [(0, "Fluo1")],
                tmpdir,
                layout,
            )

            self.assertEqual(frames, 4)
            means = []
            for index in range(4):
                tile = cv2.imread(str(fluo_dir / f"{index}.tif"), cv2.IMREAD_UNCHANGED)
                self.assertIsNotNone(tile)
                means.append(int(np.mean(tile)))
            self.assertEqual(means, [10, 20, 30, 40])


class ExtractCellsRequestLargeImageSplitTest(unittest.TestCase):
    def test_request_defaults_to_auto_split(self):
        request = ExtractCellsRequest(
            filename="example.nd2",
            layer_mode="single",
        )

        self.assertEqual(request.large_image_split_mode, "auto")
        self.assertEqual(request.large_image_columns, 4)
        self.assertEqual(request.large_image_rows, 4)

    def test_manual_request_accepts_four_by_four_grid(self):
        request = ExtractCellsRequest(
            filename="example.nd2",
            layer_mode="single",
            large_image_split_mode="manual",
            large_image_columns=4,
            large_image_rows=4,
        )

        self.assertEqual(request.large_image_split_mode, "manual")
        self.assertEqual(
            request.large_image_columns * request.large_image_rows,
            16,
        )

    def test_manual_request_rejects_one_by_one_grid(self):
        with self.assertRaises(ValidationError):
            ExtractCellsRequest(
                filename="example.nd2",
                layer_mode="single",
                large_image_split_mode="manual",
                large_image_columns=1,
                large_image_rows=1,
            )


if __name__ == "__main__":
    unittest.main()
