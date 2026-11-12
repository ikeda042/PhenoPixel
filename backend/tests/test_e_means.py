from __future__ import annotations

import pickle
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database_manager import crud
from app.database_manager.e_means import cluster_replot_points, create_e_means_plot
from app.database_manager.router import router_database_manager


class EmeansClusteringTest(unittest.TestCase):
    def test_separates_blobs_and_labels_match_final_centroids(self):
        rng = np.random.default_rng(42)
        points = np.vstack([rng.normal(center, 0.2, (100, 2)) for center in
                            ((-10, -4), (0, 6), (10, -4))]).astype(np.float32)
        model, labels, mse = cluster_replot_points(points, 3)
        squared = ((points[:, None] - model.centroids[None]) ** 2).sum(axis=2)
        np.testing.assert_array_equal(labels, squared.argmin(axis=1))
        self.assertLess(mse, 0.15)
        self.assertAlmostEqual(mse, float(squared.min(axis=1).mean()), places=4)
        self.assertEqual(len(np.unique(labels)), 3)
        self.assertEqual(model.recipe['batch_law'], 'quality')
        again, again_labels, _ = cluster_replot_points(points, 3)
        np.testing.assert_array_equal(again.centroids, model.centroids)
        np.testing.assert_array_equal(again_labels, labels)

    def test_one_cluster_is_the_mean_and_all_points_are_used(self):
        points = np.array([[0, 0], [1, 2], [7, 5], [4, 2]], dtype=np.float32)
        model, labels, _ = cluster_replot_points(points, 1)
        np.testing.assert_allclose(model.centroids[0], points.mean(axis=0))
        np.testing.assert_array_equal(labels, np.zeros(len(points)))

    def test_invalid_counts_and_coordinates_are_rejected(self):
        points = np.zeros((5, 2))
        for count in (0, -1, 65, 6, 1.5):
            with self.subTest(count=count), self.assertRaises(ValueError):
                cluster_replot_points(points, count)
        for points in (np.empty((0, 2)), np.ones((4, 3)), np.array([[np.nan, 1]])):
            with self.subTest(points=points), self.assertRaises(ValueError):
                cluster_replot_points(points, 1)


class EmeansEndpointTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.engine = create_engine(f"sqlite:///{Path(directory.name) / 'cells.db'}")
        self.addCleanup(self.engine.dispose)
        crud.Base.metadata.create_all(self.engine)
        self.image = np.full((80, 80), 127, dtype=np.uint8)
        self.contour = cv2.ellipse2Poly((40, 40), (28, 9), 25, 0, 360, 5)
        _, encoded = cv2.imencode('.png', self.image)
        with Session(self.engine) as session:
            session.add_all([
                crud.Cell(cell_id='F0C0', img_ph=encoded.tobytes(),
                          contour=pickle.dumps(self.contour)),
                crud.Cell(cell_id='no-contour', img_ph=encoded.tobytes()),
                crud.Cell(cell_id='no-image', contour=pickle.dumps(self.contour)),
                crud.Cell(cell_id='tiny', img_ph=encoded.tobytes(),
                          contour=pickle.dumps(np.array([[30, 30], [32, 30], [32, 32], [30, 32]]))),
            ])
            session.commit()
        sessions = patch('app.database_manager.crud.get_database_session',
                         side_effect=lambda _: Session(self.engine))
        sessions.start()
        self.addCleanup(sessions.stop)
        app = FastAPI()
        app.include_router(router_database_manager, prefix='/api/v1')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def request(self, **params):
        return self.client.get('/api/v1/get-cell-e-means', params={
            'dbname': 'cells.db', 'cell_id': 'F0C0', **params,
        })

    def test_png_uses_exact_replot_coordinates(self):
        for dark_mode in (False, True):
            with self.subTest(dark_mode=dark_mode), patch(
                'app.database_manager.crud.create_e_means_plot', wraps=create_e_means_plot,
            ) as render:
                response = self.request(n_clusters=4, dark_mode=dark_mode)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers['content-type'], 'image/png')
                image = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
                self.assertIsNotNone(image)
                self.assertEqual(image.shape, (840, 840, 3))
                expected = crud._prepare_replot_geometry(self.image, pickle.dumps(self.contour))
                np.testing.assert_allclose(render.call_args.args[0], np.asarray(expected[5])[:, ::-1])
                np.testing.assert_allclose(render.call_args.args[1], np.column_stack(expected[3:5]))
                self.assertEqual(render.call_args.kwargs['n_clusters'], 4)

    def test_invalid_counts_fail_before_clustering(self):
        with patch('app.database_manager.crud.create_e_means_plot') as render:
            for count in ('0', '-1', '65', '2.5', 'bad'):
                with self.subTest(count=count):
                    self.assertEqual(self.request(n_clusters=count).status_code, 422)
            render.assert_not_called()

    def test_spot_mode_reads_raw_fluorescence_in_the_replot_coordinate_system(self):
        from app.database_manager.spot_detection import create_spot_plot

        y, x = np.mgrid[:80, :80]
        raw = (1000 + 15000 * np.exp(-((x - 40)**2 + (y - 40)**2) / 8)).astype(np.uint16)
        _, encoded = cv2.imencode('.png', raw)
        with Session(self.engine) as session:
            cell = session.query(crud.Cell).filter_by(cell_id='F0C0').one()
            cell.img_fluo2 = encoded.tobytes()
            session.commit()
        with patch('app.database_manager.crud.create_spot_plot', wraps=create_spot_plot) as render:
            response = self.client.get('/api/v1/get-cell-e-means-spots', params={
                'dbname': 'cells.db', 'cell_id': 'F0C0', 'channel': 'fluo2', 'max_spots': 3, 'auto_tune': True,
            })
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR))
            np.testing.assert_array_equal(render.call_args.args[0], raw)
            self.assertTrue(render.call_args.kwargs['auto_tune'])
            expected = crud._prepare_replot_geometry(raw, pickle.dumps(self.contour))
            np.testing.assert_array_equal(render.call_args.args[1], expected[0])
            np.testing.assert_allclose(render.call_args.args[2], np.asarray(expected[5])[:, ::-1])
        response = self.client.get('/api/v1/get-cell-e-means-spots', params={
            'dbname': 'cells.db', 'cell_id': 'F0C0', 'channel': 'fluo1',
        })
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()['detail'], 'fluo1 image not found')

    def test_more_clusters_than_pixels_is_a_useful_error(self):
        response = self.request(cell_id='tiny', n_clusters=10)
        self.assertEqual(response.status_code, 400)
        self.assertIn('cannot exceed', response.json()['detail'])

    def test_missing_resources_are_reported(self):
        for cell_id in ('missing', 'no-image', 'no-contour'):
            with self.subTest(cell_id=cell_id):
                self.assertEqual(self.request(cell_id=cell_id).status_code, 404)
        with patch('app.database_manager.crud.get_database_session', side_effect=FileNotFoundError):
            self.assertEqual(self.request().status_code, 404)


if __name__ == '__main__':
    unittest.main()
