import logging
import os
import queue as std_queue
from multiprocessing import get_context
from pathlib import Path
from threading import Lock, Thread
from time import time
from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Path as ApiPath
from pydantic import BaseModel, Field

from app.activity_tracker.crud import ACTION_CELL_EXTRACTION, record_activity_sync
from app.cellextraction.crud import ExtractionCrudBase
from app.shared.objective_scale import (
    DEFAULT_OBJECTIVE_MAGNIFICATION,
    ObjectiveMagnification,
    pixel_size_for_objective,
)
from app.slack.notifier import build_database_created_message, notify_slack_sync


router_cellextraction: APIRouter = APIRouter(tags=["cellextraction"])
logger: logging.Logger = logging.getLogger("uvicorn.error")
ND2_DIR: Path = Path(__file__).resolve().parents[1] / "nd2files"
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock: Lock = Lock()
_DEFAULT_MAX_CONCURRENCY: int = 5


def _get_max_concurrency() -> int:
    value = os.getenv("CELLEXTRACTION_MAX_CONCURRENCY")
    if not value:
        return _DEFAULT_MAX_CONCURRENCY
    try:
        parsed = int(value)
    except ValueError:
        return _DEFAULT_MAX_CONCURRENCY
    return parsed if parsed > 0 else _DEFAULT_MAX_CONCURRENCY


class ExtractCellsRequest(BaseModel):
    filename: str
    layer_mode: str
    param1: int = Field(130, ge=0)
    image_size: int = Field(200, ge=1)
    auto_annotation: bool = False
    objective_magnification: ObjectiveMagnification = DEFAULT_OBJECTIVE_MAGNIFICATION


def _sanitize_nd2_filename(filename: str) -> str:
    cleaned = Path(filename or "").name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Filename is required")
    base, ext = Path(cleaned).stem, Path(cleaned).suffix
    if not base:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if ext.lower() != ".nd2":
        raise HTTPException(status_code=400, detail="Only .nd2 files are supported")
    base = base.replace(".", "p")
    return f"{base}.nd2"


def _normalize_layer_mode(layer_mode: str) -> tuple[str, bool]:
    normalized = (layer_mode or "").strip().lower()
    if normalized in {"single", "single_layer", "single-layer"}:
        return "single_layer", False
    if normalized in {"dual", "dual_layer", "dual-layer"}:
        return "dual_layer", False
    if normalized in {
        "dual(reversed)",
        "dual_reversed",
        "dual-reversed",
        "dual reversed",
    }:
        return "dual_layer", True
    if normalized in {"triple", "triple_layer", "triple-layer"}:
        return "triple_layer", False
    if normalized in {"quad", "quad_layer", "quad-layer"}:
        return "quad_layer", False
    raise HTTPException(status_code=400, detail="Invalid layer_mode")


def _run_extraction(
    nd2_path: str,
    mode: str,
    param1: int,
    image_size: int,
    reverse_layers: bool,
    auto_annotation: bool,
    objective_magnification: ObjectiveMagnification,
    result_queue,
) -> None:
    try:
        extractor = ExtractionCrudBase(
            nd2_path=nd2_path,
            mode=mode,
            param1=param1,
            image_size=image_size,
            reverse_layers=reverse_layers,
            auto_annotation=auto_annotation,
            objective_magnification=objective_magnification,
        )
        num_tiff, ulid, created_databases = extractor.main()
        result_queue.put(
            {
                "ok": True,
                "result": {
                    "num_tiff": num_tiff,
                    "ulid": ulid,
                    "databases": created_databases,
                    "nd2_stem": extractor.nd2_stem,
                    "param1": param1,
                    "image_size": image_size,
                    "objective_magnification": objective_magnification,
                    "pixel_size_um": pixel_size_for_objective(objective_magnification),
                },
            }
        )
    except Exception as exc:
        result_queue.put({"ok": False, "error": str(exc)})


def _register_job(job_id: str, process, result_queue) -> None:
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "result": None,
            "error": None,
            "process": process,
            "queue": result_queue,
            "created_at": time(),
            "finished_at": None,
        }


def _finalize_job(
    job_id: str, status: str, result: dict[str, Any] | None, error: str | None
) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = status
        job["result"] = result
        job["error"] = error
        job["finished_at"] = time()
        job["process"] = None
        job["queue"] = None


