from __future__ import annotations

import json
import pickle
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.bulk_engine import phenotype_features, router
from app.bulk_engine.heatmap_bulk_core import calculate_cell_width_metrics
from app.cellextraction.crud import create_database


def image_blob(value: int = 200, maximum: int = 1000) -> bytes:
    image = np.full((12, 20), value, dtype=np.uint16)
    image[2, 2] = maximum
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def contour_blob(height: int = 4) -> bytes:
    return pickle.dumps(np.array(
        [[[2, 2]], [[12, 2]], [[12, 2 + height]], [[2, 2 + height]]],
        dtype=np.int32,
    ))


class PhenotypeFeaturesTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.engine = create_database(str(Path(self.tmpdir.name) / "features.db"))
        self.sessions = sessionmaker(self.engine)
        self.session_patch = patch.object(
            phenotype_features.DatabaseManagerCrud, "get_database_session",
            side_effect=lambda _: self.sessions(),
        )
        self.session_patch.start()
        with phenotype_features._cache_lock:
            phenotype_features._cache.clear()
        with self.engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO cells (cell_id, manual_label, contour, img_ph, img_fluo1, img_fluo2, area) "
                "VALUES (:cell_id, :label, :contour, :ph, :fluo1, :fluo2, :area)"
            ), [
                dict(cell_id="F0C0", label=1, contour=contour_blob(), ph=image_blob(),
                     fluo1=image_blob(), fluo2=image_blob(0, 0), area=40.0),
                dict(cell_id="F0C1", label=2, contour=contour_blob(), ph=None,
                     fluo1=None, fluo2=image_blob(500, 1000), area=40.0),
                dict(cell_id="F0C2", label=1000, contour=b"corrupt contour", ph=None,
                     fluo1=image_blob(), fluo2=None, area=50.0),
                dict(cell_id="F0C3", label=None, contour=None, ph=None,
                     fluo1=None, fluo2=None, area=None),
            ])

    def tearDown(self):
        self.session_patch.stop()
        self.engine.dispose()
        self.tmpdir.cleanup()

    def test_pixel_measurements_and_channel_values_stay_with_their_cell(self):
        payload = phenotype_features.get_phenotype_features("features.db", degree=1)
        self.assertEqual(payload["units"]["area_px2"], "px^2")
        self.assertEqual(len(payload["cells"]), 4)
        first, second, broken, missing = payload["cells"]
        self.assertEqual(first["cell_id"], "F0C0")
        self.assertAlmostEqual(first["length_px"], 10)
        self.assertAlmostEqual(first["width_mean_px"], 4)
        self.assertAlmostEqual(first["width_median_px"], 4)
        self.assertEqual(first["area_px2"], 40)
        self.assertEqual(first["fluo1_normalized_median"], 0.2)
        self.assertEqual(first["fluo2_normalized_median"], 0.0)
        self.assertAlmostEqual(first["fluo1_entropy_norm"], 0)
        self.assertAlmostEqual(first["fluo1_hoyer_sparsity"], 1)
        self.assertGreater(first["fluo1_polar_enrichment"], 1)
        self.assertEqual(first["fluo1_background_intensity"], 200)
        self.assertIsNone(first["fluo2_entropy_norm"])
        self.assertIsNone(second["fluo1_normalized_median"])
        self.assertEqual(second["fluo2_normalized_median"], 0.5)
        self.assertEqual(broken["manual_label"], "N/A")
        self.assertEqual(broken["area_px2"], 50)
        self.assertIsNone(broken["length_px"])
        self.assertIsNone(broken["width_mean_px"])
        self.assertIsNone(broken["fluo1_normalized_median"])
        self.assertEqual(missing["manual_label"], "N/A")
        self.assertTrue(all(missing[key] is None for key in phenotype_features.FEATURE_UNITS))
        json.dumps(payload, allow_nan=False)

    def test_background_mode_is_exported_and_invalidates_cached_localization(self):
        corrected = phenotype_features.get_phenotype_features("features.db", "1", degree=1)
        raw = phenotype_features.get_phenotype_features("features.db", "1", degree=1, background_mode="none")
        self.assertEqual(corrected["localization"]["background_mode"], "local_ring")
        self.assertEqual(raw["localization"]["background_mode"], "none")
        self.assertNotEqual(raw["source_fingerprint"], corrected["source_fingerprint"])
        self.assertGreater(raw["cells"][0]["fluo1_entropy_norm"], corrected["cells"][0]["fluo1_entropy_norm"])

    def test_label_filters_and_empty_results(self):
        self.assertEqual(
            [cell["cell_id"] for cell in phenotype_features.get_phenotype_features("features.db", "1")["cells"]],
            ["F0C0"],
        )
        self.assertEqual(
            [cell["cell_id"] for cell in phenotype_features.get_phenotype_features("features.db", "N/A")["cells"]],
            ["F0C2", "F0C3"],
        )
        self.assertEqual(phenotype_features.get_phenotype_features("features.db", "99")["cells"], [])

    def test_cache_reuses_values_and_invalidates_after_contour_image_or_label_edits(self):
        with patch.object(phenotype_features, "calculate_cell_width_metrics", wraps=calculate_cell_width_metrics) as calc:
            first = phenotype_features.get_phenotype_features("features.db", "1", degree=1)
            self.assertEqual(calc.call_count, 1)
            self.assertEqual(first, phenotype_features.get_phenotype_features("features.db", "1", degree=1))
            self.assertEqual(calc.call_count, 1)
            with self.engine.begin() as conn:
                conn.execute(text("UPDATE cells SET manual_label=2 WHERE cell_id='F0C0'"))
            relabeled = phenotype_features.get_phenotype_features("features.db", degree=1)
            self.assertEqual(relabeled["cells"][0]["manual_label"], "2")
            # A label edit does not alter the cached measurements.
            self.assertNotEqual(first["source_fingerprint"], relabeled["source_fingerprint"])
            with self.engine.begin() as conn:
                conn.execute(text("UPDATE cells SET contour=:contour, img_fluo1=:image WHERE cell_id='F0C0'"),
                             {"contour": contour_blob(6), "image": image_blob(800, 1000)})
            edited = phenotype_features.get_phenotype_features("features.db", degree=1)
            self.assertAlmostEqual(edited["cells"][0]["width_mean_px"], 6)
            self.assertEqual(edited["cells"][0]["fluo1_normalized_median"], 0.8)
            self.assertNotEqual(edited["source_fingerprint"], relabeled["source_fingerprint"])

    def test_endpoint_serialization_and_validation(self):
        app = FastAPI()
        app.include_router(router.router_bulk_engine, prefix="/api/v1")
        app.dependency_overrides[router._track_bulk_engine_activity] = lambda: None
        with ThreadPoolExecutor(max_workers=1) as executor, patch.object(router, "phenotype_executor", executor):
            with TestClient(app) as client:
                response = client.get("/api/v1/get-phenotype-features", params={"dbname": "features.db", "degree": 1})
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(response.json()["cells"][1]["fluo1_normalized_median"])
                invalid = client.get("/api/v1/get-phenotype-features", params={"dbname": "features.db", "degree": 0})
                self.assertEqual(invalid.status_code, 422)
                invalid_mode = client.get("/api/v1/get-phenotype-features", params={"dbname": "features.db", "background_mode": "invalid"})
                self.assertEqual(invalid_mode.status_code, 422)
                with patch.object(router, "get_phenotype_features", side_effect=FileNotFoundError):
                    missing = client.get("/api/v1/get-phenotype-features", params={"dbname": "missing.db"})
                self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
