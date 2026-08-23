from __future__ import annotations

import os
import queue as std_queue
from datetime import datetime
from functools import lru_cache
from io import BytesIO
from multiprocessing import get_context
from pathlib import Path
from threading import Lock, Thread
from time import time
from typing import Annotated, Any, Literal
from uuid import uuid4

import aiofiles
import cv2
import numpy as np
from fastapi import APIRouter, File, HTTPException, Path as ApiPath, Query, UploadFile
from fastapi.responses import FileResponse, Response
from matplotlib import pyplot as plt
from PIL import Image
from pydantic import BaseModel, Field

from app.mother_machine.database import query_cells, query_review_image
from app.mother_machine.processor import (
    MASK_COLORS_RGB,
    inspect_nd2,
    run_extraction,
)
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
_contour_plot_lock = Lock()


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
    image_data = _load_display_review_image(
        filename, view_index, roi_id, time_frame, mode
    )
    if image_data is None:
        raise HTTPException(status_code=404, detail="Review image not found")
    return image_data


def _load_display_review_image(
    filename: str,
    view_index: int,
    roi_id: int,
    time_frame: int,
    mode: str,
) -> bytes | None:
    image_data = load_review_image(filename, view_index, roi_id, time_frame, mode)
    if image_data is None or mode != "overlay":
        return image_data
    raw_data = load_review_image(filename, view_index, roi_id, time_frame, "raw")
    if raw_data is None:
        return image_data
    raw = cv2.imdecode(np.frombuffer(raw_data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    stored_overlay = cv2.imdecode(
        np.frombuffer(image_data, dtype=np.uint8), cv2.IMREAD_COLOR
    )
    if raw is None or stored_overlay is None or raw.shape != stored_overlay.shape[:2]:
        return image_data
    channel_range = (
        stored_overlay.max(axis=2).astype(np.int16)
        - stored_overlay.min(axis=2).astype(np.int16)
    )
    colored_pixels = (channel_range > 18).astype(np.uint8)
    component_count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        colored_pixels, connectivity=8
    )
    component_ids = sorted(
        range(1, component_count),
        key=lambda label: (int(stats[label, cv2.CC_STAT_TOP]), int(stats[label, cv2.CC_STAT_LEFT])),
    )
    rgb = cv2.cvtColor(raw, cv2.COLOR_GRAY2RGB)
    rendered = rgb.copy()
    alpha = 0.68
    for color_index, component_id in enumerate(component_ids):
        pixels = labels == component_id
        color = MASK_COLORS_RGB[color_index % len(MASK_COLORS_RGB)]
        rendered[pixels] = np.clip(
            (1.0 - alpha) * rgb[pixels] + alpha * color, 0, 255
        ).astype(np.uint8)
    near_mask = cv2.dilate(colored_pixels, np.ones((3, 3), np.uint8)) > 0
    stored_white = np.all(stored_overlay >= 245, axis=2)
    rendered[near_mask & ~colored_pixels.astype(bool) & stored_white] = 255
    ok, encoded = cv2.imencode(".png", cv2.cvtColor(rendered, cv2.COLOR_RGB2BGR))
    return encoded.tobytes() if ok else image_data


def _densify_contour(points: list[list[float]]) -> list[tuple[float, float]]:
    dense: list[tuple[float, float]] = []
    for index, start in enumerate(points):
        end = points[(index + 1) % len(points)]
        start_x, start_y = float(start[0]), float(start[1])
        delta_x = float(end[0]) - start_x
        delta_y = float(end[1]) - start_y
        steps = max(int(abs(delta_x)), int(abs(delta_y)), 1)
        dense.extend(
            (
                start_x + delta_x * step / steps,
                start_y + delta_y * step / steps,
            )
            for step in range(steps)
        )
    return dense


def _contours_from_overlay(image_data: bytes) -> list[list[list[float]]]:
    image = cv2.imdecode(
        np.frombuffer(image_data, dtype=np.uint8),
        cv2.IMREAD_COLOR,
    )
    if image is None:
        return []
    mask = (
        image.max(axis=2).astype(np.int16) - image.min(axis=2).astype(np.int16) > 18
    ).astype(np.uint8)
    contours, _hierarchy = cv2.findContours(
        mask,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_NONE,
    )
    return [
        [[float(point[0]), float(point[1])] for point in contour.reshape(-1, 2)]
        for contour in contours
        if len(contour) >= 2
    ]


def render_contour_plot(
    cells: list[dict[str, Any]],
    bounds: tuple[int, int, int, int],
    title: str = "Cell contours",
) -> bytes:
    x0, y0, x1, y1 = bounds
    with _contour_plot_lock:
        figure, axes = plt.subplots(figsize=(5, 5), dpi=120)
        for cell in cells:
            contour = cell.get("contour")
            if not isinstance(contour, list) or len(contour) < 2:
                continue
            points = [
                point
                for point in contour
                if isinstance(point, list) and len(point) >= 2
            ]
            if len(points) < 2:
                continue
            dense_points = _densify_contour(points)
            xs = [point[0] for point in dense_points]
            ys = [point[1] for point in dense_points]
            plt.scatter(xs, ys, s=4)
        axes.set_xlim(0, x1 - x0)
        axes.set_ylim(y1 - y0, 0)
        axes.set_aspect("equal", adjustable="box")
        axes.set_xlabel("x (px)")
        axes.set_ylabel("y (px)")
        axes.set_title(title)
        axes.grid(True, alpha=0.25)
        figure.tight_layout()
        output = BytesIO()
        figure.savefig(output, format="png", dpi=120)
        plt.close(figure)
    return output.getvalue()


@lru_cache(maxsize=256)
def _cached_contour_plot(
    database_file: str,
    database_mtime_ns: int,
    view_index: int,
    roi_id: int,
    time_frame: int,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
) -> bytes:
    del database_mtime_ns
    overlay = query_review_image(
        Path(database_file), view_index, roi_id, time_frame, "overlay"
    )
    if overlay is None:
        return render_contour_plot([], (0, 0, x1 - x0, y1 - y0))
    contours = _contours_from_overlay(overlay)
    cells = [{"contour": contour} for contour in contours]
    return render_contour_plot(
        cells,
        (0, 0, x1 - x0, y1 - y0),
        title=f"Cell contours — frame {time_frame + 1}",
    )


def _encode_gif(frame_data: list[bytes], duration_ms: int = 350) -> bytes:
    frames: list[Image.Image] = []
    for data in frame_data:
        with Image.open(BytesIO(data)) as image:
            frames.append(image.convert("RGB"))
    if not frames:
        raise ValueError("No animation frames found")
    output = BytesIO()
    frames[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
        optimize=False,
    )
    return output.getvalue()


def _stitch_frames(frame_data: list[bytes]) -> bytes:
    frames: list[Image.Image] = []
    for data in frame_data:
        with Image.open(BytesIO(data)) as image:
            frames.append(image.convert("RGB"))
    if not frames:
        raise ValueError("No aligned frames found")
    width = sum(frame.width for frame in frames)
    height = max(frame.height for frame in frames)
    aligned = Image.new("RGB", (width, height), color="black")
    offset_x = 0
    for frame in frames:
        aligned.paste(frame, (offset_x, 0))
        offset_x += frame.width
    output = BytesIO()
    aligned.save(output, format="PNG")
    return output.getvalue()


@lru_cache(maxsize=32)
def _cached_aligned_image(
    filename: str,
    database_mtime_ns: int,
    view_index: int,
    roi_id: int,
    timeframe_count: int,
    kind: str,
) -> bytes:
    del database_mtime_ns
    frames: list[bytes] = []
    for time_frame in range(timeframe_count):
        image_data = _load_display_review_image(
            filename,
            view_index,
            roi_id,
            time_frame,
            kind,
        )
        if image_data is None:
            raise ValueError(f"Review frame {time_frame} not found")
        frames.append(image_data)
    return _stitch_frames(frames)


@lru_cache(maxsize=16)
def _cached_review_gif(
    filename: str,
    database_file: str,
    database_mtime_ns: int,
    view_index: int,
    roi_id: int,
    timeframe_count: int,
    kind: str,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
) -> bytes:
    frames: list[bytes] = []
    for time_frame in range(timeframe_count):
        if kind == "contours":
            frames.append(
                _cached_contour_plot(
                    database_file,
                    database_mtime_ns,
                    view_index,
                    roi_id,
                    time_frame,
                    x0,
                    y0,
                    x1,
                    y1,
                )
            )
            continue
        image_data = _load_display_review_image(
            filename,
            view_index,
            roi_id,
            time_frame,
            kind,
        )
        if image_data is None:
            raise ValueError(f"Review frame {time_frame} not found")
        frames.append(image_data)
    return _encode_gif(frames)


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


@router_mother_machine.get("/datasets/{filename}/contours")
def get_review_contours(
    filename: Annotated[str, ApiPath()],
    view_index: Annotated[int, Query(ge=0)],
    roi_id: Annotated[int, Query(ge=1)],
    time_frame: Annotated[int, Query(ge=0)],
) -> Response:
    sanitized = sanitize_nd2_filename(filename)
    manifest = load_manifest(sanitized)
    path = database_path(sanitized)
    if manifest is None or not path.is_file():
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
    channel = next(
        (
            item
            for item in (view or {}).get("channels", [])
            if int(item.get("channel_id", -1)) == roi_id
        ),
        None,
    )
    roi = channel.get("reference_roi") if isinstance(channel, dict) else None
    if not isinstance(roi, dict):
        raise HTTPException(status_code=404, detail="ROI not found")
    try:
        bounds = tuple(int(roi[key]) for key in ("x0", "y0", "x1", "y1"))
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail="Invalid ROI bounds") from exc
    image_data = _cached_contour_plot(
        str(path), path.stat().st_mtime_ns, view_index, roi_id, time_frame, *bounds
    )
    return Response(content=image_data, media_type="image/png")


