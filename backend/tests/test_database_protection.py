from __future__ import annotations

import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.cellextraction.crud import ExtractionCrudBase
from app.database_manager.crud import DatabaseManagerCrud
from app.database_manager.router import router_database_manager


class DatabaseProtectionTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.storage = Path(directory.name)
        storage_patch = patch.object(DatabaseManagerCrud, "STORAGE_DIR", self.storage)
        storage_patch.start()
        self.addCleanup(storage_patch.stop)
        self.protected = self.storage / "test_database.db"
        self.original = b"bundled database contents"
        self.protected.write_bytes(self.original)
        app = FastAPI()
        app.include_router(router_database_manager, prefix="/api/v1")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def url(self, name: str) -> str:
        return f"/api/v1/database_files/{quote(name, safe='')}"

    def test_delete_is_forbidden_including_normalized_names(self):
        for name in ("test_database.db", "TEST_DATABASE.db", " test_database.db "):
            with self.subTest(name=name):
                response = self.client.delete(self.url(name))
                self.assertEqual(response.status_code, 403)
                self.assertIn("bundled database", response.json()["detail"])
                self.assertEqual(self.protected.read_bytes(), self.original)

    def test_direct_crud_delete_and_rename_are_also_forbidden(self):
        for name in ("test_database.db", "../test_database.db"):
            with self.subTest(name=name):
                with self.assertRaises(PermissionError):
                    asyncio.run(DatabaseManagerCrud.delete_database(name))
                with self.assertRaises(PermissionError):
                    asyncio.run(DatabaseManagerCrud.rename_database(name, "renamed.db"))
        self.assertEqual(self.protected.read_bytes(), self.original)
        self.assertFalse((self.storage / "renamed.db").exists())

    def test_rename_cannot_bypass_deletion_protection_or_replace_database(self):
        other = self.storage / "other.db"
        other.write_bytes(b"other database")
        for old, new in ((self.protected.name, other.name), (other.name, self.protected.name)):
            with self.subTest(old=old, new=new):
                response = self.client.patch(self.url(old), params={"new_name": new})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(self.protected.read_bytes(), self.original)
                self.assertEqual(other.read_bytes(), b"other database")

    def test_upload_cannot_truncate_protected_database_or_symlink_target(self):
        alias = self.storage / "alias.db"
        alias.symlink_to(self.protected)
        with patch.object(DatabaseManagerCrud, "migrate_database") as migrate:
            for name in (self.protected.name, "TEST_DATABASE.db", alias.name):
                with self.subTest(name=name):
                    response = self.client.post(
                        "/api/v1/database_files", files={"file": (name, b"replacement")}
                    )
                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(self.protected.read_bytes(), self.original)
            migrate.assert_not_called()

    def test_extraction_cannot_reset_protected_database(self):
        extractor = ExtractionCrudBase.__new__(ExtractionCrudBase)
        with self.assertRaises(PermissionError):
            extractor._reset_database(str(self.protected))
        self.assertEqual(self.protected.read_bytes(), self.original)

    def test_protected_database_remains_listed_and_downloadable(self):
        response = self.client.get("/api/v1/get-databases")
        self.assertEqual(response.json(), [self.protected.name])
        response = self.client.get(self.url(self.protected.name))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.original)

    def test_other_databases_can_still_be_uploaded_renamed_and_deleted(self):
        with patch.object(DatabaseManagerCrud, "migrate_database"):
            response = self.client.post(
                "/api/v1/database_files", files={"file": ("other.db", b"other database")}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual((self.storage / "other.db").read_bytes(), b"other database")
        sidecar = self.storage / "other.db-wal"
        sidecar.write_bytes(b"pending changes")
        response = self.client.patch(self.url("other.db"), params={"new_name": "renamed.db"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.storage / "other.db").exists())
        self.assertEqual((self.storage / "renamed.db-wal").read_bytes(), b"pending changes")
        self.assertFalse(sidecar.exists())
        response = self.client.delete(self.url("renamed.db"))
        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.storage / "renamed.db").exists())
        self.assertEqual(self.protected.read_bytes(), self.original)

    def test_missing_and_invalid_database_deletion_keep_existing_errors(self):
        self.assertEqual(self.client.delete(self.url("missing.db")).status_code, 404)
        self.assertEqual(self.client.delete(self.url("invalid.txt")).status_code, 400)


if __name__ == "__main__":
    unittest.main()
