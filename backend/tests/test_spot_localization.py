from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
import json
import pickle
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import cv2
from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker
from app.bulk_engine import spot_localization as sl, router
from app.cellextraction.crud import create_database
from app.database_manager.crud import _prepare_replot_geometry
from app.database_manager.spot_detection import analyze_spots


def blob(image):
    ok, encoded = cv2.imencode('.png', image)
    assert ok
    return encoded.tobytes()


def coordinates(contour, shape=(180, 180)):
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.fillPoly(mask, [np.rint(contour).astype(np.int32)], 1)
    return np.column_stack(np.where(mask))


class CoordinatesTest(unittest.TestCase):
    def setUp(self):
        self.contour = np.array([[10, 20], [110, 20], [110, 60], [10, 60]], dtype=float)

    def geometry(self, contour=None):
        contour = self.contour if contour is None else contour
        return sl.CellCoordinates.from_contour(contour, coordinates(contour))

    def test_known_positions_and_endpoints(self):
        geometry = self.geometry()
        for point, long, lateral in [([35, 30], .25, -.5), ([60, 40], .5, 0), ([85, 50], .75, .5)]:
            result = geometry.locate(point)
            self.assertAlmostEqual(result['longitudinal'], long, places=5)
            self.assertAlmostEqual(result['lateral'], lateral, places=5)
        self.assertEqual(geometry.locate([10, 40])['longitudinal'], 0)
        self.assertEqual(geometry.locate([110, 40])['longitudinal'], 1)
        self.assertIsNone(geometry.locate([10, 40])['lateral'])

    def test_translation_scaling_rotation_and_reflection(self):
        point = np.array([35, 30])
        reference = self.geometry().locate(point)
        rotation = np.array([[.8, -.6], [.6, .8]])
        for transform, offset in [(np.eye(2), [12, 8]), (np.eye(2) * .7, [0, 0]),
                                  (rotation, [40, 10]), (np.diag([-1, 1]), [130, 0])]:
            contour = self.contour @ transform.T + offset
            result = self.geometry(contour).locate(point @ transform.T + offset)
            self.assertAlmostEqual(result['nearest_pole'], reference['nearest_pole'], delta=.003)
            self.assertAlmostEqual(abs(result['lateral']), abs(reference['lateral']), delta=.01)

    def test_curved_cell_centerline_and_local_width(self):
        xs = np.linspace(15, 135, 241)
        ys = 40 + .004 * (xs - 75)**2
        contour = np.vstack((np.column_stack((xs, ys - 10)), np.column_stack((xs[::-1], ys[::-1] + 10))))
        geometry = self.geometry(contour)
        center = geometry.locate([75, 40])
        self.assertAlmostEqual(center['longitudinal'], .5, delta=.005)
        self.assertAlmostEqual(center['lateral'], 0, delta=.01)
        self.assertAlmostEqual(geometry.locate([75, 45])['lateral'], .5, delta=.01)
        self.assertAlmostEqual(geometry.locate([45, 40 + .004 * 30**2])['lateral'], 0, delta=.01)

    def test_width_changes_are_normalized_locally(self):
        contour = np.array([[10, 35], [110, 20], [110, 60], [10, 45]], dtype=float)
        geometry = self.geometry(contour)
        self.assertAlmostEqual(geometry.locate([30, 44])['lateral'], .5, delta=.01)
        self.assertAlmostEqual(geometry.locate([90, 48.5])['lateral'], .5, delta=.01)

    def test_undefined_axis_is_rejected(self):
        contour = np.array([[20, 20], [40, 20], [40, 40], [20, 40]], dtype=float)
        with self.assertRaisesRegex(ValueError, 'long axis'):
            self.geometry(contour)

    def test_small_pole_notch_does_not_discard_an_otherwise_valid_cell(self):
        contour = np.array([[10, 20], [110, 20], [110, 35], [107, 35],
                            [107, 36], [110, 36], [110, 60], [10, 60]], dtype=float)
        result = self.geometry(contour).locate([60, 40])
        self.assertAlmostEqual(result['longitudinal'], .5, delta=.01)
        self.assertAlmostEqual(result['lateral'], 0, delta=.02)

    def test_narrow_pole_has_longitudinal_position_but_no_transverse_value(self):
        contour = np.array([[10, 40], [110, 20], [110, 60]], dtype=float)
        result = self.geometry(contour).locate([12, 40])
        self.assertAlmostEqual(result['longitudinal'], .02, delta=.005)
        self.assertIsNone(result['lateral'])
        self.assertIsNotNone(result['lateral_reason'])


