from __future__ import annotations

import os
import queue as std_queue
from datetime import datetime
from multiprocessing import get_context
from pathlib import Path
from threading import Lock, Thread
from time import time
from typing import Annotated, Any, Literal
from uuid import uuid4

import aiofiles
from fastapi import APIRouter, File, HTTPException, Path as ApiPath, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.mother_machine.database import query_cells
from app.mother_machine.processor import inspect_nd2, run_extraction
from app.mother_machine.storage import (
    ND2_DIR,
    database_path,
    ensure_directories,
    list_databases,
    load_manifest,
    load_review_image,
    mother_machine_database_path,
    nd2_path,
    remove_dataset,
    sanitize_nd2_filename,
)


router_mother_machine = APIRouter(
    prefix="/mother-machine", tags=["mother-machine"]
)
UPLOAD_CHUNK_SIZE = 1024 * 1024 * 64
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = Lock()


class BulkDeleteRequest(BaseModel):
    filenames: list[str]


class ExtractionRequest(BaseModel):
    filename: str
    niter: int = Field(default=500, ge=1, le=5000)


def _public_job(job_id: str, job: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "job_id": job_id,
        "filename": job["filename"],
        "niter": job["niter"],
        "status": job["status"],
        "progress": job.get("progress"),
    }
    if job["status"] == "completed":
        response["result"] = job.get("result")
    elif job["status"] == "failed":
        response["error"] = job.get("error") or "Extraction failed"
    return response


def _run_job(nd2_file: str, filename: str, niter: int, result_queue: Any) -> None:
    def progress(payload: dict[str, Any]) -> None:
        try:
            result_queue.put({"type": "progress", "progress": payload})
        except Exception:
            pass

    try:
        result = run_extraction(Path(nd2_file), filename, progress, niter=niter)
        result_queue.put({"type": "result", "ok": True, "result": result})
    except Exception as exc:
        result_queue.put({"type": "result", "ok": False, "error": str(exc)})


def _watch_job(job_id: str, process: Any, result_queue: Any) -> None:
    final_message: dict[str, Any] | None = None
    while True:
        try:
            message = result_queue.get(timeout=0.5)
        except std_queue.Empty:
            if not process.is_alive():
                break
            continue
        except Exception:
            break
        if message.get("type") == "progress":
            with _jobs_lock:
                job = _jobs.get(job_id)
                if job is not None:
                    job["progress"] = message.get("progress")
            continue
        if message.get("type") == "result":
            final_message = message
            break
    process.join()
    if final_message is None:
        try:
            message = result_queue.get(timeout=1)
            if message.get("type") == "result":
                final_message = message
        except Exception:
            final_message = None
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            if final_message and final_message.get("ok") and process.exitcode in (0, None):
                job["status"] = "completed"
                job["result"] = final_message.get("result")
                job["progress"] = {
                    "stage": "completed",
                    "message": "Extraction completed",
                }
            else:
                job["status"] = "failed"
                job["error"] = (
                    final_message.get("error")
                    if final_message
                    else "Extraction process ended without a result"
                )
            job["finished_at"] = time()
            job["process"] = None
            job["queue"] = None
    try:
        result_queue.close()
        result_queue.cancel_join_thread()
    except Exception:
        pass
    try:
        process.close()
    except Exception:
        pass


def _running_job_for_filename(filename: str) -> tuple[str, dict[str, Any]] | None:
    with _jobs_lock:
        for job_id, job in _jobs.items():
            if job["filename"] == filename and job["status"] == "running":
                return job_id, dict(job)
    return None


def _delete_one(filename: str) -> str:
    sanitized = sanitize_nd2_filename(filename)
    running = _running_job_for_filename(sanitized)
    if running:
        raise HTTPException(
            status_code=409,
            detail=f"Extraction is running for {sanitized}",
        )
    path = nd2_path(sanitized)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    path.unlink()
    remove_dataset(sanitized)
    return sanitized


