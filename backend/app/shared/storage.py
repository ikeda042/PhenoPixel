from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import aiofiles
from aiofiles import os as aioos

DEFAULT_CHUNK_SIZE: int = 1024 * 1024


async def stream_file_chunks(
    path: Path,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    async with aiofiles.open(path, "rb") as file_handle:
        while True:
            chunk = await file_handle.read(chunk_size)
            if not chunk:
                break
            yield chunk


class DirectoryStorageCrud:
    STORAGE_DIR: Path
    READ_CHUNK_SIZE: int = DEFAULT_CHUNK_SIZE

    @classmethod
    def ensure_storage_dir(cls) -> Path:
        cls.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        return cls.STORAGE_DIR

    @classmethod
    def sanitize_name(cls, name: str) -> str:
        raise NotImplementedError

    @classmethod
    def resolve_path(cls, name: str) -> Path:
        return cls.STORAGE_DIR / cls.sanitize_name(name)

    @classmethod
    def should_include_path(cls, path: Path) -> bool:
        return path.is_file() and not path.name.startswith(".")

    @classmethod
    def serialize_list_item(cls, path: Path, stat_result: Any) -> Any:
        return path.name

    @classmethod
    def sort_list_items(cls, items: list[Any]) -> list[Any]:
        return sorted(items)

    @classmethod
    async def list_items(cls) -> list[Any]:
        if not cls.STORAGE_DIR.is_dir():
            return []
        items: list[Any] = []
        for name in await aioos.listdir(cls.STORAGE_DIR):
            path = cls.STORAGE_DIR / name
            if not cls.should_include_path(path):
                continue
            stat_result = await aioos.stat(path)
            items.append(cls.serialize_list_item(path, stat_result))
        return cls.sort_list_items(items)

    @classmethod
    def serialize_upload_result(cls, filename: str, size: int) -> dict[str, object]:
        return {"filename": filename, "size": size}

    @classmethod
    async def save_upload(
        cls,
        filename: str,
        reader: AsyncIterator[bytes],
    ) -> dict[str, object]:
        sanitized = cls.sanitize_name(filename)
        cls.ensure_storage_dir()
        file_path = cls.STORAGE_DIR / sanitized
        total_size = 0
        async with aiofiles.open(file_path, "wb") as out_file:
            async for chunk in reader:
                if not chunk:
                    continue
                total_size += len(chunk)
                await out_file.write(chunk)
        return cls.serialize_upload_result(sanitized, total_size)

    @classmethod
    def read_chunks(
        cls,
        path: Path,
        chunk_size: int | None = None,
    ) -> AsyncIterator[bytes]:
        return stream_file_chunks(path, chunk_size or cls.READ_CHUNK_SIZE)

    @classmethod
    async def delete(
        cls,
        name: str,
        *,
        missing_message: str = "File not found",
    ) -> str:
        file_path = cls.resolve_path(name)
        if not file_path.is_file():
            raise FileNotFoundError(missing_message)
        await aioos.remove(file_path)
        return file_path.name

    @classmethod
    def ensure_rename_target_available(
        cls,
        new_name: str,
        *,
        exists_message: str,
    ) -> None:
        if (cls.STORAGE_DIR / new_name).exists():
            raise FileExistsError(exists_message)

    @classmethod
    async def rename_related_files(cls, old_name: str, new_name: str) -> None:
        return None

    @classmethod
    async def rename(
        cls,
        old_name: str,
        new_name: str,
        *,
        missing_message: str = "File not found",
        exists_message: str = "File already exists",
    ) -> tuple[str, str]:
        old_cleaned = cls.sanitize_name(old_name)
        new_cleaned = cls.sanitize_name(new_name)
        if old_cleaned == new_cleaned:
            return old_cleaned, new_cleaned
        old_path = cls.STORAGE_DIR / old_cleaned
        if not old_path.is_file():
            raise FileNotFoundError(missing_message)
        cls.ensure_rename_target_available(
            new_cleaned,
            exists_message=exists_message,
        )
        await aioos.rename(old_path, cls.STORAGE_DIR / new_cleaned)
        await cls.rename_related_files(old_cleaned, new_cleaned)
        return old_cleaned, new_cleaned
