import io
import json
import pickle
from typing import Literal, Sequence

import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sqlalchemy import String, cast, or_, select

from app.database_manager.crud import DatabaseManagerCrud, get_cells_table
from app.bulk_engine.heatmap_bulk_core import (
    build_heatmap_vectors_csv,
    calculate_heatmap_path_vector,
)
from app.bulk_engine.hu_separation_detector import build_hu_separation_overlay
from app.shared.objective_scale import DEFAULT_PIXEL_SIZE_UM, normalize_pixel_size_um

PIXEL_SIZE_UM: float = DEFAULT_PIXEL_SIZE_UM
FITC_AGGREGATION_THRESHOLD: float = 0.7414


def _decode_grayscale_preserve_depth(image_raw: bytes) -> np.ndarray | None:
    image = cv2.imdecode(np.frombuffer(image_raw, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        return None
    image = np.squeeze(image)
    if image.ndim == 2:
        return image
    if image.ndim == 3:
        if image.shape[2] == 1:
            return image[:, :, 0]
        if image.shape[2] == 4:
            image = image[:, :, :3]
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return None


def _pca_length(points: np.ndarray) -> float:
    pts = points.astype(float)
    if pts.shape[0] < 2:
        return 0.0
    mean = pts.mean(axis=0)
    centered = pts - mean
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eig(cov)
    axis = eigvecs[:, np.argmax(eigvals)]
    proj = centered @ axis
    return float(proj.max() - proj.min())


def _calc_cell_length_um(
    image_ph: bytes | None,
    contour_raw: bytes,
    pixel_size_um: object = DEFAULT_PIXEL_SIZE_UM,
) -> float:
    """
    Calculate the major-axis length (um) using PCA.
    Prefer pixels inside the contour; fall back to contour points.
    """
    pixel_size = normalize_pixel_size_um(pixel_size_um)
    try:
        contour = pickle.loads(contour_raw)
    except Exception:
        return 0.0

    contour_pts = np.array([p[0] if len(p) == 1 else p for p in contour], dtype=float)
    if contour_pts.ndim != 2 or contour_pts.shape[0] == 0:
        return 0.0

    if image_ph is not None:
        image_ph_gray = _decode_grayscale_preserve_depth(image_ph)
        if image_ph_gray is not None:
            mask = np.zeros_like(image_ph_gray)
            cv2.fillPoly(mask, [np.array(contour_pts, dtype=np.int32)], 255)
            coords_inside = np.column_stack(np.where(mask))
            if coords_inside.size > 0:
                length_px = _pca_length(coords_inside[:, ::-1])
                if length_px > 0:
                    return round(length_px * pixel_size, 4)

    length_px = _pca_length(contour_pts)
    return round(length_px * pixel_size, 4) if length_px > 0 else 0.0


def _get_database_pixel_size_um(db_name: str) -> float:
    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)
        stmt = (
            select(cells.c.pixel_size_um)
            .where(cells.c.pixel_size_um.is_not(None))
            .where(cells.c.pixel_size_um > 0)
            .limit(1)
        )
        return normalize_pixel_size_um(session.execute(stmt).scalar_one_or_none())
    finally:
        session.close()


def _get_points_inside_cell(image_raw: bytes, contour_raw: bytes) -> np.ndarray:
    image_gray = _decode_grayscale_preserve_depth(image_raw)
    if image_gray is None:
        return np.array([])
    mask = np.zeros_like(image_gray)
    contour = pickle.loads(contour_raw)
    if isinstance(contour, (list, tuple)):
        contours = contour
    else:
        contours = [contour]
    contours = [np.array(c, dtype=np.int32) for c in contours if c is not None]
    if not contours:
        return np.array([])
    cv2.fillPoly(mask, contours, 255)
    coords = np.column_stack(np.where(mask))
    if coords.size == 0:
        return np.array([])
    return image_gray[coords[:, 0], coords[:, 1]].flatten()


def _calc_normalized_median_intensity(image_raw: bytes, contour_raw: bytes) -> float | None:
    points = _get_points_inside_cell(image_raw, contour_raw)
    if points.size == 0:
        return None
    max_val = float(points.max())
    if max_val <= 0:
        return 0.0
    normalized = points.astype(float) / max_val
    median_val = float(np.median(normalized))
    return round(median_val, 4)


def _calc_fraction_below_threshold(
    values: Sequence[float], threshold: float
) -> tuple[float, int, int]:
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        raise LookupError("No values found for the specified label.")
    arr = arr[np.isfinite(arr)]
    total = int(arr.size)
    if total == 0:
        raise LookupError("No values found for the specified label.")
    count_below = int((arr < threshold).sum())
    ratio = count_below / total if total > 0 else 0.0
    return ratio, count_below, total


def get_cell_lengths_by_label(
    db_name: str, label: str | None = None
) -> list[tuple[str, float]]:
    """
    Return cell lengths (um) for cells matching the manual_label.
    """
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(
                cells.c.cell_id,
                cells.c.img_ph,
                cells.c.contour,
                cells.c.manual_label,
                cells.c.pixel_size_um,
            )
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        lengths: list[tuple[str, float]] = []
        for cell_id, image_ph, contour_raw, _, pixel_size_um in result.fetchall():
            if cell_id is None or contour_raw is None:
                continue
            image_bytes = bytes(image_ph) if image_ph is not None else None
            contour_bytes = bytes(contour_raw)
            length_val = _calc_cell_length_um(
                image_bytes,
                contour_bytes,
                pixel_size_um,
            )
            if length_val > 0:
                lengths.append((str(cell_id), length_val))
        return lengths
    finally:
        session.close()


def get_cell_areas_by_label(
    db_name: str, label: str | None = None
) -> list[tuple[str, float]]:
    """
    Return cell areas for cells matching the manual_label.
    """
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c.area, cells.c.manual_label)
            .where(cells.c.area.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        areas: list[tuple[str, float]] = []
        for cell_id, area, _ in result.fetchall():
            if cell_id is None or area is None:
                continue
            try:
                area_val = float(area)
            except (TypeError, ValueError):
                continue
            if area_val > 0:
                areas.append((str(cell_id), area_val))
        return areas
    finally:
        session.close()


def get_normalized_medians_by_label(
    db_name: str, label: str | None = None, channel: str = "ph"
) -> list[tuple[str, float]]:
    """
    Return normalized median intensity values for cells matching the manual_label.
    """
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"
    column_map = {
        "ph": "img_ph",
        "fluo1": "img_fluo1",
        "fluo2": "img_fluo2",
    }
    column_name = column_map.get(channel)
    if column_name is None:
        raise ValueError("Invalid channel")

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c[column_name], cells.c.contour, cells.c.manual_label)
            .where(cells.c[column_name].is_not(None))
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        medians: list[tuple[str, float]] = []
        for cell_id, image_raw, contour_raw, _ in result.fetchall():
            if cell_id is None or image_raw is None or contour_raw is None:
                continue
            median_val = _calc_normalized_median_intensity(bytes(image_raw), bytes(contour_raw))
            if median_val is None or not np.isfinite(median_val):
                continue
            if median_val < 0:
                continue
            medians.append((str(cell_id), float(median_val)))
        return medians
    finally:
        session.close()


