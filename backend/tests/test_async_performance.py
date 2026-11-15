from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app.bulk_engine import crud as bulk_crud
from app.extracted_data import router as extracted
from app.file_manager.crud import FileManagerCrud


class AsyncPerformanceTest(unittest.IsolatedAsyncioTestCase):
    async def test_listing_runs_off_loop_and_preserves_filter_and_sort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "b.txt").write_text("bbb")
            (root / "A.txt").write_text("a")
            (root / ".hidden").touch()
            (root / "subdir").mkdir()
            main_thread = threading.get_ident()
            seen_threads = []

            class LocalFiles(FileManagerCrud):
                STORAGE_DIR = root

                @classmethod
                def serialize_list_item(cls, path, stat_result):
                    seen_threads.append(threading.get_ident())
                    return super().serialize_list_item(path, stat_result)

            items = await LocalFiles.list_items()
            self.assertEqual([(item["name"], item["size"]) for item in items],
                             [("A.txt", 1), ("b.txt", 3)])
            self.assertTrue(seen_threads)
            self.assertTrue(all(thread != main_thread for thread in seen_threads))

    async def test_extracted_count_filters_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "sample"
            folder.mkdir()
            (folder / "one.PNG").touch()
            (folder / "two.png").touch()
            (folder / "three.txt").touch()
            (folder / "directory.png").mkdir()
            with patch.object(extracted, "EXTRACTED_DATA_DIR", root):
                self.assertEqual(await extracted.get_extracted_image_count("sample"), {"count": 2})


class HeatmapCacheTest(unittest.TestCase):
    def test_cache_is_content_and_degree_sensitive(self):
        bulk_crud._heatmap_path_cache.clear()
        with patch.object(bulk_crud, "calculate_heatmap_path_vector", return_value=[(1., 2.)]) as calculate:
            first = bulk_crud._cached_heatmap_path(b"image", b"contour", 4)
            first.append((9., 9.))
            self.assertEqual(bulk_crud._cached_heatmap_path(b"image", b"contour", 4), [(1., 2.)])
            bulk_crud._cached_heatmap_path(b"changed", b"contour", 4)
            bulk_crud._cached_heatmap_path(b"image", b"changed", 4)
            bulk_crud._cached_heatmap_path(b"image", b"contour", 5)
            self.assertEqual(calculate.call_count, 4)
        bulk_crud._heatmap_path_cache.clear()
