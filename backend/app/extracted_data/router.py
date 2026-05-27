from pathlib import Path
from typing import Annotated

from aiofiles import os as aioos
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.shared.storage import stream_file_chunks

router_extracted_data: APIRouter = APIRouter(tags=["extracted_data"])
EXTRACTED_DATA_DIR: Path = Path(__file__).resolve().parent


async def _list_extracted_folders() -> list[str]:
    if not EXTRACTED_DATA_DIR.exists():
        return []
    entries = await aioos.listdir(EXTRACTED_DATA_DIR)
    folders = [
        name
        for name in entries
        if (EXTRACTED_DATA_DIR / name).is_dir() and not name.startswith((".", "__"))
    ]
    return sorted(folders)


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
    if not folder_path.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    entries = await aioos.listdir(folder_path)
    count = sum(
        1
        for name in entries
        if (folder_path / name).is_file() and name.lower().endswith(".png")
    )
    return {"count": count}
