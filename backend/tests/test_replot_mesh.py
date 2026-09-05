from __future__ import annotations

import pickle
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database_manager.crud import Base, Cell, _build_replot_mesh
from app.database_manager.router import router_database_manager


class ReplotMeshGeometryTest(unittest.TestCase):
    def test_straight_axis_has_even_spacing_and_reaches_both_boundaries(self):
        contour = np.array([[0, -4], [30, -4], [30, 4], [0, 4]])
        centers, segments = _build_replot_mesh(contour, np.array([0.0, 0.0]))

        np.testing.assert_allclose(centers[:, 0], np.arange(2.5, 30, 5))
        np.testing.assert_allclose(centers[:, 1], 0)
        np.testing.assert_allclose(segments[:, 0, 0], centers[:, 0])
        np.testing.assert_allclose(segments[:, 1, 0], centers[:, 0])
        np.testing.assert_allclose(segments[:, 0, 1], -4)
        np.testing.assert_allclose(segments[:, 1, 1], 4)

    def test_curved_axis_uses_arc_length_and_perpendicular_ribs(self):
        x = np.linspace(-20, 20, 201)
        y = 0.025 * x**2
        contour = np.concatenate((
            np.column_stack((x, y - 5)),
            np.column_stack((x[::-1], (y + 5)[::-1])),
        ))
        centers, segments = _build_replot_mesh(contour, np.array([0.025, 0, 0]))

        self.assertGreater(len(centers), 5)
        # Analytic arc length for y = 0.025 x^2, independent of mesh sampling.
        x_centers = centers[:, 0]
        lengths = 0.5 * (
            x_centers * np.sqrt(1 + (0.05 * x_centers)**2)
            + np.arcsinh(0.05 * x_centers) / 0.05
        )
        intervals = np.diff(lengths)
        np.testing.assert_allclose(intervals, intervals.mean(), atol=1e-4)
        np.testing.assert_allclose(centers[:, 1], 0.025 * x_centers**2)
        tangents = np.column_stack((np.ones(len(centers)), 0.05 * x_centers))
        np.testing.assert_allclose(
            np.sum((segments[:, 1] - segments[:, 0]) * tangents, axis=1),
            0, atol=1e-10,
        )
        polygon_cv = contour.astype(np.float32).reshape(-1, 1, 2)
        for endpoints in segments:
            for endpoint in endpoints:
                distance = cv2.pointPolygonTest(polygon_cv, tuple(endpoint), True)
                self.assertAlmostEqual(distance, 0, places=4)

    def test_concave_contour_stops_at_nearest_boundary(self):
        contour = np.array([
            [0, -4], [30, -4], [30, 10], [0, 10],
            [0, 6], [25, 6], [25, 3], [0, 3],
        ])
        centers, segments = _build_replot_mesh(contour, np.array([0.0, 0.0]))

        np.testing.assert_allclose(segments[:, 0, 1], -4)
        np.testing.assert_allclose(segments[centers[:, 0] < 25, 1, 1], 3)
        np.testing.assert_allclose(segments[centers[:, 0] > 25, 1, 1], 10)

    def test_degenerate_contour_and_axis_outside_cell_produce_no_mesh(self):
        for contour, coefficients in (
            (np.empty((0, 2)), [0, 0]),
            (np.array([[0, 0], [10, 0], [20, 0]]), [0, 0]),
            (np.array([[0, -2], [10, -2], [10, 2], [0, 2]]), [0, 5]),
        ):
            with self.subTest(contour=contour):
                centers, segments = _build_replot_mesh(contour, np.array(coefficients))
                self.assertEqual(centers.shape, (0, 2))
                self.assertEqual(segments.shape, (0, 2, 2))


class ReplotMeshEndpointTest(unittest.TestCase):
    def test_mesh_toggle_renders_all_channels_and_defaults_to_off(self):
        app = FastAPI()
        app.include_router(router_database_manager, prefix="/api/v1")
        image = np.arange(80 * 80, dtype=np.uint16).reshape(80, 80)
        success, encoded = cv2.imencode(".png", image)
        self.assertTrue(success)
        contour = cv2.ellipse2Poly((40, 40), (28, 9), 25, 0, 360, 5)

        with tempfile.TemporaryDirectory() as tmpdir:
            engine = create_engine(f"sqlite:///{Path(tmpdir) / 'mesh.db'}")
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                session.add(Cell(
                    cell_id="mesh-cell", contour=pickle.dumps(contour),
                    img_ph=encoded.tobytes(), img_fluo1=encoded.tobytes(),
                    img_fluo2=encoded.tobytes(),
                ))
                session.commit()

            try:
                with patch(
                    "app.database_manager.crud.get_database_session",
                    side_effect=lambda _: Session(engine),
                ), TestClient(app) as client:
                    for channel in ("ph", "fluo1", "fluo2", "overlay"):
                        for dark_mode in (False, True):
                            with self.subTest(channel=channel, dark_mode=dark_mode):
                                params = {
                                    "dbname": "mesh.db", "cell_id": "mesh-cell",
                                    "image_type": channel, "dark_mode": dark_mode,
                                }
                                images = []
                                for mesh_params in ({}, {"mesh": False}, {"mesh": True}):
                                    response = client.get(
                                        "/api/v1/get-cell-replot",
                                        params={**params, **mesh_params},
                                    )
                                    self.assertEqual(
                                        response.status_code, 200,
                                        response.text[:200] if response.status_code != 200 else "",
                                    )
                                    self.assertEqual(response.headers["content-type"], "image/png")
                                    decoded = cv2.imdecode(
                                        np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR,
                                    )
                                    self.assertIsNotNone(decoded)
                                    images.append(decoded)
                                self.assertTrue(np.array_equal(images[0], images[1]))
                                self.assertEqual(images[1].shape, images[2].shape)
                                self.assertFalse(np.array_equal(images[1], images[2]))
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
