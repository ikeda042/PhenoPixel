from __future__ import annotations

import json
import logging
import math
import shutil
import tempfile
import time
from dataclasses import asdict, dataclass
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import cv2
import numpy as np

from app.mother_machine.database import create_cells_database
from app.mother_machine.storage import (
    DATABASES_DIR,
    database_path,
    dataset_key,
    ensure_directories,
    replace_dataset,
)


LOGGER = logging.getLogger("uvicorn.error")
CONFIG_PATH = Path(__file__).resolve().parent / "channel_config.json"
MODEL_NAME = "cpsam_v2"
DEFAULT_NITER = 500
MASK_COLOR_RGB = np.array([173, 255, 47], dtype=np.uint8)
ProgressCallback = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class ChannelRoi:
    channel_id: int
    x0: int
    y0: int
    x1: int
    y1: int


@dataclass(frozen=True)
class CellFilter:
    side_margin: int = 6
    minimum_area: int = 80
    maximum_area: int = 1800
    minimum_minor_axis: float = 5.0
    maximum_minor_axis: float = 36.0
    minimum_major_axis: float = 14.0
    maximum_major_axis: float = 115.0
    minimum_elongation: float = 1.25
    maximum_elongation: float = 8.0
    maximum_mean_intensity: float = 145.0
    maximum_minimum_intensity: float = 255.0
    minimum_local_contrast: float = 8.0
    minimum_right_edge_fraction: float = 0.0
    minimum_channel_containment_fraction: float = 0.0
    exclude_top_boundary: bool = False
    exclude_bottom_boundary: bool = False
    exclude_bottom_boundary_channels: tuple[int, ...] = ()
    bottom_boundary_margin: int = 0
    temporal_recovery: bool = False
    temporal_dilation_radius: int = 8
    temporal_minimum_overlap_fraction: float = 0.12
    temporal_filter_scale: float = 1.6
    temporal_intensity_margin: float = 40.0
    temporal_contrast_scale: float = 0.5


def inspect_nd2(path: Path) -> dict[str, Any]:
    """Read only the dimensions needed by the manager and review UI."""

    try:
        import nd2

        with nd2.ND2File(path) as images:
            sizes = {str(key): int(value) for key, value in images.sizes.items()}
            return {
                "field_count": int(sizes.get("P", 1)),
                "timeframe_count": int(sizes.get("T", 1)),
                "width": int(sizes.get("X", 0)),
                "height": int(sizes.get("Y", 0)),
                "sizes": sizes,
                "dtype": str(images.dtype),
            }
    except ImportError:
        from nd2reader import ND2Reader

        with ND2Reader(str(path)) as images:
            sizes = {str(key): int(value) for key, value in images.sizes.items()}
            return {
                "field_count": int(sizes.get("v", 1)),
                "timeframe_count": int(sizes.get("t", 1)),
                "width": int(sizes.get("x", 0)),
                "height": int(sizes.get("y", 0)),
                "sizes": sizes,
                "dtype": str(images.pixel_type),
            }


def to_uint8(image: np.ndarray, input_max: float = 65535.0) -> np.ndarray:
    clipped = np.clip(image, 0, input_max).astype(np.float32)
    return np.rint(clipped * (255.0 / input_max)).astype(np.uint8)


def _smooth_profile(profile: np.ndarray, sigma: float) -> np.ndarray:
    sigma = max(float(sigma), 0.1)
    try:
        from scipy.ndimage import gaussian_filter1d

        return gaussian_filter1d(
            np.asarray(profile, dtype=np.float32), sigma=sigma
        )
    except ImportError:
        # The lightweight development environment does not require SciPy;
        # Cellpose installs it in the extraction worker environment.
        pass
    kernel_size = max(3, int(math.ceil(sigma * 6.0)) | 1)
    row = np.asarray(profile, dtype=np.float32).reshape(1, -1)
    return cv2.GaussianBlur(row, (kernel_size, 1), sigmaX=sigma).reshape(-1)


