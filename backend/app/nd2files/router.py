import os
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Annotated, Any

import aiofiles
import nd2reader
import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile, Path as ApiPath
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

router_nd2: APIRouter = APIRouter(tags=["nd2files"])
UPLOAD_DIR: Path = Path(__file__).resolve().parent
UPLOAD_CHUNK_SIZE: int = 1024 * 1024 * 200
DOWNLOAD_CHUNK_SIZE: int = 1024 * 1024 * 200


class Nd2BulkDeleteRequest(BaseModel):
    filenames: list[str]


def _ensure_upload_dir() -> Path:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return UPLOAD_DIR


def _list_nd2_files(upload_dir: Path) -> list[str]:
    if not upload_dir.is_dir():
        return []
    return sorted(
        [
            entry.name
            for entry in upload_dir.iterdir()
            if entry.is_file()
            and entry.name.endswith(".nd2")
            and not entry.name.endswith("timelapse.nd2")
        ]
    )


def _sanitize_nd2_filename(filename: str) -> str:
    cleaned = os.path.basename(filename or "")
    if not cleaned:
        raise HTTPException(status_code=400, detail="Filename is required")
    base, ext = os.path.splitext(cleaned)
    if not base:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if ext.lower() != ".nd2":
        raise HTTPException(status_code=400, detail="Only .nd2 files are supported")
    base = base.replace(".", "p")
    return f"{base}.nd2"


def _to_jsonable(value: Any, depth: int = 0, max_depth: int = 6) -> Any:
    if depth > max_depth:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, dict):
        return {str(key): _to_jsonable(val, depth + 1, max_depth) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item, depth + 1, max_depth) for item in value]
    if isinstance(value, np.ndarray):
        return _to_jsonable(value.tolist(), depth + 1, max_depth)
    if isinstance(value, np.generic):
        return _to_jsonable(value.item(), depth + 1, max_depth)
    return str(value)


_DATETIME_FORMATS: tuple[str, ...] = (
    "%m/%d/%Y  %H:%M:%S",
    "%m/%d/%Y  %I:%M:%S %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
    "%d/%m/%Y %H:%M:%S",
    "%Y/%m/%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
)
_DATETIME_REGEX: re.Pattern[str] = re.compile(
    r"(?:\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}[-/]\d{2}[-/]\d{4}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?: ?[AP]M)?)"
)


def _parse_datetime_string(value: str) -> datetime | None:
    if not value:
        return None
    trimmed = value.strip()
    try:
        return datetime.fromisoformat(trimmed)
    except ValueError:
        pass
    for fmt in _DATETIME_FORMATS:
        try:
            return datetime.strptime(trimmed, fmt)
        except ValueError:
            continue
    return None


def _extract_text_lines(text_info: Any) -> list[str]:
    if not text_info:
        return []
    if isinstance(text_info, dict):
        values = text_info.values()
    elif isinstance(text_info, (list, tuple, set)):
        values = text_info
    else:
        values = [text_info]
    lines: list[str] = []
    for value in values:
        if isinstance(value, bytes):
            try:
                text = value.decode("utf-8")
            except UnicodeDecodeError:
                continue
        else:
            text = str(value)
        text = text.strip()
        if text:
            lines.append(text)
    return lines


def _parse_datetime_from_lines(lines: list[str]) -> datetime | None:
    for line in lines:
        parsed = _parse_datetime_string(line)
        if parsed:
            return parsed
        for match in _DATETIME_REGEX.finditer(line):
            parsed = _parse_datetime_string(match.group(0))
            if parsed:
                return parsed
    return None


def _safe_raw_metadata(raw_metadata: Any, attr: str) -> Any:
    try:
        return getattr(raw_metadata, attr)
    except Exception:
        return None


def _materialize_iterable(value: Any) -> Any:
    if value is None or isinstance(value, (str, bytes, dict, list, tuple, set, np.ndarray)):
        return value
    if isinstance(value, np.generic):
        return value.item()
    try:
        return list(value)
    except TypeError:
        return value