def get_raw_intensities_by_label(
    db_name: str, label: str | None = None, channel: str = "ph"
) -> list[tuple[str, list[int]]]:
    """
    Return raw intensity values inside each cell contour for the specified channel.
    """
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"
    column_map = {
        "ph": "img_ph",
        "fluo1": "img_fluo1",
        "fluo2": "img_fluo2",
    }
    column_name = column_map.get(channel)
    if column_name is None:
        raise ValueError("Invalid channel")

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c[column_name], cells.c.contour, cells.c.manual_label)
            .where(cells.c[column_name].is_not(None))
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        intensities_by_cell: list[tuple[str, list[int]]] = []
        for cell_id, image_raw, contour_raw, _ in result.fetchall():
            if cell_id is None or image_raw is None or contour_raw is None:
                continue
            points = _get_points_inside_cell(bytes(image_raw), bytes(contour_raw))
            values = points.astype(int).tolist() if points.size > 0 else []
            intensities_by_cell.append((str(cell_id), values))
        return intensities_by_cell
    finally:
        session.close()


def _parse_contour_blob(contour_blob: bytes) -> np.ndarray:
    contour = pickle.loads(contour_blob)
    contour_array = np.asarray(contour)
    if contour_array.ndim == 3 and contour_array.shape[1] == 1:
        contour_array = contour_array[:, 0, :]
    elif contour_array.ndim == 2 and contour_array.shape[1] == 2:
        pass
    else:
        raise ValueError("Invalid contour format")
    return contour_array.astype(float)


