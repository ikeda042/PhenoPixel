from __future__ import annotations

import unittest
from pathlib import Path

from app.mcp.backend_graph import build_backend_graph
from app.mcp.indexer import RepoIndexer


REPO_ROOT = Path(__file__).resolve().parents[2]


class MCPBackendGraphTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        repo_index = RepoIndexer(REPO_ROOT).build()
        cls.backend_graph = build_backend_graph(REPO_ROOT, repo_index)

    def test_get_annotation_zip_links_router_and_crud(self):
        endpoint = self.backend_graph.resolve_endpoint("get-annotation-zip")
        self.assertIsNotNone(endpoint)
        self.assertEqual(endpoint.router_path, "backend/app/database_manager/router.py")
        self.assertEqual(endpoint.crud_path, "backend/app/database_manager/crud.py")

    def test_extract_cells_links_router_and_readme(self):
        endpoint = self.backend_graph.resolve_endpoint("extract-cells")
        self.assertIsNotNone(endpoint)
        self.assertEqual(endpoint.router_path, "backend/app/cellextraction/router.py")
        self.assertEqual(endpoint.readme_path, "backend/app/cellextraction/README.md")


if __name__ == "__main__":
    unittest.main()
