from __future__ import annotations

import unittest
from pathlib import Path

from app.mcp.guards import GuardViolation, enforce_fragment_limits, normalize_requested_path


REPO_ROOT = Path(__file__).resolve().parents[2]


class MCPGuardsTest(unittest.TestCase):
    def test_rejects_parent_traversal(self):
        with self.assertRaises(GuardViolation):
            normalize_requested_path(REPO_ROOT, "../outside.txt")

    def test_rejects_generated_and_binary_paths(self):
        blocked_paths = (
            "frontend/dist/index.html",
            "backend/app/databases/test_database.db",
            "docs/images/pages/annotationpage/default.png",
            "docs/screen-records/cell-extraction.compressed.mp4",
        )
        for blocked_path in blocked_paths:
            with self.subTest(blocked_path=blocked_path):
                with self.assertRaises(GuardViolation):
                    normalize_requested_path(REPO_ROOT, blocked_path)

    def test_enforces_line_and_byte_limits(self):
        with self.assertRaises(GuardViolation):
            enforce_fragment_limits("\n".join("line" for _ in range(200)))
        with self.assertRaises(GuardViolation):
            enforce_fragment_limits("x" * 30_000)


if __name__ == "__main__":
    unittest.main()
