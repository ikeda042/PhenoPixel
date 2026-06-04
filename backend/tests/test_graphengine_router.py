from __future__ import annotations

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.graphengine.router import router_graphengine


def _sample_heatmap_csv() -> bytes:
    axis = ",".join(str(index) for index in range(35))
    peaks = ",".join(str((index % 7) + 1) for index in range(35))
    return f"{axis}\n{peaks}\n".encode("utf-8")


class GraphEngineRouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app = FastAPI()
        app.include_router(router_graphengine, prefix="/api/v1")
        cls.client = TestClient(app, raise_server_exceptions=False)

    def test_analyze_route_accepts_uploaded_csv_files(self):
        response = self.client.post(
            "/api/v1/graph_engine/HU_aggregation_ratio",
            files=[("files", ("sample.csv", _sample_heatmap_csv(), "text/csv"))],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            [{"filename": "sample.csv", "mean_length": 2.21, "nagg_rate": None}],
        )

    def test_image_routes_are_not_shadowed_by_mode_route(self):
        for endpoint in (
            "heatmap_abs",
            "heatmap_rel",
            "distribution",
            "distribution_box",
        ):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(
                    f"/api/v1/graph_engine/{endpoint}",
                    files={"file": ("sample.csv", _sample_heatmap_csv(), "text/csv")},
                    data={"mode": "HU_aggregation_ratio"},
                )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "image/png")
                self.assertGreater(len(response.content), 0)


if __name__ == "__main__":
    unittest.main()
