import io
from dataclasses import dataclass

import matplotlib
matplotlib.use("Agg")
from matplotlib.axes import Axes
from matplotlib.figure import Figure
import matplotlib.pyplot as plt
import numpy as np

from app.shared.objective_scale import DEFAULT_PIXEL_SIZE_UM, normalize_pixel_size_um

PIXEL_SIZE_UM: float = DEFAULT_PIXEL_SIZE_UM
EXPECTED_POINTS_PER_CELL: int = 35
DEFAULT_MODE: str = "HU_aggregation_ratio"


@dataclass
class GraphEngineResult:
    filename: str
    mean_length: float
    nagg_rate: float | None


class GraphEngineCrud:
    SUPPORTED_MODES: set[str] = {DEFAULT_MODE}

    @classmethod
    def normalize_mode(cls, mode: str | None) -> str:
        if not mode:
            return DEFAULT_MODE
        normalized: str = mode.strip()
        if normalized not in cls.SUPPORTED_MODES:
            raise ValueError("Unsupported graph mode")
        return normalized

    @staticmethod
    def _safe_decode(payload: bytes) -> str:
        return payload.decode("utf-8", errors="ignore")

    @staticmethod
    def _data_lines(text: str) -> list[str]:
        lines: list[str] = []
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if line.startswith("\ufeff"):
                line = line.lstrip("\ufeff")
            if not line or line.startswith("#"):
                continue
            lines.append(line)
        return lines

    @staticmethod
    def _extract_pixel_size_um(text: str) -> float:
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if line.startswith("\ufeff"):
                line = line.lstrip("\ufeff")
            if not line.startswith("#"):
                continue
            metadata = line[1:].strip()
            key, sep, value = metadata.partition("=")
            if not sep:
                key, sep, value = metadata.partition(":")
            if sep and key.strip().lower() == "pixel_size_um":
                return normalize_pixel_size_um(value.strip())
        return DEFAULT_PIXEL_SIZE_UM

    @staticmethod
    def _parse_ctrl(text: str) -> float:
        rows: list[list[float]] = [
            [float(x) for x in line.split(',') if x]
            for line in GraphEngineCrud._data_lines(text)
        ]
        normalized_rows: list[list[float]] = []
        for arr in rows:
            if not arr:
                continue
            values: np.ndarray = np.array(arr, dtype=float)
            if values.max() - values.min() != 0:
                values = (values - values.min()) / (values.max() - values.min())
            normalized_rows.append(values.tolist())
        data: list[float] = [
            float(np.sum(row) / len(row)) for row in normalized_rows if row
        ]
        data.sort(reverse=True)
        if not data:
            return 0.0
        index: int = int(len(data) * 0.95)
        return data[index]

    @staticmethod
    def _analyze_csv(text: str, ctrl: float | None) -> tuple[float, float | None]:
        pixel_size_um = GraphEngineCrud._extract_pixel_size_um(text)
        lines = GraphEngineCrud._data_lines(text)
        cells: list[tuple[float, float]] = []
        for i in range(0, len(lines), 2):
            if i + 1 >= len(lines):
                break
            values: list[str] = [
                value.strip() for value in lines[i].split(",") if value.strip()
            ]
            if len([j for j in values if j != ""]) != EXPECTED_POINTS_PER_CELL:
                continue
            if len(values) < 2:
                continue
            try:
                length: float = round(
                    (float(values[-1]) - float(values[0])) * pixel_size_um, 2
                )
            except ValueError:
                continue
            try:
                peak_points: np.ndarray = np.array(
                    [float(x) for x in lines[i + 1].split(',') if x.strip()],
                    dtype=float,
                )
            except ValueError:
                continue
            if peak_points.size == 0:
                continue
            if peak_points.max() - peak_points.min() != 0:
                peak_points = (peak_points - peak_points.min()) / (
                    peak_points.max() - peak_points.min()
                )
            peak_data: float = float(np.sum(peak_points) / len(peak_points))
            cells.append((length, peak_data))
        if not cells:
            return 0.0, None if ctrl is None else 0.0
        mean_length: float = float(np.mean([length for length, _ in cells]))
        if ctrl is None:
            return mean_length, None
        count_below: int = sum(1 for _, peak in cells if peak < ctrl)
        nagg_rate: float = count_below / len(cells)
        return mean_length, nagg_rate

    @classmethod
    def _extract_peak_vectors(cls, text: str) -> list[list[float]]:
        lines = cls._data_lines(text)
        vectors: list[list[float]] = []
        for i in range(0, len(lines), 2):
            if i + 1 >= len(lines):
                break
            values: list[str] = [
                value.strip() for value in lines[i].split(",") if value.strip()
            ]
            if len(values) != EXPECTED_POINTS_PER_CELL:
                continue
            try:
                vector: list[float] = [
                    float(x) for x in lines[i + 1].split(',') if x.strip()
                ]
            except ValueError:
                continue
            if vector:
                vectors.append(vector)
        return vectors

    @staticmethod
    def _parse_numeric_rows(text: str) -> list[list[float]]:
        rows: list[list[float]] = []
        for line in GraphEngineCrud._data_lines(text):
            values: list[str] = [value for value in line.split(',') if value.strip()]
            if not values:
                continue
            try:
                row: list[float] = [float(value) for value in values]
            except ValueError:
                continue
            rows.append(row)
        return rows

    @classmethod
    def _get_matrix_for_mode(cls, mode: str, text: str) -> np.ndarray:
        vectors: list[list[float]] = (
            cls._extract_peak_vectors(text) if mode == DEFAULT_MODE else []
        )
        if not vectors:
            vectors = cls._parse_numeric_rows(text)
        if not vectors:
            raise ValueError("No numeric data found in CSV")
        max_len: int = max(len(row) for row in vectors)
        matrix: np.ndarray = np.full((len(vectors), max_len), np.nan, dtype=float)
        for idx, row in enumerate(vectors):
            matrix[idx, : len(row)] = row
        return matrix

    @staticmethod
    def _normalize_rows(matrix: np.ndarray) -> np.ndarray:
        normalized: np.ndarray = matrix.copy()
        for i in range(normalized.shape[0]):
            row: np.ndarray = normalized[i]
            mask: np.ndarray = ~np.isnan(row)
            if not np.any(mask):
                continue
            row_min: float = float(np.nanmin(row))
            row_max: float = float(np.nanmax(row))
            if row_max - row_min == 0:
                normalized[i, mask] = 0
            else:
                normalized[i, mask] = (row[mask] - row_min) / (row_max - row_min)
        return normalized

    @staticmethod
    def _build_heatmap_image(matrix: np.ndarray, normalize_rows: bool) -> bytes:
        if normalize_rows:
            matrix = GraphEngineCrud._normalize_rows(matrix)
        fig: Figure
        ax: Axes
        fig, ax = plt.subplots(figsize=(3.2, 3.2), dpi=160)
        ax.imshow(matrix, aspect="auto", interpolation="nearest", cmap="viridis")
        ax.axis("off")
        buf: io.BytesIO = io.BytesIO()
        fig.tight_layout(pad=0.1)
        fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()

    @staticmethod
    def _build_distribution_image(values: np.ndarray) -> bytes:
        fig: Figure
        ax: Axes
        fig, ax = plt.subplots(figsize=(3.4, 3.0), dpi=160)
        bins: int = min(40, max(8, int(np.sqrt(values.size))))
        ax.hist(values, bins=bins, color="#2c7a7b", alpha=0.8, edgecolor="white")
        ax.set_xlabel("Value")
        ax.set_ylabel("Count")
        ax.grid(True, axis="y", alpha=0.3)
        buf: io.BytesIO = io.BytesIO()
        fig.tight_layout(pad=0.2)
        fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()

    @staticmethod
    def _build_distribution_box_image(values: list[float]) -> bytes:
        fig: Figure
        ax: Axes
        fig, ax = plt.subplots(figsize=(3.0, 3.2), dpi=160)
        ax.boxplot(
            values,
            sym="",
            vert=True,
            widths=0.4,
            boxprops={"color": "#2d3748", "linewidth": 1.2},
            medianprops={"color": "#2c7a7b", "linewidth": 1.4},
            whiskerprops={"color": "#2d3748", "linewidth": 1.1},
            capprops={"color": "#2d3748", "linewidth": 1.1},
        )
        ax.set_ylabel("Mean value")
        ax.set_xticks([1])
        ax.set_xticklabels(["mean"])
        ax.grid(True, axis="y", alpha=0.3)
        buf: io.BytesIO = io.BytesIO()
        fig.tight_layout(pad=0.2)
        fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()

    @classmethod
    def analyze_files(
        cls,
        mode: str,
        files: list[tuple[str, bytes]],
        ctrl_bytes: bytes | None,
    ) -> list[GraphEngineResult]:
        normalized_mode: str = cls.normalize_mode(mode)
        if normalized_mode != DEFAULT_MODE:
            raise ValueError("Unsupported graph mode")
        ctrl_value: float | None = None
        if ctrl_bytes is not None:
            ctrl_text: str = cls._safe_decode(ctrl_bytes)
            ctrl_value = cls._parse_ctrl(ctrl_text)
        results: list[GraphEngineResult] = []
        for name, content in files:
            text: str = cls._safe_decode(content)
            mean_length: float
            nagg_rate: float | None
            mean_length, nagg_rate = cls._analyze_csv(text, ctrl_value)
            results.append(
                GraphEngineResult(
                    filename=name,
                    mean_length=mean_length,
                    nagg_rate=nagg_rate,
                )
            )
        return results

    @classmethod
    def create_heatmap_abs_plot(cls, mode: str | None, content: bytes) -> bytes:
        normalized_mode: str = cls.normalize_mode(mode)
        matrix: np.ndarray = cls._get_matrix_for_mode(
            normalized_mode, cls._safe_decode(content)
        )
        return cls._build_heatmap_image(matrix, normalize_rows=False)

    @classmethod
    def create_heatmap_rel_plot(cls, mode: str | None, content: bytes) -> bytes:
        normalized_mode: str = cls.normalize_mode(mode)
        matrix: np.ndarray = cls._get_matrix_for_mode(
            normalized_mode, cls._safe_decode(content)
        )
        return cls._build_heatmap_image(matrix, normalize_rows=True)

    @classmethod
    def create_distribution_plot(cls, mode: str | None, content: bytes) -> bytes:
        normalized_mode: str = cls.normalize_mode(mode)
        matrix: np.ndarray = cls._get_matrix_for_mode(
            normalized_mode, cls._safe_decode(content)
        )
        values: np.ndarray = matrix[~np.isnan(matrix)]
        if values.size == 0:
            raise ValueError("No numeric data found in CSV")
        return cls._build_distribution_image(values)

    @classmethod
    def create_distribution_box_plot(cls, mode: str | None, content: bytes) -> bytes:
        normalized_mode: str = cls.normalize_mode(mode)
        matrix: np.ndarray = cls._get_matrix_for_mode(
            normalized_mode, cls._safe_decode(content)
        )
        row_means: list[float] = []
        for row in matrix:
            if np.all(np.isnan(row)):
                continue
            row_means.append(float(np.nanmean(row)))
        if not row_means:
            raise ValueError("No numeric data found in CSV")
        return cls._build_distribution_box_image(row_means)