class LocalizationTest(unittest.TestCase):
    def setUp(self):
        y, x = np.mgrid[:80, :120]
        signal = np.random.default_rng(17).normal(30, 1, x.shape)
        for cx, cy, amplitude in [(35, 35, 100), (85, 45, 80)]:
            signal += amplitude * np.exp(-((x - cx)**2 + (y - cy)**2) / 8)
        self.image = np.rint(signal).astype(np.uint16)
        self.image_raw = blob(self.image)
        self.contour = pickle.dumps(np.array([[[10, 20]], [[110, 20]], [[110, 60]], [[10, 60]]], dtype=np.int32))
        sl._cache.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_database(str(Path(self.tmp.name) / 'spots.db'))
        self.sessions = sessionmaker(self.engine)
        self.session_patch = patch.object(sl.DatabaseManagerCrud, 'get_database_session', side_effect=lambda _: self.sessions())
        self.session_patch.start()
        with self.engine.begin() as conn:
            conn.execute(text('INSERT INTO cells (cell_id, manual_label, img_fluo1, img_fluo2, contour) VALUES (:id, :label, :image, :second, :contour)'), [
                dict(id='A', label=1, image=self.image_raw, second=blob(np.zeros_like(self.image)), contour=self.contour),
                dict(id='B', label=1, image=blob(np.zeros_like(self.image)), second=None, contour=self.contour),
                dict(id='C', label=2, image=None, second=None, contour=self.contour),
                dict(id='D', label=1000, image=self.image_raw, second=None, contour=b'broken'),
                dict(id='E', label=None, image=self.image_raw, second=None, contour=None),
            ])

    def tearDown(self):
        self.session_patch.stop()
        self.engine.dispose()
        self.tmp.cleanup()

    def test_detector_matches_single_cell_and_recovers_normalized_positions(self):
        result = sl.analyze_cell(self.image_raw, self.contour)
        self.assertEqual(len(result['spots']), 2)
        coords, _, _, _, _, points = _prepare_replot_geometry(self.image, self.contour)
        reference = analyze_spots(self.image, coords, np.asarray(points)[:, ::-1], max_spots=10, auto_tune=True)
        for actual, expected, position in zip(result['spots'], reference.spots, [.25, .75]):
            np.testing.assert_allclose([actual['raw_x'], actual['raw_y']], expected.raw_center)
            self.assertAlmostEqual(actual['longitudinal'], position, delta=.01)
            self.assertEqual(actual['snr'], expected.snr)
        self.assertFalse(result['at_cap'])

    def test_fluorescence_does_not_flip_coordinates(self):
        inverted = self.image.copy()
        inverted[:, 60:] *= 2
        before = sorted(sl.analyze_cell(self.image_raw, self.contour)['spots'], key=lambda spot: spot['raw_x'])
        after = sorted(sl.analyze_cell(blob(inverted), self.contour)['spots'], key=lambda spot: spot['raw_x'])
        self.assertEqual(len(before), len(after))
        np.testing.assert_allclose([s['longitudinal'] for s in before], [s['longitudinal'] for s in after], atol=.005)

    def test_zero_missing_and_invalid_cells_have_distinct_statuses(self):
        result = sl.get_spot_localization('spots.db')
        self.assertEqual(result['summary'], dict(total_cells=5, analyzed_cells=2, skipped_cells=3,
            positive_cells=1, total_spots=2, at_cap_cells=0, unmapped_lateral_spots=0))
        self.assertEqual(result['cells'][1]['status'], 'ok')
        self.assertEqual(result['cells'][1]['spots'], [])
        self.assertTrue(all(c['error'] for c in result['cells'][2:]))
        json.dumps(result, allow_nan=False)

    def test_labels_channels_empty_and_cache_invalidation(self):
        with patch.object(sl, 'analyze_cell', wraps=sl.analyze_cell) as analyze:
            first = sl.get_spot_localization('spots.db', '1')
            sl.get_spot_localization('spots.db', '1')
            self.assertEqual(analyze.call_count, 2)
            with self.engine.begin() as conn:
                conn.execute(text("UPDATE cells SET img_fluo1=:image WHERE cell_id='A'"), {'image': blob(self.image * 2)})
            updated = sl.get_spot_localization('spots.db', '1')
            self.assertEqual(analyze.call_count, 3)
            self.assertNotEqual(first['cells'][0]['spots'][0]['amplitude'], updated['cells'][0]['spots'][0]['amplitude'])
        self.assertEqual(sl.get_spot_localization('spots.db', '1', 'fluo2')['summary']['analyzed_cells'], 1)
        self.assertEqual([c['cell_id'] for c in sl.get_spot_localization('spots.db', 'N/A')['cells']], ['D', 'E'])
        self.assertEqual(sl.get_spot_localization('spots.db', '99')['cells'], [])

    def test_fixed_cap_and_route_contract(self):
        app = FastAPI()
        app.include_router(router.router_bulk_engine, prefix='/api/v1')
        app.dependency_overrides[router._track_bulk_engine_activity] = lambda: None
        with ThreadPoolExecutor(max_workers=1) as executor, patch.object(router, 'spot_localization_executor', executor):
            with TestClient(app) as client:
                response = client.get('/api/v1/get-gfp-spot-localization', params={'dbname': 'spots.db', 'label': '1', 'max_spots': 1})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['max_spots'], 10)
                self.assertEqual(response.json()['summary']['total_spots'], 2)
                self.assertEqual(client.get('/api/v1/get-gfp-spot-localization', params={'dbname': 'spots.db', 'channel': 'ph'}).status_code, 422)
                with patch.object(router, 'get_spot_localization', side_effect=FileNotFoundError):
                    self.assertEqual(client.get('/api/v1/get-gfp-spot-localization', params={'dbname': 'absent.db'}).status_code, 404)


if __name__ == '__main__':
    unittest.main()
