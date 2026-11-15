from __future__ import annotations

import unittest
import io
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.bulk_engine.heatmap_bulk_core import build_heatmap_vectors_csv
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

    def test_bundle_route_contains_all_four_images(self):
        response = self.client.post(
            "/api/v1/graph_engine/images",
            files={"file": ("sample.csv", _sample_heatmap_csv(), "text/csv")},
            data={"mode": "HU_aggregation_ratio"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(set(archive.namelist()), {"abs.png", "rel.png", "dist.png", "dist_box.png"})
            for name in archive.namelist():
                self.assertTrue(archive.read(name).startswith(b"\x89PNG"))

    def test_multiple_files_keep_order_and_control(self):
        response = self.client.post(
            "/api/v1/graph_engine/HU_aggregation_ratio",
            files=[
                ("ctrl_file", ("control.csv", _sample_heatmap_csv(), "text/csv")),
                ("files", ("first.csv", _sample_heatmap_csv(), "text/csv")),
                ("files", ("second.csv", _sample_heatmap_csv(), "text/csv")),
            ],
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["filename"] for item in response.json()], ["first.csv", "second.csv"])
        self.assertEqual([item["nagg_rate"] for item in response.json()], [0., 0.])

    def test_analyze_accepts_current_bulk_export_with_control(self):
        axis = list(range(36))
        control = build_heatmap_vectors_csv(
            [list(zip(axis, [0] + [1] * 35))], pixel_size_um=0.1
        )
        treated = build_heatmap_vectors_csv(
            [
                list(zip(axis, [0] * 35 + [1])),
                list(zip(axis, [0] + [1] * 35)),
            ],
            pixel_size_um=0.1,
        )

        response = self.client.post(
            "/api/v1/graph_engine/HU_aggregation_ratio",
            files=[
                ("ctrl_file", ("control.csv", control, "text/csv")),
                ("files", ("treated.csv", treated, "text/csv")),
            ],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            [{"filename": "treated.csv", "mean_length": 3.5, "nagg_rate": 0.5}],
        )

    def test_analyze_rejects_csv_with_no_valid_cells(self):
        response = self.client.post(
            "/api/v1/graph_engine/HU_aggregation_ratio",
            files=[("files", ("invalid.csv", b"0,1,2\n1,2\n", "text/csv"))],
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("invalid.csv", response.json()["detail"])
        self.assertIn("No valid heatmap vector pairs", response.json()["detail"])

    def test_analyze_rejects_control_with_no_valid_cells(self):
        response = self.client.post(
            "/api/v1/graph_engine/HU_aggregation_ratio",
            files=[
                ("ctrl_file", ("control.csv", b"0,1,2\n1,2\n", "text/csv")),
                ("files", ("sample.csv", _sample_heatmap_csv(), "text/csv")),
            ],
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid control CSV", response.json()["detail"])

    def test_image_routes_reject_unpaired_heatmap_rows(self):
        for endpoint in (
            "heatmap_abs",
            "heatmap_rel",
            "distribution",
            "distribution_box",
        ):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(
                    f"/api/v1/graph_engine/{endpoint}",
                    files={"file": ("invalid.csv", b"0,1,2\n", "text/csv")},
                    data={"mode": "HU_aggregation_ratio"},
                )

                self.assertEqual(response.status_code, 400)
                self.assertIn("paired u1 and G", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
