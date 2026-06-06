from __future__ import annotations

import os
import pickle
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from app.cellextraction import crud


def _rectangle_contour(width: int = 50, height: int = 10) -> np.ndarray:
    half_w = width // 2
    half_h = height // 2
    return np.array(
        [
            [[100 - half_w, 100 - half_h]],
            [[100 + half_w, 100 - half_h]],
            [[100 + half_w, 100 + half_h]],
            [[100 - half_w, 100 + half_h]],
        ],
        dtype=np.int32,
    )


class MLAutoAnnotationTest(unittest.TestCase):
    def tearDown(self) -> None:
        crud._load_autoannotation_model.cache_clear()

    def test_bundled_model_loads(self):
        os.environ.pop("PHENOPIXEL_AUTOANNOTATION_MODEL", None)
        crud._load_autoannotation_model.cache_clear()

        model = crud._load_autoannotation_model()

        self.assertIsNotNone(model)
        self.assertIn("training_rows", model.metadata)
        self.assertGreater(model.metadata["training_rows"], 0)
        self.assertEqual(
            model.metadata.get("reference_dataset"),
            "backend/autoannotation/testdata/autoannotation_testdata.db",
        )

    def test_bundled_training_dataset_is_available(self):
        dataset_path = (
            Path(__file__).resolve().parents[1]
            / "autoannotation"
            / "testdata"
            / "autoannotation_testdata.db"
        )

        with sqlite3.connect(dataset_path) as connection:
            total = connection.execute("SELECT COUNT(*) FROM cells").fetchone()[0]
            labels = dict(
                connection.execute(
                    "SELECT manual_label, COUNT(*) FROM cells GROUP BY manual_label"
                ).fetchall()
            )
            sources = dict(
                connection.execute(
                    "SELECT source_db, COUNT(*) FROM cells GROUP BY source_db"
                ).fetchall()
            )

        self.assertEqual(total, 520)
        self.assertEqual(labels, {1: 300, "N/A": 220})
        self.assertEqual(
            sources,
            {
                "microscope_data.db": 289,
                "test_database (1).db": 231,
            },
        )

    def test_missing_model_falls_back_to_contour_heuristic(self):
        contour = _rectangle_contour()
        contour_blob = pickle.dumps(contour)
        perimeter = cv2.arcLength(contour, True)
        area = cv2.contourArea(contour)

        with patch.dict(
            os.environ,
            {"PHENOPIXEL_AUTOANNOTATION_MODEL": "/tmp/missing-autoannotator.pkl"},
        ):
            crud._load_autoannotation_model.cache_clear()
            label = crud.auto_annotate_cell(
                perimeter=perimeter,
                area=area,
                img_ph=None,
                img_fluo1=None,
                img_fluo2=None,
                contour_blob=contour_blob,
            )

        self.assertEqual(label, 1)
        self.assertTrue(crud.screen_contour(contour_blob))


if __name__ == "__main__":
    unittest.main()
