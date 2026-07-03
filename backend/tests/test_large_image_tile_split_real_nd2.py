from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import nd2reader

from app.cellextraction.crud import SyncChores


REPO_ROOT = Path(__file__).resolve().parents[2]
SPLITTABLE_ND2 = (
    REPO_ROOT / "池田さん" / "分割可能" / "260701_100x_32sample_AutoFocus150um001.nd2"
)
UNSPLITTABLE_ND2 = (
    REPO_ROOT / "池田さん" / "分割不可能" / "260630_100x_AutoFocus_Fast150um.nd2"
)


class _FirstFrameImages:
    def __init__(self, images) -> None:
        self._images = images
        self.axes = images.axes
        self.sizes = images.sizes
        self.metadata = images.metadata
        self.parser = images.parser

    def __len__(self) -> int:
        return 1

    def __getitem__(self, index: int):
        if index != 0:
            raise KeyError(index)
        return self._images[0]


def _configure_like_extract_nd2(images) -> None:
    images.bundle_axes = "cyx" if "c" in images.axes else "yx"
    images.iter_axes = (
        "v"
        if "v" in images.axes
        else "".join(axis for axis in images.axes if axis not in images.bundle_axes)
    )


@unittest.skipUnless(SPLITTABLE_ND2.is_file(), "real splittable ND2 fixture missing")
class RealSplittableNd2TileSplitTest(unittest.TestCase):
    def test_first_large_image_frame_is_split_into_camera_sized_tiles(self):
        with nd2reader.ND2Reader(str(SPLITTABLE_ND2)) as images:
            _configure_like_extract_nd2(images)

            layout = SyncChores._detect_large_image_tile_layout(images)

            self.assertIsNotNone(layout)
            assert layout is not None
            self.assertEqual((layout.x_fields, layout.y_fields), (3, 3))
            self.assertEqual((layout.tile_width, layout.tile_height), (2048, 2044))

            with tempfile.TemporaryDirectory() as tmpdir:
                ph_dir = Path(tmpdir) / "PH"
                ph_dir.mkdir()

                frames = SyncChores._write_large_image_tiles(
                    _FirstFrameImages(images),
                    [(0, "PH")],
                    tmpdir,
                    layout,
                )

                self.assertEqual(frames, 9)
                tile_paths = sorted(ph_dir.glob("*.tif"), key=lambda p: int(p.stem))
                self.assertEqual(len(tile_paths), 9)
                for tile_path in tile_paths:
                    tile = cv2.imread(str(tile_path), cv2.IMREAD_UNCHANGED)
                    self.assertIsNotNone(tile)
                    assert tile is not None
                    self.assertEqual(tile.shape[:2], (2044, 2048))


@unittest.skipUnless(UNSPLITTABLE_ND2.is_file(), "real unsplittable ND2 fixture missing")
class RealUnsplittableNd2TileSplitTest(unittest.TestCase):
    def test_camera_mismatch_uses_metadata_grid_fallback(self):
        with nd2reader.ND2Reader(str(UNSPLITTABLE_ND2)) as images:
            _configure_like_extract_nd2(images)

            layout = SyncChores._detect_large_image_tile_layout(images)
            raw = getattr(getattr(images, "parser", None), "_raw_metadata", None)
            candidates = SyncChores._large_image_field_candidates(raw)
            camera_shapes = SyncChores._camera_tile_shapes(raw)

            self.assertEqual(
                candidates,
                [("pLargeImage", 3, 3, 1), ("pLargeImageEx", 2, 2, 1)],
            )
            self.assertEqual(camera_shapes, {(2048, 2044)})
            self.assertIsNotNone(layout)
            assert layout is not None
            self.assertEqual((layout.x_fields, layout.y_fields), (3, 3))
            self.assertEqual((layout.tile_width, layout.tile_height), (1939, 1939))
            self.assertEqual(layout.strategy, "metadata_grid")

            with tempfile.TemporaryDirectory() as tmpdir:
                ph_dir = Path(tmpdir) / "PH"
                ph_dir.mkdir()

                frames = SyncChores._write_large_image_tiles(
                    _FirstFrameImages(images),
                    [(0, "PH")],
                    tmpdir,
                    layout,
                )

                self.assertEqual(frames, 9)
                tile_paths = sorted(ph_dir.glob("*.tif"), key=lambda p: int(p.stem))
                self.assertEqual(len(tile_paths), 9)
                for tile_path in tile_paths:
                    tile = cv2.imread(str(tile_path), cv2.IMREAD_UNCHANGED)
                    self.assertIsNotNone(tile)
                    assert tile is not None
                    self.assertEqual(tile.shape[:2], (1939, 1939))


if __name__ == "__main__":
    unittest.main()
