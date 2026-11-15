import asyncio
import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.shared.storage import stream_file_chunks

router_extracted_data: APIRouter = APIRouter(tags=["extracted_data"])
EXTRACTED_DATA_DIR: Path = Path(__file__).resolve().parent


async def _list_extracted_folders() -> list[str]:
    def scan() -> list[str]:
        if not EXTRACTED_DATA_DIR.exists():
            return []
        with os.scandir(EXTRACTED_DATA_DIR) as entries:
            return sorted(entry.name for entry in entries
                          if not entry.name.startswith((".", "__")) and entry.is_dir())
    return await asyncio.to_thread(scan)


def _sanitize_folder(folder: str) -> str:
    cleaned = (folder or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Folder is required")
    if Path(cleaned).name != cleaned:
        raise HTTPException(status_code=400, detail="Invalid folder name")
    if cleaned.startswith(".") or cleaned in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid folder name")
    return cleaned


@router_extracted_data.get("/get-folder-names", response_model=list[str])
async def get_folder_names() -> list[str]:
    return await _list_extracted_folders()


@router_extracted_data.get("/get-extracted-image")
async def get_extracted_image(
    folder: Annotated[str, Query()] = ...,
    n: Annotated[int, Query(ge=0)] = ...,
) -> StreamingResponse:
    folder_name = _sanitize_folder(folder)
    folder_path = EXTRACTED_DATA_DIR / folder_name
    if not folder_path.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    file_path = folder_path / f"{n}.png"
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return StreamingResponse(stream_file_chunks(file_path), media_type="image/png")


@router_extracted_data.get("/get-extracted-image-count")
async def get_extracted_image_count(
    folder: Annotated[str, Query()] = ...,
) -> dict[str, int]:
    folder_name = _sanitize_folder(folder)
    folder_path = EXTRACTED_DATA_DIR / folder_name
    def count_images() -> int:
        if not folder_path.is_dir():
            raise HTTPException(status_code=404, detail="Folder not found")
        with os.scandir(folder_path) as entries:
            return sum(1 for entry in entries
                       if entry.name.lower().endswith(".png") and entry.is_file())
    count = await asyncio.to_thread(count_images)
    return {"count": count}
