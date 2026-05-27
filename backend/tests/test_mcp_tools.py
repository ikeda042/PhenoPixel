from __future__ import annotations

import unittest
from pathlib import Path

from app.mcp.server import MCPService


REPO_ROOT = Path(__file__).resolve().parents[2]


class MCPToolsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = MCPService(REPO_ROOT)

    def test_explain_page_annotation_contains_summary_and_api(self):
        answer = self.service.explain_page("/annotation")["answer"]
        self.assertIn("ページ概要", answer)
        self.assertIn("get-annotation-zip", answer)

    def test_trace_ui_action_parse_reaches_nd2parser(self):
        answer = self.service.trace_ui_action("/nd2files", "Parse")["answer"]
        self.assertIn("nd2parser/parse", answer)

    def test_explain_algorithm_auto_annotation_reaches_readme_and_impl(self):
        answer = self.service.explain_algorithm(
            "Auto Annotation",
            "/cell-extraction",
        )["answer"]
        self.assertIn("backend/app/cellextraction/README.md", answer)
        self.assertIn("backend/app/cellextraction/crud.py", answer)


if __name__ == "__main__":
    unittest.main()