def _get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def _get_running_jobs_count() -> int:
    with _jobs_lock:
        return sum(1 for job in _jobs.values() if job.get("status") == "running")


def _notify_slack_for_result(result: dict[str, Any]) -> None:
    param1 = result.get("param1")
    image_size = result.get("image_size")
    databases = result.get("databases")

    def _send_database_created(
        db_name: str,
        contour_count: int | None = None,
    ) -> None:
        slack_message = build_database_created_message(
            db_name,
            contour_count=contour_count,
            param1=param1,
            image_size=image_size,
        )
        notify_slack_sync(
            slack_message,
            success_log=("Slack notified for database creation: %s", (db_name,)),
        )

    if isinstance(databases, list):
        for entry in databases:
            db_name = None
            contour_count = None
            if isinstance(entry, dict):
                db_name = entry.get("db_name")
                contour_count = entry.get("contour_count")
            elif isinstance(entry, str):
                db_name = entry
            if db_name:
                _send_database_created(str(db_name), contour_count=contour_count)
        return
    db_name = result.get("db_name") or result.get("database")
    if db_name:
        _send_database_created(str(db_name))


def _watch_extraction_job(job_id: str, process, result_queue) -> None:
    process.join()
    status = "completed"
    result: dict[str, Any] | None = None
    error: str | None = None
    data: dict[str, Any] | None = None
    try:
        data = result_queue.get(timeout=1)
    except std_queue.Empty:
        data = None
    except Exception:
        data = None
        error = "Extraction result missing"

    if data:
        if data.get("ok"):
            result = data.get("result")
        else:
            status = "failed"
            error = data.get("error", "Extraction failed")
    else:
        status = "failed"
        if error is None:
            error = "Extraction result missing"

    if process.exitcode not in (0, None):
        status = "failed"
        if not error or error == "Extraction result missing":
            error = "Extraction process failed"

    if status == "completed" and result:
        try:
            _notify_slack_for_result(result)
        except Exception as exc:
            logger.warning("Slack notification failed: %s", exc)

    _finalize_job(job_id, status, result, error)
    try:
        result_queue.close()
    except Exception:
        pass
    try:
        result_queue.cancel_join_thread()
    except Exception:
        pass
    try:
        process.close()
    except Exception:
        pass


@router_cellextraction.get("/extract-cells/{job_id}")
def get_extract_cells_status(job_id: Annotated[str, ApiPath()]) -> dict[str, Any]:
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    response: dict[str, Any] = {"job_id": job_id, "status": job.get("status", "running")}
    if job.get("status") == "completed":
        response["result"] = job.get("result")
    elif job.get("status") == "failed":
        response["error"] = job.get("error") or "Extraction failed"
    return response


@router_cellextraction.post("/extract-cells", status_code=202)
def extract_cells(payload: ExtractCellsRequest) -> dict[str, Any]:
    sanitized = _sanitize_nd2_filename(payload.filename)
    nd2_path = ND2_DIR / sanitized
    if not nd2_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    mode, reverse_layers = _normalize_layer_mode(payload.layer_mode)
    running_jobs = _get_running_jobs_count()
    max_concurrency = _get_max_concurrency()
    if running_jobs >= max_concurrency:
        raise HTTPException(
            status_code=429,
            detail=(
                "Too many extraction jobs running "
                f"({running_jobs}/{max_concurrency})."
            ),
        )
    ctx = get_context("spawn")
    result_queue = ctx.Queue(maxsize=1)
    process = ctx.Process(
        target=_run_extraction,
        args=(
            str(nd2_path),
            mode,
            payload.param1,
            payload.image_size,
            reverse_layers,
            payload.auto_annotation,
            payload.objective_magnification,
            result_queue,
        ),
    )
    try:
        process.start()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to start extraction") from exc
    job_id = uuid4().hex
    _register_job(job_id, process, result_queue)
    try:
        record_activity_sync(ACTION_CELL_EXTRACTION)
    except Exception as exc:
        logger.warning("Activity tracking failed: %s", exc)
    Thread(
        target=_watch_extraction_job,
        args=(job_id, process, result_queue),
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "running"}
