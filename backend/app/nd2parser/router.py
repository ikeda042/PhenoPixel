import asyncio
import io
import json
import logging
import os
import shutil
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Annotated, Any
from urllib.parse import quote

import nd2reader
import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw, ImageFont


router_nd2parser: APIRouter = APIRouter(tags=["nd2parser"])
logger: logging.Logger = logging.getLogger("uvicorn.error")
ND2_DIR: Path = Path(__file__).resolve().parents[1] / "nd2files"
PARSED_DIR: Path = Path(__file__).resolve().parent / "parsednd2"
SUPPORTED_CHANNELS: list[str] = ["ph", "fluo1", "fluo2"]
META_FILENAME: str = "meta.json"
_PROCESS_POOL: ProcessPoolExecutor | None = None
_PROCESS_POOL_LOCK: Lock = Lock()
_DEFAULT_MAX_WORKERS: int = 4


class ParseNd2Request(BaseModel):
    nd2file: str = Field(..., min_length=1)
    force: bool = False


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


def _attachment_headers(filename: str) -> dict[str, str]:
    content_disposition_filename = quote(filename)
    if content_disposition_filename != filename:
        return {
            "Content-Disposition": (
                f"attachment; filename*=utf-8''{content_disposition_filename}"
            )
        }
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


def _ensure_parsed_dir() -> Path:
    PARSED_DIR.mkdir(parents=True, exist_ok=True)
    return PARSED_DIR


def _get_max_workers() -> int:
    value = os.getenv("ND2PARSER_MAX_WORKERS")
    if value:
        try:
            parsed = int(value)
        except ValueError:
            parsed = _DEFAULT_MAX_WORKERS
        else:
            if parsed < 1:
                parsed = _DEFAULT_MAX_WORKERS
        return parsed
    cpu_count = os.cpu_count() or 1
    return max(1, min(_DEFAULT_MAX_WORKERS, cpu_count))


def _get_process_pool() -> ProcessPoolExecutor:
    global _PROCESS_POOL
    if _PROCESS_POOL is None:
        with _PROCESS_POOL_LOCK:
            if _PROCESS_POOL is None:
                _PROCESS_POOL = ProcessPoolExecutor(max_workers=_get_max_workers())
    return _PROCESS_POOL


async def _run_in_process_pool(func, *args) -> Any:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_get_process_pool(), func, *args)


def _normalize_to_uint8(array: np.ndarray) -> np.ndarray:
    if array.dtype == np.uint8:
        return array
    float_arr = array.astype(np.float32)
    min_val = float(float_arr.min())
    max_val = float(float_arr.max())
    if max_val <= min_val:
        return np.zeros_like(float_arr, dtype=np.uint8)
    scaled = (float_arr - min_val) / (max_val - min_val) * 255.0
    return scaled.astype(np.uint8)


def _scale_to_uint8(array: np.ndarray) -> np.ndarray:
    if array.dtype == np.uint8:
        return array
    if np.issubdtype(array.dtype, np.integer):
        info = np.iinfo(array.dtype)
        range_val = float(info.max - info.min)
        if range_val <= 0:
            return np.zeros_like(array, dtype=np.uint8)
        scaled = (array.astype(np.float32) - float(info.min)) / range_val * 255.0
        return np.clip(scaled, 0, 255).astype(np.uint8)
    if np.issubdtype(array.dtype, np.floating):
        max_val = float(np.nanmax(array))
        min_val = float(np.nanmin(array))
        if max_val <= 1.0 and min_val >= 0.0:
            scaled = array * 255.0
            return np.clip(scaled, 0, 255).astype(np.uint8)
        scale_max = _infer_scale_max(max_val)
        if scale_max <= 0:
            return np.zeros_like(array, dtype=np.uint8)
        scaled = array.astype(np.float32) / scale_max * 255.0
        return np.clip(scaled, 0, 255).astype(np.uint8)
    return _normalize_to_uint8(array)


def _infer_scale_max(max_val: float) -> float:
    candidates = [255.0, 1023.0, 4095.0, 16383.0, 65535.0]
    for candidate in candidates:
        if max_val <= candidate:
            return candidate
    return max_val