def wall_profile(image: np.ndarray, vertical_shift: int = 0) -> np.ndarray:
    height, width = image.shape
    band_y0 = int(round(height * 650 / 2044)) + vertical_shift
    band_y1 = int(round(height * 1000 / 2044)) + vertical_shift
    band_y0 = max(0, min(band_y0, height - 2))
    band_y1 = max(band_y0 + 1, min(band_y1, height))
    profile = np.percentile(image[band_y0:band_y1], 90, axis=0)
    return _smooth_profile(profile, max(2.0, width * 8 / 2048))


def vertical_edge_profile(image: np.ndarray) -> np.ndarray:
    smoothed = cv2.GaussianBlur(image, (0, 0), 3)
    gradient_y = cv2.Sobel(smoothed, cv2.CV_32F, 0, 1, ksize=3)
    profile = np.mean(np.abs(gradient_y), axis=1)
    return _smooth_profile(profile, 2.0)


def best_profile_shift(
    reference: np.ndarray,
    current: np.ndarray,
    start: int,
    stop: int,
    max_shift: int,
) -> int:
    margin = max_shift + 2
    start = max(start, margin)
    stop = min(stop, len(reference) - margin)
    if stop <= start:
        raise ValueError("Profile comparison window is empty")
    reference_slice = reference[start:stop]
    reference_slice = (reference_slice - reference_slice.mean()) / (
        reference_slice.std() + 1e-6
    )
    scores: list[float] = []
    for shift in range(-max_shift, max_shift + 1):
        current_slice = current[start + shift : stop + shift]
        current_slice = (current_slice - current_slice.mean()) / (
            current_slice.std() + 1e-6
        )
        scores.append(float(np.mean(reference_slice * current_slice)))
    return int(np.argmax(scores) - max_shift)


def _load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def load_view_config(
    payload: dict[str, Any],
    view_index: int,
    image_shape: tuple[int, int],
) -> tuple[list[ChannelRoi], CellFilter, str] | None:
    view_config = payload.get("views", {}).get(str(view_index))
    if not isinstance(view_config, dict):
        return None
    reference_width = int(payload.get("reference_width", image_shape[1]))
    reference_height = int(payload.get("reference_height", image_shape[0]))
    scale_x = image_shape[1] / reference_width
    scale_y = image_shape[0] / reference_height
    channels = [
        ChannelRoi(
            channel_id=channel_id,
            x0=int(round(float(definition["x0"]) * scale_x)),
            y0=int(round(float(definition["y0"]) * scale_y)),
            x1=int(round(float(definition["x1"]) * scale_x)),
            y1=int(round(float(definition["y1"]) * scale_y)),
        )
        for channel_id, definition in enumerate(view_config.get("channels", []), 1)
    ]
    if not channels:
        return None
    filter_values = dict(view_config.get("segmentation", {}))
    if "exclude_bottom_boundary_channels" in filter_values:
        filter_values["exclude_bottom_boundary_channels"] = tuple(
            int(value) for value in filter_values["exclude_bottom_boundary_channels"]
        )
    return (
        channels,
        CellFilter(**filter_values),
        str(view_config.get("description", "Configured mother-machine channels")),
    )


def shifted_channels(
    reference_channels: list[ChannelRoi],
    image_shape: tuple[int, int],
    horizontal_shift: int,
    vertical_shift: int,
) -> list[ChannelRoi]:
    height, width = image_shape
    shifted: list[ChannelRoi] = []
    for reference in reference_channels:
        channel = ChannelRoi(
            channel_id=reference.channel_id,
            x0=max(0, min(width, reference.x0 + horizontal_shift)),
            y0=max(0, min(height, reference.y0 + vertical_shift)),
            x1=max(0, min(width, reference.x1 + horizontal_shift)),
            y1=max(0, min(height, reference.y1 + vertical_shift)),
        )
        if channel.x1 <= channel.x0 or channel.y1 <= channel.y0:
            raise ValueError(f"Shifted channel is outside the frame: {channel}")
        shifted.append(channel)
    return shifted