def _basis_conversion(
    contour: list[list[float]],
    X: np.ndarray,
    center_x: float,
    center_y: float,
    coordinates_inside_cell: list[list[int]],
) -> tuple[
    list[float],
    list[float],
    list[float],
    list[float],
    float,
    float,
    float,
    float,
    list[list[float]],
    list[list[float]],
]:
    coords_arr = np.asarray(coordinates_inside_cell).reshape(-1, 2)
    contour_arr = np.asarray(contour).reshape(-1, 2)
    center_arr = np.array([center_x, center_y])

    Sigma = np.cov(X)
    eigenvalues, eigenvectors = np.linalg.eig(Sigma)

    if eigenvalues[1] < eigenvalues[0]:
        Q = np.array([eigenvectors[1], eigenvectors[0]])
        U = (coords_arr @ Q)[:, ::-1]
        contour_U = (contour_arr[:, ::-1] @ Q)[:, ::-1]
        u1_c, u2_c = center_arr @ Q
    else:
        Q = np.array([eigenvectors[0], eigenvectors[1]])
        U = coords_arr[:, ::-1] @ Q
        contour_U = contour_arr @ Q
        u2_c, u1_c = center_arr @ Q

    u1 = U[:, 1]
    u2 = U[:, 0]
    u1_contour = contour_U[:, 1]
    u2_contour = contour_U[:, 0]
    min_u1 = float(u1.min())
    max_u1 = float(u1.max())
    return (
        u1.tolist(),
        u2.tolist(),
        u1_contour.tolist(),
        u2_contour.tolist(),
        min_u1,
        max_u1,
        float(u1_c),
        float(u2_c),
        U.tolist(),
        contour_U.tolist(),
    )


def _rasterize_contour(
    contour: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    if contour.shape[0] < 3:
        raise ValueError("Contour must have at least 3 points")
    min_xy = np.floor(contour.min(axis=0)).astype(int)
    max_xy = np.ceil(contour.max(axis=0)).astype(int)
    min_x, min_y = int(min_xy[0]), int(min_xy[1])
    max_x, max_y = int(max_xy[0]), int(max_xy[1])
    width = max(1, max_x - min_x + 1)
    height = max(1, max_y - min_y + 1)

    contour_shifted = contour - np.array([min_x, min_y], dtype=float)
    contour_int = np.round(contour_shifted).astype(np.int32).reshape(-1, 1, 2)

    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(mask, [contour_int], 255)
    coords_inside_cell = np.column_stack(np.where(mask))
    return coords_inside_cell, contour_shifted, (height, width)


def _transform_contour_replot(contour: np.ndarray) -> np.ndarray:
    coords_inside_cell, contour_shifted, mask_shape = _rasterize_contour(contour)
    if coords_inside_cell.size == 0:
        raise ValueError("No points inside contour")

    X = np.array(
        [
            [i[1] for i in coords_inside_cell],
            [i[0] for i in coords_inside_cell],
        ]
    )

    center_x = mask_shape[0] / 2
    center_y = mask_shape[1] / 2

    (
        _u1,
        _u2,
        u1_contour,
        u2_contour,
        _min_u1,
        _max_u1,
        u1_c,
        u2_c,
        _U,
        _contour_U,
    ) = _basis_conversion(
        contour_shifted.tolist(),
        X,
        center_x,
        center_y,
        coords_inside_cell.tolist(),
    )

    u1_contour_shifted = np.array(u1_contour) - u1_c
    u2_contour_shifted = np.array(u2_contour) - u2_c
    return np.column_stack([u1_contour_shifted, u2_contour_shifted])


def _collect_transformed_contours_by_label(
    db_name: str, label: str | None = None
) -> list[np.ndarray]:
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.contour, cells.c.manual_label)
            .where(cells.c.contour.is_not(None))
            .order_by(cells.c.manual_label, cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        transformed: list[np.ndarray] = []
        for contour_raw, _ in result.fetchall():
            if contour_raw is None:
                continue
            try:
                contour = _parse_contour_blob(bytes(contour_raw))
                transformed.append(_transform_contour_replot(contour))
            except Exception:
                continue
        return transformed
    finally:
        session.close()


def _collect_transformed_contours_with_ids(
    db_name: str, label: str | None = None
) -> dict[str, list[list[float]]]:
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c.contour, cells.c.manual_label)
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.manual_label, cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        contours_by_id: dict[str, list[list[float]]] = {}
        for cell_id, contour_raw, _ in result.fetchall():
            if cell_id is None or contour_raw is None:
                continue
            try:
                contour = _parse_contour_blob(bytes(contour_raw))
                transformed = _transform_contour_replot(contour)
            except Exception:
                continue
            contours_by_id[str(cell_id)] = transformed.astype(float).tolist()
        return contours_by_id
    finally:
        session.close()


def _build_contours_grid_image(
    contours: Sequence[np.ndarray],
    invert_y: bool = False,
    dpi: int = 200,
) -> bytes:
    count = len(contours)
    if count == 0:
        raise LookupError("No contours found for the specified label.")

    cols = int(np.ceil(np.sqrt(count)))
    rows = int(np.ceil(count / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 2.2, rows * 2.2), squeeze=False)

    axes_flat = axes.ravel()
    for ax, contour in zip(axes_flat, contours):
        if contour.shape[0] < 2:
            ax.axis("off")
            continue
        closed = np.vstack([contour, contour[0]])
        ax.plot(
            closed[:, 0],
            closed[:, 1],
            color="lime",
            linewidth=5,
            alpha=1,
        )
        ax.set_aspect("equal", adjustable="box")
        if invert_y:
            ax.invert_yaxis()
        ax.axis("off")

    for ax in axes_flat[count:]:
        ax.axis("off")

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