@router_mother_machine.get("/nd2-files")
def list_nd2_files() -> dict[str, list[dict[str, Any]]]:
    ensure_directories()
    files: list[dict[str, Any]] = []
    for path in sorted(ND2_DIR.glob("*.nd2"), key=lambda item: item.name.lower()):
        stat = path.stat()
        files.append(
            {
                "filename": path.name,
                "size_bytes": stat.st_size,
                "modified_time": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "has_dataset": database_path(path.name).is_file()
                and load_manifest(path.name) is not None,
            }
        )
    return {"files": files}


@router_mother_machine.get("/databases")
def get_databases() -> dict[str, list[dict[str, Any]]]:
    return {"databases": list_databases()}


@router_mother_machine.get("/databases/{database_name}/download")
def download_database(database_name: Annotated[str, ApiPath()]) -> FileResponse:
    path = mother_machine_database_path(database_name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Database not found")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=path.name,
    )


@router_mother_machine.delete("/databases/{database_name}")
def delete_database(database_name: Annotated[str, ApiPath()]) -> dict[str, Any]:
    path = mother_machine_database_path(database_name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Database not found")
    path.unlink()
    return {"deleted": True, "filename": path.name}


@router_mother_machine.post("/nd2-files")
async def upload_nd2_file(
    file: Annotated[UploadFile, File()] = ...,
) -> dict[str, Any]:
    sanitized = sanitize_nd2_filename(file.filename or "")
    if _running_job_for_filename(sanitized):
        raise HTTPException(
            status_code=409,
            detail=f"Extraction is running for {sanitized}",
        )
    destination = nd2_path(sanitized)
    temporary = destination.with_name(f".{destination.name}.{uuid4().hex}.upload")
    total_size = 0
    try:
        async with aiofiles.open(temporary, "wb") as output:
            while chunk := await file.read(UPLOAD_CHUNK_SIZE):
                total_size += len(chunk)
                await output.write(chunk)
        if total_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        os.replace(temporary, destination)
        remove_dataset(sanitized)
    except HTTPException:
        if temporary.exists():
            temporary.unlink()
        raise
    except Exception as exc:
        if temporary.exists():
            temporary.unlink()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"filename": sanitized, "size_bytes": total_size}


@router_mother_machine.post("/nd2-files/bulk-delete")
def bulk_delete_nd2_files(payload: BulkDeleteRequest) -> dict[str, list[str]]:
    if not payload.filenames:
        raise HTTPException(status_code=400, detail="No filenames provided")
    deleted: list[str] = []
    missing: list[str] = []
    invalid: list[str] = []
    for filename in dict.fromkeys(payload.filenames):
        try:
            sanitized = sanitize_nd2_filename(filename)
        except HTTPException:
            invalid.append(filename)
            continue
        if not nd2_path(sanitized).is_file():
            missing.append(sanitized)
            continue
        deleted.append(_delete_one(sanitized))
    return {"deleted": deleted, "missing": missing, "invalid": invalid}


@router_mother_machine.delete("/nd2-files/{filename}")
def delete_nd2_file(filename: Annotated[str, ApiPath()]) -> dict[str, Any]:
    sanitized = _delete_one(filename)
    return {"deleted": True, "filename": sanitized, "extracted_data_deleted": True}


@router_mother_machine.get("/nd2-files/{filename}/download")
def download_nd2_file(filename: Annotated[str, ApiPath()]) -> FileResponse:
    sanitized = sanitize_nd2_filename(filename)
    path = nd2_path(sanitized)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="application/octet-stream", filename=sanitized)


@router_mother_machine.get("/nd2-files/{filename}/metadata")
def get_nd2_metadata(filename: Annotated[str, ApiPath()]) -> dict[str, Any]:
    sanitized = sanitize_nd2_filename(filename)
    path = nd2_path(sanitized)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        metadata = inspect_nd2(path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"filename": sanitized, **metadata}