def channels_by_band(channels: list[ChannelRoi]) -> list[list[ChannelRoi]]:
    groups: dict[tuple[int, int], list[ChannelRoi]] = {}
    for channel in channels:
        groups.setdefault((channel.y0, channel.y1), []).append(channel)
    return [groups[key] for key in sorted(groups)]


def _segment_band(
    model: Any,
    band: np.ndarray,
    niter: int = DEFAULT_NITER,
) -> np.ndarray:
    mask, _flows, _styles = model.eval(
        band,
        normalize=True,
        diameter=None,
        flow_threshold=0.0,
        cellprob_threshold=0.0,
        min_size=20,
        niter=niter,
    )
    return np.asarray(mask, dtype=np.int32)


def extract_channel_cells(
    band_mask: np.ndarray,
    image: np.ndarray,
    band_y0: int,
    channel: ChannelRoi,
    cell_filter: CellFilter,
    temporal_support: np.ndarray | None = None,
    temporal_labels: np.ndarray | None = None,
) -> tuple[np.ndarray, set[int]]:
    channel_height = channel.y1 - channel.y0
    channel_width = channel.x1 - channel.x0
    output = np.zeros((channel_height, channel_width), dtype=np.uint16)
    margin = min(cell_filter.side_margin, max(0, (channel_width - 1) // 2))
    core_x0 = channel.x0 + margin
    core_x1 = channel.x1 - margin
    if core_x1 <= core_x0:
        raise ValueError(f"Channel {channel.channel_id} is too narrow for its margin")
    band_local_y0 = channel.y0 - band_y0
    band_local_y1 = channel.y1 - band_y0
    candidate_mask = band_mask[band_local_y0:band_local_y1, core_x0:core_x1]
    candidate_image = image[channel.y0:channel.y1, core_x0:core_x1]
    candidate_temporal_support = (
        temporal_support[channel.y0:channel.y1, core_x0:core_x1]
        if temporal_support is not None
        else None
    )
    candidate_temporal_labels = (
        temporal_labels[channel.y0:channel.y1, core_x0:core_x1]
        if temporal_labels is not None
        else None
    )
    local_label = 0
    recovered_labels: set[int] = set()
    contrast_kernel = np.ones((9, 9), dtype=np.uint8)

    for segmentation_label in np.unique(candidate_mask):
        if segmentation_label == 0:
            continue
        component_input = (candidate_mask == segmentation_label).astype(np.uint8)
        component_count, components, stats, _centroids = (
            cv2.connectedComponentsWithStats(component_input, connectivity=8)
        )
        full_candidate_area = int(np.count_nonzero(band_mask == segmentation_label))
        for component_id in range(1, component_count):
            area = int(stats[component_id, cv2.CC_STAT_AREA])
            if area <= 0 or full_candidate_area <= 0:
                continue
            if area / full_candidate_area < cell_filter.minimum_channel_containment_fraction:
                continue
            component_y = int(stats[component_id, cv2.CC_STAT_TOP])
            component_height = int(stats[component_id, cv2.CC_STAT_HEIGHT])
            component_x = int(stats[component_id, cv2.CC_STAT_LEFT])
            component_width = int(stats[component_id, cv2.CC_STAT_WIDTH])
            if cell_filter.exclude_top_boundary and component_y == 0:
                continue
            component_right = margin + component_x + component_width
            if component_right / channel_width < cell_filter.minimum_right_edge_fraction:
                continue
            if (
                cell_filter.exclude_bottom_boundary
                and component_y + component_height == channel_height
            ):
                continue
            if (
                channel.channel_id in cell_filter.exclude_bottom_boundary_channels
                and component_y + component_height
                >= channel_height - cell_filter.bottom_boundary_margin
            ):
                continue
            component = components == component_id
            ys, xs = np.nonzero(component)
            rectangle = cv2.minAreaRect(np.column_stack((xs, ys)).astype(np.float32))
            minor_axis, major_axis = sorted(float(value) for value in rectangle[1])
            elongation = major_axis / max(minor_axis, 1.0)
            strict_shape = (
                cell_filter.minimum_minor_axis <= minor_axis <= cell_filter.maximum_minor_axis
                and cell_filter.minimum_major_axis <= major_axis <= cell_filter.maximum_major_axis
                and cell_filter.minimum_elongation <= elongation <= cell_filter.maximum_elongation
            )
            intensities = candidate_image[component]
            mean_intensity = float(intensities.mean())
            minimum_intensity = float(intensities.min())
            dilated = cv2.dilate(component.astype(np.uint8), contrast_kernel) > 0
            ring = dilated & (candidate_mask == 0)
            local_contrast = (
                float(np.median(candidate_image[ring]) - mean_intensity)
                if ring.any()
                else float("-inf")
            )
            strict_acceptance = (
                cell_filter.minimum_area <= area <= cell_filter.maximum_area
                and strict_shape
                and mean_intensity < cell_filter.maximum_mean_intensity
                and minimum_intensity < cell_filter.maximum_minimum_intensity
                and local_contrast >= cell_filter.minimum_local_contrast
            )
            recovered_temporally = False
            if (
                not strict_acceptance
                and cell_filter.temporal_recovery
                and candidate_temporal_support is not None
            ):
                scale = cell_filter.temporal_filter_scale
                overlap_fraction = float(
                    np.count_nonzero(component & candidate_temporal_support)
                ) / area
                relaxed_shape = (
                    cell_filter.minimum_minor_axis / scale
                    <= minor_axis
                    <= cell_filter.maximum_minor_axis * scale
                    and cell_filter.minimum_major_axis / scale
                    <= major_axis
                    <= cell_filter.maximum_major_axis * scale
                    and max(1.0, cell_filter.minimum_elongation / scale)
                    <= elongation
                    <= cell_filter.maximum_elongation * scale
                )
                recovered_temporally = (
                    cell_filter.minimum_area / scale <= area <= cell_filter.maximum_area * scale
                    and relaxed_shape
                    and mean_intensity
                    < cell_filter.maximum_mean_intensity + cell_filter.temporal_intensity_margin
                    and minimum_intensity < cell_filter.maximum_minimum_intensity
                    and local_contrast
                    >= cell_filter.minimum_local_contrast * cell_filter.temporal_contrast_scale
                    and overlap_fraction >= cell_filter.temporal_minimum_overlap_fraction
                )
            if not strict_acceptance and not recovered_temporally:
                continue

            output_components = [component]
            if recovered_temporally and candidate_temporal_labels is not None:
                temporal_ids = np.unique(candidate_temporal_labels)
                temporal_ids = temporal_ids[temporal_ids > 0]
                matching_ids: list[int] = []
                radius = cell_filter.temporal_dilation_radius
                temporal_kernel = cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
                )
                minimum_temporal_overlap = max(8, int(round(area * 0.02)))
                for temporal_id in temporal_ids:
                    temporal_seed = candidate_temporal_labels == temporal_id
                    expanded_seed = cv2.dilate(
                        temporal_seed.astype(np.uint8), temporal_kernel
                    ) > 0
                    if np.count_nonzero(component & expanded_seed) >= minimum_temporal_overlap:
                        matching_ids.append(int(temporal_id))
                if len(matching_ids) > 1:
                    component_yx = np.nonzero(component)
                    distances = []
                    for temporal_id in matching_ids:
                        temporal_seed = candidate_temporal_labels == temporal_id
                        distance = cv2.distanceTransform(
                            (~temporal_seed).astype(np.uint8),
                            cv2.DIST_L2,
                            cv2.DIST_MASK_PRECISE,
                        )
                        distances.append(distance[component_yx])
                    assignments = np.argmin(np.stack(distances), axis=0)
                    split_components: list[np.ndarray] = []
                    minimum_split_area = max(
                        80, int(round(cell_filter.minimum_area / cell_filter.temporal_filter_scale))
                    )
                    for temporal_index in range(len(matching_ids)):
                        selected = assignments == temporal_index
                        if np.count_nonzero(selected) < minimum_split_area:
                            continue
                        split_component = np.zeros_like(component)
                        split_component[component_yx[0][selected], component_yx[1][selected]] = True
                        split_components.append(split_component)
                    if split_components:
                        output_components = split_components

            output_region = output[:, margin : channel_width - margin]
            for output_component in output_components:
                local_label += 1
                output_region[output_component] = local_label
                if recovered_temporally:
                    recovered_labels.add(local_label)
    return output, recovered_labels


def mask_boundaries(labels: np.ndarray) -> np.ndarray:
    boundaries = np.zeros(labels.shape, dtype=bool)
    boundaries[1:] |= labels[1:] != labels[:-1]
    boundaries[:-1] |= labels[:-1] != labels[1:]
    boundaries[:, 1:] |= labels[:, 1:] != labels[:, :-1]
    boundaries[:, :-1] |= labels[:, :-1] != labels[:, 1:]
    return boundaries & (labels > 0)


def make_channel_overlay(
    image: np.ndarray,
    labels: np.ndarray,
    alpha: float = 0.68,
) -> np.ndarray:
    rgb = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
    overlay = rgb.copy()
    pixels = labels > 0
    overlay[pixels] = np.clip(
        (1.0 - alpha) * rgb[pixels] + alpha * MASK_COLOR_RGB, 0, 255
    ).astype(np.uint8)
    overlay[mask_boundaries(labels)] = 255
    return overlay


def _contour_json(mask: np.ndarray, offset_x: int, offset_y: int) -> str:
    contours, _hierarchy = cv2.findContours(
        mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    points: list[list[int]] = []
    for contour in contours:
        for point in contour.reshape(-1, 2):
            points.append([int(point[0]) + offset_x, int(point[1]) + offset_y])
    return json.dumps(points, separators=(",", ":"))


def channel_cell_rows(
    image: np.ndarray,
    local_labels: np.ndarray,
    frame: int,
    view_index: int,
    channel: ChannelRoi,
    label_start: int,
    recovered_labels: set[int],
) -> list[dict[str, Any]]:
    crop_image = image[channel.y0 : channel.y1, channel.x0 : channel.x1]
    rows: list[dict[str, Any]] = []
    for local_label in range(1, int(local_labels.max()) + 1):
        cell_mask = local_labels == local_label
        ys, xs = np.nonzero(cell_mask)
        if not len(xs):
            continue
        rows.append(
            {
                "view_index": view_index,
                "roi_id": channel.channel_id,
                "time_frame": frame,
                "label_id": label_start + local_label,
                "local_label_id": local_label,
                "area_px": int(len(xs)),
                "centroid_x": float(xs.mean() + channel.x0),
                "centroid_y": float(ys.mean() + channel.y0),
                "bbox_x0": int(xs.min() + channel.x0),
                "bbox_y0": int(ys.min() + channel.y0),
                "bbox_x1": int(xs.max() + channel.x0 + 1),
                "bbox_y1": int(ys.max() + channel.y0 + 1),
                "temporal_recovery": int(local_label in recovered_labels),
                "mean_intensity": float(crop_image[cell_mask].mean()),
                "contour_json": _contour_json(cell_mask, channel.x0, channel.y0),
            }
        )
    return rows


def _build_frame_index(images: Any) -> dict[tuple[int, int], int]:
    frame_indices: dict[tuple[int, int], int] = {}
    for frame_index, indices in enumerate(images.loop_indices):
        time_frame = int(indices.get("T", 0))
        view_index = int(indices.get("P", 0))
        other_axes = {
            key: value for key, value in indices.items() if key not in {"T", "P"}
        }
        if any(int(value) != 0 for value in other_axes.values()):
            continue
        frame_indices.setdefault((time_frame, view_index), frame_index)
    return frame_indices


def _read_frame(images: Any, frame_indices: dict[tuple[int, int], int], view: int, frame: int) -> np.ndarray:
    try:
        frame_index = frame_indices[(frame, view)]
    except KeyError as exc:
        raise ValueError(f"ND2 frame is missing for view={view}, time={frame}") from exc
    image = np.asarray(images.read_frame(frame_index))
    image = np.squeeze(image)
    while image.ndim > 2:
        image = image[0]
    if image.ndim != 2:
        raise ValueError(f"Expected a 2D ND2 frame, got shape {image.shape}")
    return to_uint8(image)


def run_extraction(
    nd2_file: Path,
    filename: str,
    progress_callback: ProgressCallback | None = None,
    niter: int = DEFAULT_NITER,
) -> dict[str, Any]:
    """Run the PoC channel/Cellpose flow and atomically publish its dataset."""

    try:
        import nd2
        from cellpose import models
    except ImportError as exc:
        raise RuntimeError(
            "Mother-machine extraction dependencies are missing. "
            "Install backend requirements (nd2 and cellpose)."
        ) from exc

    ensure_directories()
    key = dataset_key(filename)
    run_token = uuid4().hex
    temporary_results = Path(
        tempfile.mkdtemp(prefix=f"phenopixel-mm-{key}-{run_token}-")
    )
    temporary_database = DATABASES_DIR / f".{key}.{run_token}.tmp.db"
    started = time.monotonic()
    all_rows: list[dict[str, Any]] = []
    review_image_files: list[tuple[int, int, int, str, Path]] = []
    config = _load_config()

    def report(**payload: Any) -> None:
        if progress_callback is not None:
            progress_callback(payload)

    try:
        report(stage="loading_model", message="Loading Cellpose model")
        model = models.CellposeModel(gpu=True, pretrained_model=MODEL_NAME)
        model_device = str(model.device).upper()
        with nd2.ND2File(nd2_file) as images:
            sizes = {str(axis): int(value) for axis, value in images.sizes.items()}
            timeframe_count = int(sizes.get("T", 1))
            field_count = int(sizes.get("P", 1))
            width = int(sizes.get("X", 0))
            height = int(sizes.get("Y", 0))
            frame_indices = _build_frame_index(images)
            configured_views = [
                view_index
                for view_index in range(field_count)
                if str(view_index) in config.get("views", {})
            ]
            total_frames = timeframe_count * len(configured_views)
            processed_frames = 0
            view_manifests: list[dict[str, Any]] = []
            report(
                stage="model_ready",
                message=f"Cellpose model loaded on {model_device}",
                processed_frames=processed_frames,
                total_frames=total_frames,
            )

            for view_index in range(field_count):
                reference = _read_frame(images, frame_indices, view_index, 0)
                loaded = load_view_config(config, view_index, reference.shape)
                if loaded is None:
                    view_manifests.append(
                        {
                            "view_index": view_index,
                            "configured": False,
                            "description": "No channel definition is configured for this field of view.",
                            "channels": [],
                        }
                    )
                    continue
                reference_channels, cell_filter, description = loaded
                reference_vertical_profile = vertical_edge_profile(reference)
                reference_horizontal_profile = wall_profile(reference)
                channel_manifests: dict[int, dict[str, Any]] = {}
                for channel in shifted_channels(reference_channels, reference.shape, 0, 0):
                    channel_root = (
                        temporary_results
                        / "views"
                        / str(view_index)
                        / "channels"
                        / str(channel.channel_id)
                    )
                    (channel_root / "raw").mkdir(parents=True, exist_ok=True)
                    (channel_root / "overlay").mkdir(parents=True, exist_ok=True)
                    channel_manifests[channel.channel_id] = {
                        "channel_id": channel.channel_id,
                        "reference_roi": asdict(channel),
                        "frame_cell_counts": [],
                    }

                previous_labels: np.ndarray | None = None
                previous_horizontal_shift = 0
                previous_vertical_shift = 0
                for frame in range(timeframe_count):
                    report(
                        stage="segmenting",
                        message=(
                            f"Processing field {view_index + 1}, "
                            f"frame {frame + 1}"
                        ),
                        view_index=view_index,
                        time_frame=frame,
                        processed_frames=processed_frames,
                        total_frames=total_frames,
                    )
                    image = reference if frame == 0 else _read_frame(
                        images, frame_indices, view_index, frame
                    )
                    max_drift = max(2, int(round(min(image.shape) * 60 / 2044)))
                    vertical_shift = best_profile_shift(
                        reference_vertical_profile,
                        vertical_edge_profile(image),
                        int(round(image.shape[0] * 200 / 2044)),
                        int(round(image.shape[0] * 1600 / 2044)),
                        max_drift,
                    )
                    horizontal_shift = best_profile_shift(
                        reference_horizontal_profile,
                        wall_profile(image, vertical_shift),
                        0,
                        image.shape[1],
                        max_drift,
                    )
                    channels = shifted_channels(
                        reference_channels, image.shape, horizontal_shift, vertical_shift
                    )
                    temporal_labels: np.ndarray | None = None
                    temporal_support: np.ndarray | None = None
                    if cell_filter.temporal_recovery and previous_labels is not None:
                        transform = np.float32(
                            [
                                [1, 0, horizontal_shift - previous_horizontal_shift],
                                [0, 1, vertical_shift - previous_vertical_shift],
                            ]
                        )
                        temporal_labels = cv2.warpAffine(
                            previous_labels,
                            transform,
                            (image.shape[1], image.shape[0]),
                            flags=cv2.INTER_NEAREST,
                            borderMode=cv2.BORDER_CONSTANT,
                            borderValue=0,
                        )
                        aligned_previous = (temporal_labels > 0).astype(np.uint8)
                        radius = cell_filter.temporal_dilation_radius
                        if radius:
                            temporal_kernel = cv2.getStructuringElement(
                                cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
                            )
                            aligned_previous = cv2.dilate(aligned_previous, temporal_kernel)
                        temporal_support = aligned_previous > 0

                    frame_labels = np.zeros(image.shape, dtype=np.uint16)
                    label_offset = 0
                    channel_groups = channels_by_band(channels)
                    for group_index, group in enumerate(channel_groups):
                        report(
                            stage="segmenting",
                            message=(
                                f"Processing field {view_index + 1}, "
                                f"frame {frame + 1}, band "
                                f"{group_index + 1}/{len(channel_groups)}"
                            ),
                            view_index=view_index,
                            time_frame=frame,
                            processed_frames=(
                                processed_frames
                                + group_index / max(len(channel_groups), 1)
                            ),
                            total_frames=total_frames,
                        )
                        band_y0 = min(channel.y0 for channel in group)
                        band_y1 = max(channel.y1 for channel in group)
                        band_mask = _segment_band(
                            model,
                            image[band_y0:band_y1],
                            niter=niter,
                        )
                        for channel in group:
                            local_labels, recovered_labels = extract_channel_cells(
                                band_mask,
                                image,
                                band_y0,
                                channel,
                                cell_filter,
                                temporal_support,
                                temporal_labels,
                            )
                            count = int(local_labels.max())
                            channel_manifests[channel.channel_id][
                                "frame_cell_counts"
                            ].append(count)
                            region = frame_labels[
                                channel.y0 : channel.y1, channel.x0 : channel.x1
                            ]
                            foreground = local_labels > 0
                            region[foreground] = local_labels[foreground] + label_offset
                            all_rows.extend(
                                channel_cell_rows(
                                    image,
                                    local_labels,
                                    frame,
                                    view_index,
                                    channel,
                                    label_offset,
                                    recovered_labels,
                                )
                            )
                            crop = image[
                                channel.y0 : channel.y1, channel.x0 : channel.x1
                            ]
                            overlay = make_channel_overlay(crop, local_labels)
                            channel_root = (
                                temporary_results
                                / "views"
                                / str(view_index)
                                / "channels"
                                / str(channel.channel_id)
                            )
                            raw_path = channel_root / "raw" / f"{frame}.png"
                            overlay_path = channel_root / "overlay" / f"{frame}.png"
                            if not cv2.imwrite(str(raw_path), crop):
                                raise RuntimeError(f"Failed to write {raw_path}")
                            if not cv2.imwrite(
                                str(overlay_path), cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)
                            ):
                                raise RuntimeError(f"Failed to write {overlay_path}")
                            review_image_files.extend(
                                [
                                    (
                                        view_index,
                                        channel.channel_id,
                                        frame,
                                        "raw",
                                        raw_path,
                                    ),
                                    (
                                        view_index,
                                        channel.channel_id,
                                        frame,
                                        "overlay",
                                        overlay_path,
                                    ),
                                ]
                            )
                            label_offset += count

                    previous_labels = frame_labels
                    previous_horizontal_shift = horizontal_shift
                    previous_vertical_shift = vertical_shift
                    processed_frames += 1
                    report(
                        stage="segmenting",
                        message=f"Processing field {view_index + 1}, frame {frame + 1}",
                        view_index=view_index,
                        time_frame=frame,
                        processed_frames=processed_frames,
                        total_frames=total_frames,
                    )

                view_manifests.append(
                    {
                        "view_index": view_index,
                        "configured": True,
                        "description": description,
                        "channels": list(channel_manifests.values()),
                    }
                )

        elapsed = time.monotonic() - started
        manifest = {
            "schema_version": 2,
            "filename": filename,
            "database": database_path(filename).name,
            "model": MODEL_NAME,
            "niter": niter,
            "model_device": model_device,
            "cellpose_version": package_version("cellpose"),
            "field_count": field_count,
            "timeframe_count": timeframe_count,
            "image_width": width,
            "image_height": height,
            "configured_field_count": sum(
                1 for view in view_manifests if view["configured"]
            ),
            "total_cell_instances": len(all_rows),
            "elapsed_seconds": elapsed,
            "views": view_manifests,
        }
        create_cells_database(
            temporary_database,
            filename,
            all_rows,
            {
                "model": MODEL_NAME,
                "niter": niter,
                "model_device": model_device,
                "cellpose_version": manifest["cellpose_version"],
                "field_count": field_count,
                "timeframe_count": timeframe_count,
                "total_cell_instances": len(all_rows),
                "elapsed_seconds": elapsed,
            },
            manifest=manifest,
            review_images=(
                (view_index, roi_id, frame, mode, image_path.read_bytes())
                for view_index, roi_id, frame, mode, image_path in review_image_files
            ),
        )
        replace_dataset(filename, temporary_database)
        shutil.rmtree(temporary_results)
        report(stage="completed", message="Extraction completed")
        return {
            "filename": filename,
            "database": manifest["database"],
            "field_count": field_count,
            "timeframe_count": timeframe_count,
            "configured_field_count": manifest["configured_field_count"],
            "total_cell_instances": len(all_rows),
            "elapsed_seconds": elapsed,
            "niter": niter,
        }
    except Exception:
        if temporary_results.exists():
            shutil.rmtree(temporary_results)
        if temporary_database.exists():
            temporary_database.unlink()
        raise
