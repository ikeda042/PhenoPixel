from pathlib import Path
from typing import AsyncIterator

from app.shared.storage import DirectoryStorageCrud

FILES_DIR: Path = Path(__file__).resolve().parent / "storage"
UPLOAD_CHUNK_SIZE: int = 1024 * 1024 * 100


class FileManagerCrud(DirectoryStorageCrud):
    STORAGE_DIR: Path = FILES_DIR
    FILES_DIR: Path = FILES_DIR
    UPLOAD_CHUNK_SIZE = UPLOAD_CHUNK_SIZE

    @classmethod
    def ensure_files_dir(cls) -> Path:
        return cls.ensure_storage_dir()

    @classmethod
    def sanitize_filename(cls, filename: str) -> str:
        return cls.sanitize_name(filename)

    @classmethod
    def sanitize_name(cls, filename: str) -> str:
        cleaned = (filename or "").strip()
        if not cleaned:
            raise ValueError("Filename is required")
        if Path(cleaned).name != cleaned:
            raise ValueError("Invalid filename")
        if cleaned.startswith(".") or cleaned in {".", ".."}:
            raise ValueError("Invalid filename")
        return cleaned

    @classmethod
    def resolve_file_path(cls, filename: str) -> Path:
        return cls.resolve_path(filename)

    @classmethod
    async def list_files(cls) -> list[dict[str, object]]:
        return await cls.list_items()

    @classmethod
    def serialize_list_item(cls, path: Path, stat_result: object) -> dict[str, object]:
        stat = stat_result
        return {
            "name": path.name,
            "size": getattr(stat, "st_size"),
            "modified": getattr(stat, "st_mtime"),
        }

    @classmethod
    def sort_list_items(cls, items: list[dict[str, object]]) -> list[dict[str, object]]:
        return sorted(items, key=lambda item: str(item["name"]).lower())

    @classmethod
    async def save_upload(
        cls, filename: str, reader: AsyncIterator[bytes]
    ) -> dict[str, object]:
        return await super().save_upload(filename, reader)

    @classmethod
    def read_file_chunks(
        cls, path: Path, chunk_size: int = 1024 * 1024
    ) -> AsyncIterator[bytes]:
        return cls.read_chunks(path, chunk_size)

    @classmethod
    async def delete_file(cls, filename: str) -> str:
        return await cls.delete(filename)


def ensure_files_dir() -> Path:
    return FileManagerCrud.ensure_files_dir()


def sanitize_filename(filename: str) -> str:
    return FileManagerCrud.sanitize_filename(filename)


def resolve_file_path(filename: str) -> Path:
    return FileManagerCrud.resolve_file_path(filename)


async def list_files() -> list[dict[str, object]]:
    return await FileManagerCrud.list_files()


async def save_upload(filename: str, reader: AsyncIterator[bytes]) -> dict[str, object]:
    return await FileManagerCrud.save_upload(filename, reader)


def read_file_chunks(path: Path, chunk_size: int = 1024 * 1024) -> AsyncIterator[bytes]:
    return FileManagerCrud.read_file_chunks(path, chunk_size)


async def delete_file(filename: str) -> str:
    return await FileManagerCrud.delete_file(filename)