def _collect_heatmap_paths_with_ids(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> list[tuple[str, list[tuple[float, float]]]]:
    if degree < 1:
        raise ValueError("degree must be >= 1")
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"
    column_map = {
        "fluo1": "img_fluo1",
        "fluo2": "img_fluo2",
    }
    column_name = column_map.get(channel)
    if column_name is None:
        raise ValueError("Invalid channel")

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c[column_name], cells.c.contour, cells.c.manual_label)
            .where(cells.c[column_name].is_not(None))
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        paths_with_ids: list[tuple[str, list[tuple[float, float]]]] = []
        for cell_id, image_raw, contour_raw, _ in result.fetchall():
            if cell_id is None or image_raw is None or contour_raw is None:
                continue
            try:
                path = calculate_heatmap_path_vector(
                    bytes(image_raw),
                    bytes(contour_raw),
                    degree=degree,
                )
            except Exception:
                continue
            if path:
                paths_with_ids.append((str(cell_id), path))

        if not paths_with_ids:
            raise LookupError("No heatmap vectors found for the specified label.")
        return paths_with_ids
    finally:
        session.close()


def _collect_heatmap_paths(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> list[list[tuple[float, float]]]:
    return [
        path
        for _, path in _collect_heatmap_paths_with_ids(
            db_name,
            label=label,
            channel=channel,
            degree=degree,
        )
    ]


def get_heatmap_vectors(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> list[tuple[str, list[tuple[float, float]]]]:
    return _collect_heatmap_paths_with_ids(
        db_name,
        label=label,
        channel=channel,
        degree=degree,
    )


def _build_heatmap_abs_plot(
    paths: Sequence[Sequence[tuple[float, float]]], dpi: int = 100
) -> bytes:
    heatmap_vectors: list[dict[str, object]] = []
    for idx, path in enumerate(paths):
        if not path:
            continue
        u1_values = [float(pair[0]) for pair in path]
        g_values = [float(pair[1]) for pair in path]
        if not u1_values or not g_values:
            continue
        count = min(len(u1_values), len(g_values))
        u1_values = u1_values[:count]
        g_values = g_values[:count]
        min_u1 = min(u1_values)
        max_u1 = max(u1_values)
        length = max_u1 - min_u1
        heatmap_vectors.append(
            {
                "index": idx,
                "u1": [val - min_u1 for val in u1_values],
                "G": g_values,
                "length": length,
            }
        )

    if not heatmap_vectors:
        raise LookupError("No heatmap vectors found for the specified label.")

    heatmap_vectors.sort(key=lambda vec: float(vec["length"]))
    max_length = max(float(vec["length"]) for vec in heatmap_vectors)

    for vec in heatmap_vectors:
        length = float(vec["length"])
        offset = (max_length - length) / 2 - max_length / 2
        vec["u1"] = [float(val) + offset for val in vec["u1"]]

    u1_all = [val for vec in heatmap_vectors for val in vec["u1"]]
    if not u1_all:
        raise LookupError("No heatmap vectors found for the specified label.")
    u1_min = min(u1_all)
    u1_max = max(u1_all)

    fig, ax = plt.subplots(figsize=(10, 5))
    cmap = plt.cm.inferno

    for idx, vec in enumerate(heatmap_vectors):
        u1 = vec["u1"]
        g_values = vec["G"]
        count = min(len(u1), len(g_values))
        if count < 2:
            continue
        u1 = u1[:count]
        g_values = g_values[:count]
        g_array = np.array(g_values, dtype=float)
        g_min = float(np.min(g_array))
        g_max = float(np.max(g_array))
        if g_max == g_min:
            normalized = np.zeros_like(g_array)
        else:
            normalized = (g_array - g_min) / (g_max - g_min)
        colors = cmap(normalized)

        offset = len(heatmap_vectors) - idx - 1
        for i in range(len(u1) - 1):
            ax.plot([offset, offset], u1[i : i + 2], color=colors[i], lw=10)

    sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(vmin=0, vmax=1))
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax)
    cbar.set_label("Normalized G Value")

    ax.set_ylim([u1_min, u1_max])
    ax.set_xlim([-0.5, len(heatmap_vectors) - 0.5])
    ax.set_ylabel("Cell length (px)")
    ax.set_xlabel("Cell number")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


