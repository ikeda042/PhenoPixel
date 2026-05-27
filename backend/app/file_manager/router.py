from typing import Annotated, AsyncIterator

from fastapi import APIRouter, File, HTTPException, Path, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from app.file_manager.crud import FileManagerCrud

router_file_manager: APIRouter = APIRouter(tags=["file_manager"])


async def _iter_upload(file: UploadFile) -> AsyncIterator[bytes]:
    while True:
        chunk = await file.read(FileManagerCrud.UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        yield chunk


@router_file_manager.get("/filemanager/files")
async def list_files_endpoint() -> JSONResponse:
    try:
        files = await FileManagerCrud.list_files()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return JSONResponse(content={"files": files})


@router_file_manager.post("/filemanager/files")
async def upload_file_endpoint(file: Annotated[UploadFile, File()] = ...) -> JSONResponse:
    try:
        payload = await FileManagerCrud.save_upload(file.filename or "", _iter_upload(file))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        await file.close()
    return JSONResponse(content=payload)


@router_file_manager.get("/filemanager/files/{filename}")
async def download_file_endpoint(
    filename: Annotated[str, Path()]
) -> FileResponse:
    try:
        file_path = FileManagerCrud.resolve_file_path(filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        file_path,
        media_type="application/octet-stream",
        filename=file_path.name,
    )


@router_file_manager.delete("/filemanager/files/{filename}")
async def delete_file_endpoint(filename: Annotated[str, Path()]) -> JSONResponse:
    try:
        deleted = await FileManagerCrud.delete_file(filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return JSONResponse(content={"deleted": True, "filename": deleted})