def _extract_nd2_metadata(file_path: Path) -> dict[str, Any]:
    stats = file_path.stat()
    created_ts = getattr(stats, "st_birthtime", None)
    if created_ts is None:
        created_ts = stats.st_ctime
    with nd2reader.ND2Reader(str(file_path)) as images:
        raw_metadata = getattr(images.parser, "_raw_metadata", None)
        raw_text_info = (
            _safe_raw_metadata(raw_metadata, "image_text_info")
            if raw_metadata is not None
            else None
        )
        text_lines = _extract_text_lines(raw_text_info)
        nd2_created = None
        try:
            nd2_created = images.metadata.get("date")
        except Exception:
            nd2_created = None
        start_time = None
        start_time_dt = None
        start_time_source = None
        if isinstance(nd2_created, datetime):
            start_time = nd2_created
            start_time_dt = nd2_created
            start_time_source = "metadata.date"
        elif isinstance(nd2_created, str) and nd2_created:
            parsed = _parse_datetime_string(nd2_created)
            if parsed:
                start_time = parsed
                start_time_dt = parsed
            else:
                start_time = nd2_created
            start_time_source = "metadata.date"
        if start_time is None:
            parsed = _parse_datetime_from_lines(text_lines)
            if parsed:
                start_time = parsed
                start_time_dt = parsed
                start_time_source = "text_info"
        if start_time is not None:
            created_time = start_time
            created_time_source = (
                "nd2_metadata" if start_time_source == "metadata.date" else "nd2_text_info"
            )
        else:
            created_time = datetime.fromtimestamp(created_ts)
            created_time_source = "filesystem"
        reader_info: dict[str, Any] = {
            "axes": getattr(images, "axes", None),
            "sizes": dict(getattr(images, "sizes", {}) or {}),
            "bundle_axes": getattr(images, "bundle_axes", None),
            "iter_axes": getattr(images, "iter_axes", None),
            "default_coords": getattr(images, "default_coords", None),
            "ndim": getattr(images, "ndim", None),
            "shape": getattr(images, "shape", None),
            "dtype": str(images.pixel_type) if getattr(images, "pixel_type", None) else None,
        }
        try:
            reader_info["num_frames"] = len(images)
        except Exception:
            reader_info["num_frames"] = None
        try:
            reader_info["frame_rate_fps"] = float(images.frame_rate)
        except Exception:
            reader_info["frame_rate_fps"] = None
        timesteps_ms = None
        try:
            timesteps_ms = images.timesteps
        except Exception:
            timesteps_ms = None
        reader_info["timesteps_ms"] = timesteps_ms
        try:
            reader_info["parser_supported"] = bool(images.parser.supported)
        except Exception:
            reader_info["parser_supported"] = None
        events = None
        try:
            events = images.events
        except Exception:
            events = None
        frame_timestamps = None
        if start_time_dt is not None and timesteps_ms is not None:
            try:
                frame_timestamps = [
                    (start_time_dt + timedelta(milliseconds=float(ms))).isoformat()
                    for ms in list(timesteps_ms)
                ]
            except Exception:
                frame_timestamps = None
        raw_metadata_details: dict[str, Any] | None = None
        if raw_metadata is not None:
            raw_metadata_details = {}
            raw_metadata_details["image_text_info"] = raw_text_info
            for attr in (
                "app_info",
                "camera_exposure_time",
                "camera_temp",
                "custom_data",
                "grabber_settings",
                "image_attributes",
                "image_calibration",
                "image_events",
                "image_metadata",
                "image_metadata_sequence",
                "lut_data",
                "pfs_offset",
                "pfs_status",
                "roi_metadata",
                "x_data",
                "y_data",
                "z_data",
            ):
                value = _safe_raw_metadata(raw_metadata, attr)
                if value is not None:
                    raw_metadata_details[attr] = _materialize_iterable(value)
            acquisition_times = _safe_raw_metadata(raw_metadata, "acquisition_times")
            if acquisition_times is not None:
                raw_metadata_details["acquisition_times_s"] = list(acquisition_times)
        payload: dict[str, Any] = {
            "file": {
                "name": file_path.name,
                "size_bytes": int(stats.st_size),
                "modified_time": datetime.fromtimestamp(stats.st_mtime).isoformat(),
                "created_time": created_time,
                "created_time_source": created_time_source,
            },
            "acquisition": {
                "start_time": start_time,
                "start_time_source": start_time_source,
                "timesteps_ms": timesteps_ms,
                "frame_timestamps": frame_timestamps,
                "events": events,
            },
            "reader": reader_info,
            "metadata": getattr(images, "metadata", None),
        }
        if raw_metadata_details:
            payload["raw_metadata"] = raw_metadata_details
    return _to_jsonable(payload)


@router_nd2.post("/nd2_files")
async def upload_nd2_file(
    file: Annotated[UploadFile, File()] = ...
) -> JSONResponse:
    sanitized = _sanitize_nd2_filename(file.filename or "")
    file_path = _ensure_upload_dir() / sanitized
    try:
        async with aiofiles.open(file_path, "wb") as out_file:
            while content := await file.read(UPLOAD_CHUNK_SIZE):
                await out_file.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return JSONResponse(content={"filename": sanitized})


@router_nd2.get("/nd2_files")
async def get_nd2_files() -> JSONResponse:
    upload_dir = _ensure_upload_dir()
    return JSONResponse(content={"files": _list_nd2_files(upload_dir)})


@router_nd2.delete("/nd2_files/{filename}")
def delete_nd2_file(filename: Annotated[str, ApiPath()]) -> JSONResponse:
    sanitized = _sanitize_nd2_filename(filename)
    file_path = _ensure_upload_dir() / sanitized
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        file_path.unlink()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return JSONResponse(content={"deleted": True, "filename": sanitized})


@router_nd2.post("/nd2_files/bulk-delete")
def bulk_delete_nd2_files(payload: Nd2BulkDeleteRequest) -> JSONResponse:
    if not payload.filenames:
        raise HTTPException(status_code=400, detail="No filenames provided")

    upload_dir = _ensure_upload_dir()
    deleted: list[str] = []
    missing: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()

    for filename in payload.filenames:
        if filename in seen:
            continue
        seen.add(filename)
        try:
            sanitized = _sanitize_nd2_filename(filename)
        except HTTPException:
            invalid.append(filename)
            continue
        file_path = upload_dir / sanitized
        if not file_path.exists():
            missing.append(sanitized)
            continue
        try:
            file_path.unlink()
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        deleted.append(sanitized)

    return JSONResponse(
        content={"deleted": deleted, "missing": missing, "invalid": invalid}
    )


@router_nd2.get("/nd2_files/{filename}/download")
async def download_nd2_file(filename: Annotated[str, ApiPath()]) -> FileResponse:
    sanitized = _sanitize_nd2_filename(filename)
    file_path = _ensure_upload_dir() / sanitized
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    response = FileResponse(
        file_path,
        media_type="application/octet-stream",
        filename=sanitized,
    )
    response.chunk_size = DOWNLOAD_CHUNK_SIZE
    return response


@router_nd2.get("/nd2_files/{filename}/metadata")
def get_nd2_file_metadata(filename: Annotated[str, ApiPath()]) -> JSONResponse:
    sanitized = _sanitize_nd2_filename(filename)
    file_path = _ensure_upload_dir() / sanitized
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        metadata = _extract_nd2_metadata(file_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return JSONResponse(content=metadata)
