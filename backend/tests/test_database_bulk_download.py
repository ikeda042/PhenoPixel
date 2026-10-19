from __future__ import annotations

from contextlib import closing
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.database_manager.crud import DatabaseManagerCrud
from app.database_manager.router import router_database_manager


class DatabaseBulkDownloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = Path(self.directory.name) / "databases"
        self.storage.mkdir()
        storage_patch = patch.object(DatabaseManagerCrud, "STORAGE_DIR", self.storage)
        storage_patch.start()
        self.addCleanup(storage_patch.stop)
        app = FastAPI()
        app.include_router(router_database_manager, prefix="/api/v1")
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def create_database(self, name: str, value: str) -> Path:
        path = self.storage / name
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("CREATE TABLE cells (cell_id TEXT)")
            connection.execute("INSERT INTO cells VALUES (?)", (value,))
            connection.commit()
        return path

    def download(self, names: list[str]):
        with patch.object(
            DatabaseManagerCrud,
            "create_database_archive",
            wraps=DatabaseManagerCrud.create_database_archive,
        ) as create_archive:
            response = self.client.post(
                "/api/v1/database_files/bulk-download", json={"dbnames": names}
            )
        archive_path = create_archive.call_args.args[1]
        self.assertFalse(archive_path.parent.exists(), "Temporary ZIP must be cleaned up")
        return response

    def assert_archived_database(self, archive: zipfile.ZipFile, name: str, value: str):
        destination = Path(self.directory.name) / "extracted" / name
        destination.parent.mkdir(exist_ok=True)
        destination.write_bytes(archive.read(name))
        with closing(sqlite3.connect(destination)) as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(connection.execute("SELECT cell_id FROM cells").fetchall(), [(value,)])

    def test_zip_contains_only_selected_databases_without_duplicates(self):
        self.create_database("first.db", "F0C0")
        self.create_database("対照 #1?.db", "F0C1")
        self.create_database("unselected.db", "F0C2")

        response = self.download(["first.db", "対照 #1?.db", "first.db"])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        self.assertIn('filename="databases.zip"', response.headers["content-disposition"])
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            self.assertEqual(archive.namelist(), ["first.db", "対照 #1?.db"])
            self.assert_archived_database(archive, "first.db", "F0C0")
            self.assert_archived_database(archive, "対照 #1?.db", "F0C1")
        self.assertEqual(len(list(self.storage.glob("*.db"))), 3)

    def test_backup_includes_committed_wal_changes(self):
        path = self.storage / "live.db"
        with closing(sqlite3.connect(path)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE cells (cell_id TEXT)")
            writer.execute("INSERT INTO cells VALUES ('latest')")
            writer.commit()
            self.assertTrue(Path(f"{path}-wal").is_file())

            response = self.download(["live.db"])

            self.assertEqual(response.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertEqual(archive.namelist(), ["live.db"])
                self.assert_archived_database(archive, "live.db", "latest")

    def test_empty_selection_is_rejected(self):
        response = self.download([])
        self.assertEqual(response.status_code, 400)

    def test_missing_database_rejects_entire_download(self):
        self.create_database("first.db", "F0C0")
        response = self.download(["first.db", "missing.db"])
        self.assertEqual(response.status_code, 404)
        self.assertIn("missing.db", response.json()["detail"])
        self.assertFalse((self.storage / "missing.db").exists())

    def test_invalid_names_are_rejected(self):
        self.create_database("first.db", "F0C0")
        for name in ("../first.db", "/first.db", "..\\first.db", "first.txt", " first.db ", ""):
            with self.subTest(name=name):
                self.assertEqual(self.download([name]).status_code, 400)

    def test_symlink_outside_database_storage_is_rejected(self):
        outside = Path(self.directory.name) / "outside.db"
        outside.write_bytes(b"private")
        (self.storage / "linked.db").symlink_to(outside)
        self.assertEqual(self.download(["linked.db"]).status_code, 400)

    def test_failed_backup_cleans_up_temporary_zip(self):
        (self.storage / "broken.db").write_bytes(b"not a SQLite database")
        self.assertEqual(self.download(["broken.db"]).status_code, 500)


if __name__ == "__main__":
    unittest.main()