@router_mother_machine.get("/datasets/{filename}/animation.gif")
def download_review_animation(
    filename: Annotated[str, ApiPath()],
    view_index: Annotated[int, Query(ge=0)],
    roi_id: Annotated[int, Query(ge=1)],
    kind: Annotated[Literal["raw", "overlay", "contours"], Query()] = "overlay",
) -> Response:
    sanitized = sanitize_nd2_filename(filename)
    manifest = load_manifest(sanitized)
    path = database_path(sanitized)
    if manifest is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Extracted dataset not found")
    view = next(
        (
            item
            for item in manifest.get("views", [])
            if int(item.get("view_index", -1)) == view_index
        ),
        None,
    )
    channel = next(
        (
            item
            for item in (view or {}).get("channels", [])
            if int(item.get("channel_id", -1)) == roi_id
        ),
        None,
    )
    roi = channel.get("reference_roi") if isinstance(channel, dict) else None
    if not isinstance(roi, dict):
        raise HTTPException(status_code=404, detail="ROI not found")
    try:
        bounds = tuple(int(roi[key]) for key in ("x0", "y0", "x1", "y1"))
        timeframe_count = int(manifest["timeframe_count"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail="Invalid dataset manifest") from exc
    try:
        gif_data = _cached_review_gif(
            sanitized,
            str(path),
            path.stat().st_mtime_ns,
            view_index,
            roi_id,
            timeframe_count,
            kind,
            *bounds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    download_name = f"{Path(sanitized).stem}-field-{view_index + 1}-roi-{roi_id}-{kind}.gif"
    return Response(
        content=gif_data,
        media_type="image/gif",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router_mother_machine.get("/datasets/{filename}/aligned.png")
def get_aligned_review_image(
    filename: Annotated[str, ApiPath()],
    view_index: Annotated[int, Query(ge=0)],
    roi_id: Annotated[int, Query(ge=1)],
    kind: Annotated[Literal["raw", "overlay"], Query()] = "raw",
) -> Response:
    sanitized = sanitize_nd2_filename(filename)
    manifest = load_manifest(sanitized)
    path = database_path(sanitized)
    if manifest is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Extracted dataset not found")
    view = next(
        (
            item
            for item in manifest.get("views", [])
            if int(item.get("view_index", -1)) == view_index
        ),
        None,
    )
    channel = next(
        (
            item
            for item in (view or {}).get("channels", [])
            if int(item.get("channel_id", -1)) == roi_id
        ),
        None,
    )
    if channel is None:
        raise HTTPException(status_code=404, detail="ROI not found")
    try:
        timeframe_count = int(manifest["timeframe_count"])
        image_data = _cached_aligned_image(
            sanitized,
            path.stat().st_mtime_ns,
            view_index,
            roi_id,
            timeframe_count,
            kind,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
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
