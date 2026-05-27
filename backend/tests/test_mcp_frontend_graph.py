from __future__ import annotations

import unittest
from pathlib import Path

from app.mcp.frontend_graph import build_frontend_graph
from app.mcp.indexer import RepoIndexer


REPO_ROOT = Path(__file__).resolve().parents[2]


class MCPFrontendGraphTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        repo_index = RepoIndexer(REPO_ROOT).build()
        cls.frontend_graph = build_frontend_graph(REPO_ROOT, repo_index)

    def test_bulk_engine_resolves_multiple_aliases(self):
        references = (
            "/bulk-engine",
            "BulkEnginePage",
            "Bulk Engine",
            "frontend/src/pages/BulkEnginePage.tsx",
        )
        for reference in references:
            with self.subTest(reference=reference):
                page = self.frontend_graph.resolve_page(reference)
                self.assertIsNotNone(page)
                self.assertEqual(page.component_name, "BulkEnginePage")
                self.assertEqual(page.file_path, "frontend/src/pages/BulkEnginePage.tsx")

    def test_cells_page_maps_expected_endpoints(self):
        page = self.frontend_graph.resolve_page("/cells")
        self.assertIsNotNone(page)
        endpoints = set(page.endpoint_names())
        self.assertIn("get-cell-replot", endpoints)
        self.assertIn("get-cell-overlay", endpoints)
        self.assertIn("elastic-contour", endpoints)

    def test_cell_extraction_page_maps_expected_endpoints(self):
        page = self.frontend_graph.resolve_page("/cell-extraction")
        self.assertIsNotNone(page)
        endpoints = set(page.endpoint_names())
        self.assertIn("extract-cells", endpoints)
        self.assertIn("get-extracted-image", endpoints)
        self.assertIn("get-extracted-image-count", endpoints)


if __name__ == "__main__":
    unittest.main()