def _apply_channel_color(gray: np.ndarray, channel: str | None) -> np.ndarray:
    if channel == "fluo1":
        rgb = np.zeros((*gray.shape, 3), dtype=np.uint8)
        rgb[:, :, 1] = gray
        return rgb
    if channel == "fluo2":
        rgb = np.zeros((*gray.shape, 3), dtype=np.uint8)
        rgb[:, :, 0] = gray
        return rgb
    return gray


def _apply_brightness(array: np.ndarray, multiplier: float) -> np.ndarray:
    if not np.isfinite(multiplier) or multiplier <= 0:
        return array
    if multiplier == 1:
        return array
    scaled = array.astype(np.float32) * float(multiplier)
    return np.clip(scaled, 0, 255).astype(np.uint8)


def _normalize_mode(mode: str | None) -> str:
    normalized = (mode or "").strip().lower()
    if normalized in {"", "none", "off"}:
        return "none"
    if normalized in {"optical-boost", "optical_boost", "opticalboost"}:
        return "optical-boost"
    raise ValueError("Invalid mode")


def _should_optical_boost(mode: str, channel: str | None) -> bool:
    return mode == "optical-boost" and channel in {"fluo1", "fluo2"}


def _to_uint8_for_mode(array: np.ndarray, mode: str, channel: str | None) -> np.ndarray:
    if _should_optical_boost(mode, channel):
        return _normalize_to_uint8(array)
    return _scale_to_uint8(array)


def _compute_crop_box(
    center_x: int,
    center_y: int,
    grid_size: int,
    width: int,
    height: int,
) -> tuple[int, int, int, int, int]:
    safe_size = max(1, min(int(grid_size), int(width), int(height)))
    half = safe_size // 2
    left = int(center_x) - half
    top = int(center_y) - half
    right = left + safe_size
    bottom = top + safe_size
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > width:
        left -= right - width
        right = width
    if bottom > height:
        top -= bottom - height
        bottom = height
    left = max(left, 0)
    top = max(top, 0)
    return left, top, right, bottom, safe_size


def _prepare_channel_crop(
    file_path: Path,
    channel: str,
    crop_box: tuple[int, int, int, int],
    grid_size: int,
    mode: str,
    brightness: float,
) -> np.ndarray:
    with Image.open(file_path) as img:
        array = np.squeeze(np.array(img))
    if array.ndim != 2:
        array = np.squeeze(array)
        if array.ndim != 2:
            array = array[..., 0]
    left, top, right, bottom = crop_box
    crop = array[top:bottom, left:right]
    if crop.shape[0] != grid_size or crop.shape[1] != grid_size:
        padded = np.zeros((grid_size, grid_size), dtype=crop.dtype)
        height = min(grid_size, crop.shape[0])
        width = min(grid_size, crop.shape[1])
        padded[:height, :width] = crop[:height, :width]
        crop = padded
    gray = _to_uint8_for_mode(crop, mode, channel)
    gray = _apply_brightness(gray, brightness)
    if channel == "ph":
        return np.stack([gray, gray, gray], axis=-1)
    return _apply_channel_color(gray, channel)