@router_mother_machine.post("/extractions", status_code=202)
def start_extraction(payload: ExtractionRequest) -> dict[str, Any]:
    sanitized = sanitize_nd2_filename(payload.filename)
    path = nd2_path(sanitized)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    existing = _running_job_for_filename(sanitized)
    if existing:
        return _public_job(existing[0], existing[1])
    with _jobs_lock:
        if any(job["status"] == "running" for job in _jobs.values()):
            raise HTTPException(
                status_code=429,
                detail="Another mother-machine extraction is already running",
            )
    context = get_context("spawn")
    result_queue = context.Queue()
    process = context.Process(
        target=_run_job,
        args=(str(path), sanitized, payload.niter, result_queue),
    )
    try:
        process.start()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to start extraction") from exc
    job_id = uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "filename": sanitized,
            "niter": payload.niter,
            "status": "running",
            "progress": {"stage": "starting", "message": "Starting extraction"},
            "result": None,
            "error": None,
            "process": process,
            "queue": result_queue,
            "created_at": time(),
            "finished_at": None,
        }
    Thread(
        target=_watch_job,
        args=(job_id, process, result_queue),
        daemon=True,
    ).start()
    return _public_job(job_id, _jobs[job_id])


@router_mother_machine.get("/extractions/{job_id}")
def get_extraction(job_id: Annotated[str, ApiPath()]) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        snapshot = dict(job) if job else None
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return _public_job(job_id, snapshot)


@router_mother_machine.get("/datasets/{filename}")
def get_dataset(filename: Annotated[str, ApiPath()]) -> dict[str, Any]:
    sanitized = sanitize_nd2_filename(filename)
    manifest = load_manifest(sanitized)
    if manifest is None or not database_path(sanitized).is_file():
        raise HTTPException(status_code=404, detail="Extracted dataset not found")
    return manifest


def _resolve_review_image(
    filename: str,
    view_index: int,
    roi_id: int,
    time_frame: int,
    mode: Literal["raw", "overlay"],
) -> bytes:
    manifest = load_manifest(filename)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Extracted dataset not found")
    if time_frame < 0 or time_frame >= int(manifest.get("timeframe_count", 0)):
        raise HTTPException(status_code=404, detail="Time frame not found")
    view = next(
        (
            item
            for item in manifest.get("views", [])
            if int(item.get("view_index", -1)) == view_index
        ),
        None,
    )
    if view is None:
        raise HTTPException(status_code=404, detail="Field of view not found")
    channel = next(
        (
            item
            for item in view.get("channels", [])
            if int(item.get("channel_id", -1)) == roi_id
        ),
        None,
    )
    if channel is None:
        raise HTTPException(status_code=404, detail="ROI not found")
    image_data = load_review_image(
        filename, view_index, roi_id, time_frame, mode
    )
    if image_data is None:
        raise HTTPException(status_code=404, detail="Review image not found")
    return image_data


@router_mother_machine.get("/datasets/{filename}/image")
def get_review_image(
    filename: Annotated[str, ApiPath()],
    view_index: Annotated[int, Query(ge=0)],
    roi_id: Annotated[int, Query(ge=1)],
    time_frame: Annotated[int, Query(ge=0)],
    mode: Annotated[Literal["raw", "overlay"], Query()] = "overlay",
) -> Response:
    sanitized = sanitize_nd2_filename(filename)
    image_data = _resolve_review_image(
        sanitized, view_index, roi_id, time_frame, mode
    )
    return Response(content=image_data, media_type="image/png")


@router_mother_machine.get("/datasets/{filename}/cells")
def get_review_cells(
    filename: Annotated[str, ApiPath()],
    view_index: Annotated[int, Query(ge=0)],
    roi_id: Annotated[int, Query(ge=1)],
    time_frame: Annotated[int, Query(ge=0)],
) -> dict[str, Any]:
    sanitized = sanitize_nd2_filename(filename)
    path = database_path(sanitized)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Extracted database not found")
    cells = query_cells(path, view_index, roi_id, time_frame)
    return {"cells": cells, "count": len(cells)}