def _build_heatmap_rel_plot(
    paths: Sequence[Sequence[tuple[float, float]]], dpi: int = 100
) -> bytes:
    heatmap_vectors: list[dict[str, object]] = []
    for idx, path in enumerate(paths):
        if not path:
            continue
        g_values = [float(pair[1]) for pair in path]
        if not g_values:
            continue
        length = len(g_values)
        heatmap_vectors.append(
            {
                "index": idx,
                "u1": list(range(length)),
                "G": g_values,
                "length": length,
                "g_sum": float(np.sum(g_values)),
            }
        )

    if not heatmap_vectors:
        raise LookupError("No heatmap vectors found for the specified label.")

    heatmap_vectors.sort(key=lambda vec: float(vec["g_sum"]))
    max_length = max(int(vec["length"]) for vec in heatmap_vectors)

    for vec in heatmap_vectors:
        length = int(vec["length"])
        offset = (max_length - length) / 2 - max_length / 2
        vec["u1"] = [float(val) + offset for val in vec["u1"]]

    u1_all = [val for vec in heatmap_vectors for val in vec["u1"]]
    if not u1_all:
        raise LookupError("No heatmap vectors found for the specified label.")
    u1_min = min(u1_all)
    u1_max = max(u1_all)

    fig, ax = plt.subplots(figsize=(10, 5))
    cmap = plt.cm.inferno

    for idx, vec in enumerate(heatmap_vectors):
        u1 = vec["u1"]
        g_values = vec["G"]
        count = min(len(u1), len(g_values))
        if count < 2:
            continue
        u1 = u1[:count]
        g_values = g_values[:count]
        g_array = np.array(g_values, dtype=float)
        g_min = float(np.min(g_array))
        g_max = float(np.max(g_array))
        if g_max == g_min:
            normalized = np.zeros_like(g_array)
        else:
            normalized = (g_array - g_min) / (g_max - g_min)
        colors = cmap(normalized)

        offset = len(heatmap_vectors) - idx - 1
        for i in range(len(u1) - 1):
            ax.plot([offset, offset], u1[i : i + 2], color=colors[i], lw=10)

    sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(vmin=0, vmax=1))
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax)
    cbar.set_label("Normalized G Value")

    ax.set_ylim([u1_min, u1_max])
    ax.set_xlim([-0.5, len(heatmap_vectors) - 0.5])
    ax.set_ylabel("Relative position(-)")
    ax.set_xlabel("Cell number")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