def _draw_scale_bar(image: Image.Image) -> Image.Image:
    pixel_size_um = 0.065
    scale_bar_um = 5.0
    scale_bar_length_px = max(1, int(round(scale_bar_um / pixel_size_um)))
    thickness = 2
    margin = max(6, min(20, image.width // 10, image.height // 10))
    spacing = 4

    if scale_bar_length_px + margin * 2 >= image.width:
        scale_bar_length_px = max(1, image.width - margin * 2 - 1)

    x2 = image.width - margin - 1
    y2 = image.height - margin - 1
    x1 = max(0, x2 - scale_bar_length_px + 1)
    y1 = max(0, y2 - thickness + 1)

    draw = ImageDraw.Draw(image)
    draw.rectangle([x1, y1, x2, y2], fill=(255, 255, 255))

    text = f"{int(scale_bar_um)} um"
    font = ImageFont.load_default()
    try:
        text_box = draw.textbbox((0, 0), text, font=font)
        text_width = text_box[2] - text_box[0]
        text_height = text_box[3] - text_box[1]
    except AttributeError:
        text_width, text_height = draw.textsize(text, font=font)

    text_x = x1 + max(0, (scale_bar_length_px - text_width) // 2)
    text_y = y1 - spacing - text_height
    if text_y < 0:
        text_y = y2 + spacing
    if text_y + text_height < image.height:
        draw.text(
            (text_x, text_y),
            text,
            fill=(255, 255, 255),
            font=font,
            stroke_width=1,
            stroke_fill=(0, 0, 0),
        )
    return image


def _export_region_png(
    output_dir: str,
    meta: dict,
    frame: int,
    center_x: int,
    center_y: int,
    grid_size: int,
    mode: str,
    brightness: float,
) -> bytes:
    normalized_mode = _normalize_mode(mode)
    channels = meta.get("channels", [])
    if not isinstance(channels, list):
        channels = []
    available_channels = [channel for channel in SUPPORTED_CHANNELS if channel in channels]
    if not available_channels:
        raise ValueError("No channels available")
    width = int(meta.get("width") or 0)
    height = int(meta.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ValueError("Image metadata is missing")
    frame_basename = _get_frame_basename(meta, frame)
    left, top, right, bottom, safe_size = _compute_crop_box(
        center_x, center_y, grid_size, width, height
    )
    crops: list[np.ndarray] = []
    for channel in available_channels:
        file_path = Path(output_dir) / channel / f"{frame_basename}.tif"
        if not file_path.is_file():
            raise FileNotFoundError(f"Missing frame for {channel}")
        crops.append(
            _prepare_channel_crop(
                file_path,
                channel,
                (left, top, right, bottom),
                safe_size,
                normalized_mode,
                brightness,
            )
        )
    combined = np.concatenate(crops, axis=1)
    buffer = io.BytesIO()
    image = Image.fromarray(combined)
    _draw_scale_bar(image)
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer.read()


def _tiff_to_png_bytes(
    path: str | Path,
    channel: str | None = None,
    mode: str | None = None,
    brightness: float = 1.0,
) -> bytes:
    file_path = Path(path)
    normalized_mode = _normalize_mode(mode)
    with Image.open(file_path) as img:
        array = np.array(img)
    array = np.squeeze(array)
    if array.ndim == 2:
        gray = _to_uint8_for_mode(array, normalized_mode, channel)
        gray = _apply_brightness(gray, brightness)
        colorized = _apply_channel_color(gray, channel)
        png_img = Image.fromarray(colorized)
    else:
        if array.dtype != np.uint8:
            array = _to_uint8_for_mode(array, normalized_mode, channel)
        array = _apply_brightness(array, brightness)
        png_img = Image.fromarray(array)
    buffer = io.BytesIO()
    png_img.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer.read()


def _get_output_dir(sanitized_filename: str) -> Path:
    stem = Path(sanitized_filename).stem
    return _ensure_parsed_dir() / stem


def _load_metadata(output_dir: Path) -> dict:
    meta_path = output_dir / META_FILENAME
    if not meta_path.is_file():
        raise HTTPException(status_code=404, detail="Parsed data not found")
    try:
        with meta_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Metadata is corrupted") from exc


def _write_metadata(output_dir: Path, meta: dict) -> dict:
    meta_path = output_dir / META_FILENAME
    with meta_path.open("w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=True, indent=2)
    return meta


def _map_channels(num_channels: int) -> list[str]:
    count = max(1, min(num_channels, len(SUPPORTED_CHANNELS)))
    return SUPPORTED_CHANNELS[:count]


def _clear_output_dir(output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)


def _get_iter_axes(axes: str, bundle_axes: str) -> str:
    return "".join(axis for axis in axes if axis not in bundle_axes)


def _frame_index_width(total_frames: int) -> int:
    return max(1, len(str(max(total_frames - 1, 0))))


def _get_frame_coords(
    iter_axes: str, sizes: dict[str, int], frame_idx: int
) -> dict[str, int]:
    coords: dict[str, int] = {}
    remainder = frame_idx
    for axis in reversed(iter_axes):
        axis_size = int(sizes.get(axis, 1))
        if axis_size < 1:
            axis_size = 1
        coords[axis] = remainder % axis_size
        remainder //= axis_size
    return coords


def _format_axis_index(axis: str, index: int, size: int) -> str:
    width = max(1, len(str(max(size - 1, 0))))
    return f"{axis}{index:0{width}d}"


def _format_frame_filename(
    frame_idx: int,
    iter_axes: str,
    sizes: dict[str, int],
    frame_index_width: int,
) -> str:
    prefix = f"f{frame_idx:0{frame_index_width}d}"
    if not iter_axes:
        return prefix
    coords = _get_frame_coords(iter_axes, sizes, frame_idx)
    parts = [
        _format_axis_index(axis, coords.get(axis, 0), int(sizes.get(axis, 1)))
        for axis in iter_axes
    ]
    return f"{prefix}_{'_'.join(parts)}"


def _get_frame_basename(meta: dict, frame_idx: int) -> str:
    if "frame_index_width" not in meta:
        return str(frame_idx)
    frame_index_width = int(meta.get("frame_index_width") or 1)
    iter_axes = str(meta.get("iter_axes") or "")
    sizes = meta.get("sizes")
    size_map: dict[str, int] = {}
    if isinstance(sizes, dict):
        for axis, size in sizes.items():
            try:
                size_map[str(axis)] = int(size)
            except (TypeError, ValueError):
                size_map[str(axis)] = 1
    return _format_frame_filename(frame_idx, iter_axes, size_map, frame_index_width)


def _parse_nd2_file(nd2_path: str | Path, output_dir: str | Path) -> dict:
    nd2_path = Path(nd2_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    with nd2reader.ND2Reader(str(nd2_path)) as images:
        axes = images.axes
        bundle_axes = "cyx" if "c" in axes else "yx"
        images.bundle_axes = bundle_axes
        iter_axes = _get_iter_axes(axes, bundle_axes)
        images.iter_axes = iter_axes
        sizes = {axis: int(size) for axis, size in images.sizes.items()}
        logger.info("ND2 axes: %s", axes)
        logger.info("ND2 sizes: %s", images.sizes)
        logger.info("ND2 shape: %s", getattr(images, "shape", None))
        logger.info("ND2 bundle_axes: %s", bundle_axes)
        logger.info("ND2 iter_axes: %s", iter_axes)
        detected_channels = max(int(images.sizes.get("c", 1)), 1)
        channels = _map_channels(detected_channels)
        if detected_channels > len(channels):
            logger.warning(
                "ND2 file %s has %s channels; parsing first %s only.",
                nd2_path.name,
                detected_channels,
                len(channels),
            )
        for channel in channels:
            (output_dir / channel).mkdir(parents=True, exist_ok=True)

        total_frames = len(images)
        frame_index_width = _frame_index_width(total_frames)
        frames_processed = 0
        width = height = None
        for frame_idx in range(total_frames):
            try:
                frame = images[frame_idx]
            except KeyError as exc:
                logger.warning("Failed to read frame %s: %s", frame_idx, exc)
                break
            if frame_idx == 0:
                logger.info("ND2 frame[0] shape: %s", np.asarray(frame).shape)
            frame_basename = _format_frame_filename(
                frame_idx, iter_axes, sizes, frame_index_width
            )
            if len(channels) > 1:
                for channel_idx, channel in enumerate(channels):
                    array = np.asarray(frame[channel_idx])
                    array = np.squeeze(array)
                    if width is None or height is None:
                        height, width = array.shape[:2]
                    Image.fromarray(array).save(
                        output_dir / channel / f"{frame_basename}.tif"
                    )
            else:
                array = np.asarray(frame)
                array = np.squeeze(array)
                if width is None or height is None:
                    height, width = array.shape[:2]
                Image.fromarray(array).save(
                    output_dir / channels[0] / f"{frame_basename}.tif"
                )
            frames_processed += 1

    if frames_processed == 0:
        raise HTTPException(status_code=500, detail="No frames were parsed")
    meta = {
        "nd2file": nd2_path.name,
        "nd2_stem": nd2_path.stem,
        "channels": channels,
        "frames": frames_processed,
        "width": width,
        "height": height,
        "axes": axes,
        "bundle_axes": bundle_axes,
        "iter_axes": iter_axes,
        "sizes": sizes,
        "frame_index_width": frame_index_width,
        "detected_channels": detected_channels,
    }
    return _write_metadata(output_dir, meta)


@router_nd2parser.post("/nd2parser/parse")
async def parse_nd2(payload: ParseNd2Request) -> JSONResponse:
    sanitized = _sanitize_nd2_filename(payload.nd2file)
    nd2_path = ND2_DIR / sanitized
    if not nd2_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    output_dir = _get_output_dir(sanitized)
    meta_path = output_dir / META_FILENAME
    if meta_path.is_file() and not payload.force:
        return JSONResponse(content=_load_metadata(output_dir))
    if payload.force:
        _clear_output_dir(output_dir)
    try:
        meta = await _run_in_process_pool(
            _parse_nd2_file, str(nd2_path), str(output_dir)
        )
    except Exception as exc:
        logger.exception("ND2 parse failed: %s", exc)
        raise HTTPException(status_code=500, detail="ND2 parse failed") from exc
    return JSONResponse(content=meta)


@router_nd2parser.get("/nd2parser/metadata")
def get_nd2_metadata(nd2file: Annotated[str, Query()] = ...) -> JSONResponse:
    sanitized = _sanitize_nd2_filename(nd2file)
    output_dir = _get_output_dir(sanitized)
    return JSONResponse(content=_load_metadata(output_dir))


@router_nd2parser.get("/nd2parser/image")
async def get_nd2_image(
    nd2file: Annotated[str, Query()] = ...,
    channel: Annotated[str, Query()] = ...,
    frame: Annotated[int, Query(ge=0)] = ...,
    mode: Annotated[str, Query()] = "none",
    brightness: Annotated[float, Query(gt=0)] = 1.0,
) -> StreamingResponse:
    sanitized = _sanitize_nd2_filename(nd2file)
    output_dir = _get_output_dir(sanitized)
    meta = _load_metadata(output_dir)
    normalized_channel = (channel or "").strip().lower()
    if normalized_channel not in meta.get("channels", []):
        raise HTTPException(status_code=404, detail="Channel not found")
    total_frames = int(meta.get("frames", 0))
    if frame >= total_frames:
        raise HTTPException(status_code=404, detail="Frame not found")
    frame_basename = _get_frame_basename(meta, frame)
    file_path = output_dir / normalized_channel / f"{frame_basename}.tif"
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    try:
        png_bytes = await _run_in_process_pool(
            _tiff_to_png_bytes, str(file_path), normalized_channel, mode, brightness
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("ND2 image conversion failed: %s", exc)
        raise HTTPException(status_code=500, detail="Image conversion failed") from exc
    return StreamingResponse(io.BytesIO(png_bytes), media_type="image/png")


@router_nd2parser.get("/nd2parser/export-region")
async def export_nd2_region(
    nd2file: Annotated[str, Query()] = ...,
    frame: Annotated[int, Query(ge=0)] = ...,
    grid_size: Annotated[int, Query(gt=0)] = ...,
    center_x: Annotated[int, Query()] = ...,
    center_y: Annotated[int, Query()] = ...,
    mode: Annotated[str, Query()] = "none",
    brightness: Annotated[float, Query(gt=0)] = 1.0,
) -> StreamingResponse:
    sanitized = _sanitize_nd2_filename(nd2file)
    output_dir = _get_output_dir(sanitized)
    meta = _load_metadata(output_dir)
    total_frames = int(meta.get("frames", 0))
    if frame >= total_frames:
        raise HTTPException(status_code=404, detail="Frame not found")
    try:
        png_bytes = await _run_in_process_pool(
            _export_region_png,
            str(output_dir),
            meta,
            frame,
            center_x,
            center_y,
            grid_size,
            mode,
            brightness,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("ND2 export failed: %s", exc)
        raise HTTPException(status_code=500, detail="Export failed") from exc
    filename = f"{Path(sanitized).stem}_frame{frame}_crop.png"
    headers = _attachment_headers(filename)
    return StreamingResponse(io.BytesIO(png_bytes), media_type="image/png", headers=headers)
