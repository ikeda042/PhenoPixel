from __future__ import annotations

import contextlib
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from app.cellextraction import crud
from app.shared.objective_scale import ObjectiveMagnification


def _phase_image(axes: tuple[int, int], size: int) -> np.ndarray:
    image = np.full((size, size), 180, dtype=np.uint8)
    cv2.ellipse(image, (size // 2, size // 2), axes, 0, 0, 360, 40, -1)
    return image


class ContourAreaScaleTest(unittest.TestCase):
    def setUp(self) -> None:
        tmpdir = self.enterContext(tempfile.TemporaryDirectory())
        self.tmp_path = Path(tmpdir)
        for name, directory in (
            ("DATABASES_DIR", "databases"),
            ("EXTRACTED_DATA_DIR", "overlays"),
            ("TEMPDATA_DIR", "tempdata"),
        ):
            self.enterContext(patch.object(crud, name, self.tmp_path / directory))

    def _extractor(
        self,
        objective: ObjectiveMagnification,
        metadata_pixel_size: float | None = None,
    ) -> crud.ExtractionCrudBase:
        with patch.object(
            crud.SyncChores,
            "detect_nd2_pixel_size_um",
            return_value=metadata_pixel_size,
        ):
            return crud.ExtractionCrudBase(
                "synthetic.nd2",
                mode="single_layer",
                objective_magnification=objective,
            )

    def test_cropped_contour_detection_uses_pixel_calibration(self):
        cases = (
            ("100x", None, (22, 9), True),
            ("100x", None, (13, 5), False),
            ("60x", None, (13, 5), True),
            ("60x", None, (4, 2), False),
            ("100x", 0.108, (13, 5), True),
            ("60x", 0.13, (8, 3), True),
        )
        for objective, metadata_pixel_size, axes, expected in cases:
            with self.subTest(
                objective=objective, metadata_pixel_size=metadata_pixel_size, axes=axes
            ):
                extractor = self._extractor(objective, metadata_pixel_size)
                contour, *_ = extractor.process_image(_phase_image(axes, 200))

                self.assertEqual(contour is not None, expected)

    def test_extraction_applies_calibration_to_initial_detection_and_storage(self):
        cases = (
            ("100x", None, (22, 9), 1, 0.065),
            ("100x", None, (13, 5), 0, 0.065),
            ("60x", None, (13, 5), 1, 0.108),
            ("60x", None, (4, 2), 0, 0.108),
            ("100x", 0.108, (13, 5), 1, 0.108),
            ("60x", 0.13, (8, 3), 1, 0.13),
        )
        for objective, metadata_pixel_size, axes, expected_count, pixel_size in cases:
            with self.subTest(
                objective=objective, metadata_pixel_size=metadata_pixel_size, axes=axes
            ):
                extractor = self._extractor(objective, metadata_pixel_size)
                ph_dir = Path(extractor.temp_dir) / "PH"
                ph_dir.mkdir(parents=True)
                self.assertTrue(cv2.imwrite(str(ph_dir / "0.tif"), _phase_image(axes, 1024)))

                # Bypass ND2 decoding while exercising both detection stages and SQLite.
                with (
                    patch.object(crud.SyncChores, "extract_nd2", return_value=1),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    _, _, databases = extractor.main()

                self.assertEqual(databases[0]["contour_count"], expected_count)
                db_path = crud.DATABASES_DIR / str(databases[0]["db_name"])
                with contextlib.closing(sqlite3.connect(db_path)) as connection:
                    rows = connection.execute(
                        "SELECT area, pixel_size_um, objective_magnification FROM cells"
                    ).fetchall()
                self.assertEqual(len(rows), expected_count)
                if expected_count:
                    area, stored_pixel_size, stored_objective = rows[0]
                    self.assertGreater(area, 0)
                    self.assertAlmostEqual(stored_pixel_size, pixel_size)
                    self.assertEqual(stored_objective, extractor.objective_magnification)
                    if pixel_size > 0.065:
                        self.assertLess(area, 300)


if __name__ == "__main__":
    unittest.main()