def get_heatmap_vectors_csv(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> bytes:
    """
    Return CSV bytes for heatmap vectors (u1/G pairs per cell).
    """
    paths = _collect_heatmap_paths(db_name, label=label, channel=channel, degree=degree)
    csv_bytes = build_heatmap_vectors_csv(
        paths,
        pixel_size_um=_get_database_pixel_size_um(db_name),
    )
    if not csv_bytes:
        raise LookupError("No heatmap vectors found for the specified label.")
    return csv_bytes


def create_heatmap_abs_plot(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> bytes:
    paths = _collect_heatmap_paths(db_name, label=label, channel=channel, degree=degree)
    return _build_heatmap_abs_plot(paths)


def create_heatmap_rel_plot(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> bytes:
    paths = _collect_heatmap_paths(db_name, label=label, channel=channel, degree=degree)
    return _build_heatmap_rel_plot(paths)


def create_hu_separation_overlay(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
    center_ratio: float = 0.15,
    max_to_min_ratio: float = 0.9,
) -> bytes:
    paths = _collect_heatmap_paths(db_name, label=label, channel=channel, degree=degree)
    csv_bytes = build_heatmap_vectors_csv(paths)
    if not csv_bytes:
        raise LookupError("No heatmap vectors found for the specified label.")
    filename = f"heatmap-{db_name}"
    buf = build_hu_separation_overlay(
        [(filename, csv_bytes)],
        degree=degree,
        center_ratio=center_ratio,
        max_to_min_ratio=max_to_min_ratio,
    )
    return buf.getvalue()


def _collect_map256_images(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
    normalize_per_cell: bool = True,
) -> list[np.ndarray]:
    if degree < 1:
        raise ValueError("degree must be >= 1")
    label_str = str(label).strip() if label is not None else ""
    apply_filter = bool(label_str) and label_str.lower() != "all"
    column_map = {
        "fluo1": "img_fluo1",
        "fluo2": "img_fluo2",
    }
    column_name = column_map.get(channel)
    if column_name is None:
        raise ValueError("Invalid channel")

    session = DatabaseManagerCrud.get_database_session(db_name)
    try:
        cells = get_cells_table(session)

        stmt = (
            select(cells.c.cell_id, cells.c[column_name], cells.c.contour, cells.c.manual_label)
            .where(cells.c[column_name].is_not(None))
            .where(cells.c.contour.is_not(None))
            .where(cells.c.cell_id.is_not(None))
            .order_by(cells.c.cell_id)
        )

        if apply_filter:
            filters = [cast(cells.c.manual_label, String) == label_str]
            if label_str.isdigit():
                filters.append(cells.c.manual_label == int(label_str))
            if label_str.upper() == "N/A":
                filters.append(cells.c.manual_label == "N/A")
                filters.append(cells.c.manual_label == 1000)
            stmt = stmt.where(or_(*filters))

        result = session.execute(stmt)
        map256_images: list[np.ndarray] = []
        for _cell_id, image_raw, contour_raw, _ in result.fetchall():
            if image_raw is None or contour_raw is None:
                continue
            try:
                normalized = DatabaseManagerCrud.build_map256_normalized(
                    bytes(image_raw),
                    bytes(contour_raw),
                    degree,
                    normalize_intensity=normalize_per_cell,
                )
            except Exception:
                continue
            if normalized.ndim != 2:
                continue
            map256_images.append(normalized)

        if not map256_images:
            raise LookupError("No map256 images found for the specified label.")
        return map256_images
    finally:
        session.close()


def create_map256_strip(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
) -> bytes:
    map256_images = _collect_map256_images(
        db_name,
        label=label,
        channel=channel,
        degree=degree,
    )
    rotated_images = [cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE) for image in map256_images]
    combined = cv2.hconcat(rotated_images) if len(rotated_images) > 1 else rotated_images[0]
    success, buffer = cv2.imencode(".png", combined)
    if not success:
        raise ValueError("Failed to encode image")
    return buffer.tobytes()


def create_map256_contour(
    db_name: str,
    label: str | None = None,
    channel: str = "fluo1",
    degree: int = 4,
    intensity_mode: Literal["absolute", "relative"] = "absolute",
) -> bytes:
    normalized_intensity_mode = intensity_mode.strip().lower()
    if normalized_intensity_mode not in {"absolute", "relative"}:
        raise ValueError("Invalid intensity_mode")
    relative_mode = normalized_intensity_mode == "relative"

    map256_images = _collect_map256_images(
        db_name,
        label=label,
        channel=channel,
        degree=degree,
        normalize_per_cell=relative_mode,
    )

    summed: np.ndarray | None = None
    sample_count = 0
    for image in map256_images:
        image_float = image.astype(np.float64)
        # Treat each cell with symmetry augmentation (original + flips).
        variants = (
            image_float,
            np.fliplr(image_float),
            np.flipud(image_float),
            np.flipud(np.fliplr(image_float)),
        )
        for variant in variants:
            if summed is None:
                summed = np.zeros_like(variant, dtype=np.float64)
            if variant.shape != summed.shape:
                continue
            summed += variant
            sample_count += 1

    if summed is None or sample_count == 0:
        raise LookupError("No map256 images found for the specified label.")

    mean_map = summed / float(sample_count)

    fig, ax = plt.subplots(figsize=(11, 3.5))
    if relative_mode:
        rel_min = float(np.min(mean_map))
        rel_max = float(np.max(mean_map))
        if rel_max > rel_min:
            plot_data = (mean_map - rel_min) / (rel_max - rel_min)
        else:
            plot_data = np.zeros_like(mean_map, dtype=np.float64)
        if np.allclose(plot_data, plot_data.flat[0]):
            plot_ref = ax.imshow(
                plot_data,
                cmap="inferno",
                interpolation="nearest",
                aspect="auto",
                origin="lower",
                vmin=0.0,
                vmax=1.0,
            )
        else:
            levels = np.linspace(0.0, 1.0, 33)
            plot_ref = ax.contourf(plot_data, levels=levels, cmap="inferno")
        colorbar_label = "Symmetry-augmented mean intensity (relative)"
    else:
        abs_min = float(np.min(mean_map))
        abs_max = float(np.max(mean_map))
        if np.allclose(mean_map, mean_map.flat[0]):
            if abs_max > abs_min:
                vmin = abs_min
                vmax = abs_max
            else:
                vmin = abs_min - 0.5
                vmax = abs_max + 0.5
            plot_ref = ax.imshow(
                mean_map,
                cmap="inferno",
                interpolation="nearest",
                aspect="auto",
                origin="lower",
                vmin=vmin,
                vmax=vmax,
            )
        else:
            levels = np.linspace(abs_min, abs_max, 33)
            plot_ref = ax.contourf(mean_map, levels=levels, cmap="inferno")
        colorbar_label = "Symmetry-augmented mean intensity (absolute raw)"
    color_bar = fig.colorbar(plot_ref, ax=ax)
    color_bar.set_label(colorbar_label)
    ax.set_xlabel("Long-axis position (px)")
    ax.set_ylabel("Lateral position (px)")
    ax.set_title("Map256 contour")
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


def create_contours_grid_plot(
    db_name: str, label: str | None = None
) -> bytes:
    contours = _collect_transformed_contours_by_label(db_name, label)
    if not contours:
        raise LookupError("No contours found for the specified label.")
    return _build_contours_grid_image(contours)


def get_contours_grid_json(
    db_name: str, label: str | None = None
) -> bytes:
    contours_by_id = _collect_transformed_contours_with_ids(db_name, label)
    if not contours_by_id:
        raise LookupError("No contours found for the specified label.")

    payload = json.dumps(contours_by_id, ensure_ascii=True, indent=2)
    return payload.encode("utf-8")


def create_cell_length_boxplot(
    db_name: str, label: str | None = None
) -> bytes:
    lengths = get_cell_lengths_by_label(db_name, label)
    if not lengths:
        raise LookupError("No cells found for the specified label.")
    values = [length for _, length in lengths]
    label_text = str(label) if label not in (None, "", "all", "All") else "All"
    return _build_boxplot_image(
        data=[values],
        labels=[label_text],
        ylabel="Cell length (um)",
        title=f"{db_name} | label {label_text}",
        point_color="#2c7a7b",
        median_color="#2f855a",
        box_color="#4a5568",
    )


class BulkEngineCrud:
    @classmethod
    def get_cell_lengths_by_label(
        cls, db_name: str, label: str | None = None
    ) -> list[tuple[str, float]]:
        return get_cell_lengths_by_label(db_name, label)

    @classmethod
    def get_cell_areas_by_label(
        cls, db_name: str, label: str | None = None
    ) -> list[tuple[str, float]]:
        return get_cell_areas_by_label(db_name, label)

    @classmethod
    def get_normalized_medians_by_label(
        cls, db_name: str, label: str | None = None, channel: str = "ph"
    ) -> list[tuple[str, float]]:
        return get_normalized_medians_by_label(db_name, label, channel)

    @classmethod
    def get_raw_intensities_by_label(
        cls, db_name: str, label: str | None = None, channel: str = "ph"
    ) -> list[tuple[str, list[int]]]:
        return get_raw_intensities_by_label(db_name, label, channel)

    @classmethod
    def get_heatmap_vectors_csv(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
    ) -> bytes:
        return get_heatmap_vectors_csv(db_name, label=label, channel=channel, degree=degree)

    @classmethod
    def get_heatmap_vectors(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
    ) -> list[tuple[str, list[tuple[float, float]]]]:
        return get_heatmap_vectors(db_name, label=label, channel=channel, degree=degree)

    @classmethod
    def create_heatmap_abs_plot(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
    ) -> bytes:
        return create_heatmap_abs_plot(db_name, label=label, channel=channel, degree=degree)

    @classmethod
    def create_heatmap_rel_plot(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
    ) -> bytes:
        return create_heatmap_rel_plot(db_name, label=label, channel=channel, degree=degree)

    @classmethod
    def create_hu_separation_overlay(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
        center_ratio: float = 0.15,
        max_to_min_ratio: float = 0.9,
    ) -> bytes:
        return create_hu_separation_overlay(
            db_name,
            label=label,
            channel=channel,
            degree=degree,
            center_ratio=center_ratio,
            max_to_min_ratio=max_to_min_ratio,
        )

    @classmethod
    def create_map256_strip(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
    ) -> bytes:
        return create_map256_strip(db_name, label=label, channel=channel, degree=degree)

    @classmethod
    def create_map256_contour(
        cls,
        db_name: str,
        label: str | None = None,
        channel: str = "fluo1",
        degree: int = 4,
        intensity_mode: Literal["absolute", "relative"] = "absolute",
    ) -> bytes:
        return create_map256_contour(
            db_name,
            label=label,
            channel=channel,
            degree=degree,
            intensity_mode=intensity_mode,
        )

    @classmethod
    def create_contours_grid_plot(
        cls, db_name: str, label: str | None = None
    ) -> bytes:
        return create_contours_grid_plot(db_name, label)

    @classmethod
    def get_contours_grid_json(
        cls, db_name: str, label: str | None = None
    ) -> bytes:
        return get_contours_grid_json(db_name, label)

    @classmethod
    def create_cell_length_boxplot(cls, db_name: str, label: str | None = None) -> bytes:
        return create_cell_length_boxplot(db_name, label)

    @classmethod
    def create_cell_area_boxplot(cls, db_name: str, label: str | None = None) -> bytes:
        return create_cell_area_boxplot(db_name, label)

    @classmethod
    def create_normalized_median_boxplot(
        cls, db_name: str, label: str | None = None, channel: str = "ph"
    ) -> bytes:
        return create_normalized_median_boxplot(db_name, label, channel)

    @classmethod
    def create_fitc_aggregation_ratio_plot(
        cls, db_name: str, label: str | None = None, channel: str = "fluo1"
    ) -> bytes:
        return create_fitc_aggregation_ratio_plot(db_name, label, channel)


def create_cell_area_boxplot(
    db_name: str, label: str | None = None
) -> bytes:
    areas = get_cell_areas_by_label(db_name, label)
    if not areas:
        raise LookupError("No cells found for the specified label.")
    values = [area for _, area in areas]
    label_text = str(label) if label not in (None, "", "all", "All") else "All"
    return _build_boxplot_image(
        data=[values],
        labels=[label_text],
        ylabel="Cell area (px^2)",
        title=f"{db_name} | label {label_text}",
        point_color="#b7791f",
        median_color="#b83280",
        box_color="#4a5568",
    )


def create_normalized_median_boxplot(
    db_name: str, label: str | None = None, channel: str = "ph"
) -> bytes:
    medians = get_normalized_medians_by_label(db_name, label, channel)
    if not medians:
        raise LookupError("No cells found for the specified label.")
    values = [median for _, median in medians]
    label_text = str(label) if label not in (None, "", "all", "All") else "All"
    return _build_boxplot_image(
        data=[values],
        labels=[label_text],
        ylabel="Normalized median intensity",
        title=f"{db_name} | label {label_text} | {channel}",
        point_color="#2b6cb0",
        median_color="#2b6cb0",
        box_color="#2d3748",
    )


def create_fitc_aggregation_ratio_plot(
    db_name: str, label: str | None = None, channel: str = "fluo1"
) -> bytes:
    medians = get_normalized_medians_by_label(db_name, label, channel)
    if not medians:
        raise LookupError("No cells found for the specified label.")
    values = [median for _, median in medians]
    ratio, _count_below, _total = _calc_fraction_below_threshold(
        values, FITC_AGGREGATION_THRESHOLD
    )
    label_text = str(label) if label not in (None, "", "all", "All") else "All"
    return _build_fitc_aggregation_ratio_plot(
        ratio=ratio,
        label_text=label_text,
        title=f"{db_name} | label {label_text} | {channel}",
        threshold=FITC_AGGREGATION_THRESHOLD,
    )


def _build_fitc_aggregation_ratio_plot(
    ratio: float,
    label_text: str,
    title: str,
    threshold: float,
) -> bytes:
    fig, ax = plt.subplots(figsize=(4.6, 4.2), dpi=300)
    ax.bar([0], [ratio], color="#2c7a7b", width=0.25)
    ax.set_xlim(-0.6, 0.6)
    ax.set_ylim(0, 1.1)
    ax.set_xticks([0])
    ax.set_xticklabels([label_text])
    ax.set_ylabel(f"Fraction below {threshold}")
    ax.set_title(title, fontsize=9)
    value_text = f"{ratio:.3g}"
    ax.text(
        0,
        1.05,
        f"FITC aggregation ratio = {value_text}",
        ha="center",
        va="center",
        fontsize=8.5,
        color="#2d3748",
        clip_on=False,
    )
    ax.grid(True, axis="y", alpha=0.3)

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()


def _build_boxplot_image(
    data: Sequence[Sequence[float]],
    labels: Sequence[str],
    ylabel: str,
    title: str,
    point_color: str,
    median_color: str,
    box_color: str,
    xlabel: str | None = None,
) -> bytes:
    if len(data) != len(labels):
        raise ValueError("Data and labels must be the same length.")

    fig, ax = plt.subplots(figsize=(4.6, 4.2), dpi=180)
    ax.boxplot(
        data,
        sym="",
        vert=True,
        widths=0.35,
        patch_artist=False,
        boxprops={"color": box_color, "linewidth": 1.2},
        medianprops={"color": median_color, "linewidth": 1.4},
        whiskerprops={"color": box_color, "linewidth": 1.1},
        capprops={"color": box_color, "linewidth": 1.1},
    )

    rng = np.random.default_rng(0)
    for i, values in enumerate(data, start=1):
        values_arr = np.asarray(values, dtype=float)
        if values_arr.size == 0:
            continue
        x = rng.normal(i, 0.04, size=values_arr.size)
        ax.plot(
            x,
            values_arr,
            "o",
            alpha=0.5,
            color=point_color,
            markersize=4,
            markeredgewidth=0,
        )

    ax.set_xticks([i + 1 for i in range(len(labels))])
    ax.set_xticklabels([str(label) for label in labels])
    if xlabel:
        ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.grid(True)
    ax.set_title(title, fontsize=9)

    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    buf.seek(0)
    return buf.getvalue()
