from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.bulk_engine import crud, router


class FitcAggregationTest(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(router.router_bulk_engine, prefix="/api/v1")
        app.dependency_overrides[router._track_bulk_engine_activity] = lambda: None
        executor = self.enterContext(ThreadPoolExecutor(max_workers=1))
        self.enterContext(patch.object(router, "bulk_executor", executor))
        self.client = self.enterContext(TestClient(app))
        self.medians = self.enterContext(patch.object(
            crud, "get_normalized_medians_by_label",
            return_value=[("a", 0.0), ("b", 0.6), ("c", 0.7414), ("d", 1.0)],
        ))
        self.plot = self.enterContext(patch.object(
            crud, "_build_fitc_aggregation_ratio_plot", return_value=b"plot",
        ))

    def test_api_threshold_changes_ratio_and_plot_label_with_strict_comparison(self):
        for threshold, expected_threshold, expected_ratio in (
            (None, 0.7414, 0.5),
            ("0.6", 0.6, 0.25),
            ("0.8", 0.8, 0.75),
            ("0", 0.0, 0.0),
            ("1", 1.0, 0.75),
        ):
            with self.subTest(threshold=threshold):
                params = {"dbname": "sample.db", "label": "2", "channel": "fluo2"}
                if threshold is not None:
                    params["threshold"] = threshold
                response = self.client.get("/api/v1/get-fitc-aggregation-plot", params=params)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "image/png")
                self.medians.assert_called_with("sample.db", "2", "fluo2")
                self.assertEqual(self.plot.call_args.kwargs["ratio"], expected_ratio)
                self.assertEqual(self.plot.call_args.kwargs["threshold"], expected_threshold)

    def test_api_rejects_invalid_thresholds_before_calculation(self):
        for threshold in ("", "invalid", "-0.1", "1.1", "nan", "inf", "-inf"):
            with self.subTest(threshold=threshold):
                response = self.client.get(
                    "/api/v1/get-fitc-aggregation-plot",
                    params={"dbname": "sample.db", "threshold": threshold},
                )
                self.assertEqual(response.status_code, 422)
        self.medians.assert_not_called()

    def test_crud_keeps_default_for_existing_callers_and_validates_threshold(self):
        crud.BulkEngineCrud.create_fitc_aggregation_ratio_plot("sample.db")
        self.assertEqual(self.plot.call_args.kwargs["threshold"], 0.7414)
        self.assertEqual(self.plot.call_args.kwargs["ratio"], 0.5)
        for threshold in (-0.1, 1.1, float("nan"), float("inf")):
            with self.subTest(threshold=threshold), self.assertRaises(ValueError):
                crud.BulkEngineCrud.create_fitc_aggregation_ratio_plot(
                    "sample.db", threshold=threshold,
                )


if __name__ == "__main__":
    unittest.main()
